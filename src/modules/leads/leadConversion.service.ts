import mongoose, { Types } from 'mongoose';
import { nextSequence } from '../../database/counter.model.js';
import { runContactTransaction } from '../../database/contactLock.model.js';
import type { AuthContext } from '../../types/express.js';
import { ApiError } from '../../utils/ApiError.js';
import { normalizePhone } from '../../utils/phone.js';
import { withScope } from '../../utils/scope.js';
import { hasPermission, PERMISSIONS, type RoleKey } from '../roles/permissions.js';
import { studentReadScope } from '../students/student.access.js';
import type { StudentDto } from '../students/student.dto.js';
import { Student } from '../students/student.model.js';
import { leadMatchWarnings, type WithWarnings } from '../contacts/contactWarnings.js';
import { assertNoDuplicateStudent, loadStudentDto, logStudentDuplicateOverride } from '../students/students.service.js';
import { User } from '../users/user.model.js';
import { writeScope } from './lead.access.js';
import type { LeadDto } from './lead.dto.js';
import { Lead } from './lead.model.js';
import type { ConvertLeadInput } from './leads.schema.js';
import { leadsService } from './leads.service.js';

/**
 * Lead → Student conversion (POST /leads/:id/convert).
 *
 * Integrity guarantees:
 * - One transaction claims the lead (status REGISTERED + convertedStudent), takes the next
 *   student number and inserts the student. Any failure rolls all of it back.
 * - The claim is a conditional update that matches only a lead that is in the caller's scope,
 *   not archived and not yet converted. Two concurrent conversions conflict on that document;
 *   the loser retries, no longer matches, and gets LEAD_ALREADY_CONVERTED.
 * - A unique index on student.conversion.lead makes a second student for the same lead
 *   impossible at the database level, whatever the application does.
 */

const STUDENT_NUMBER_START = 1001;

/** Raised inside the transaction to abort it when the lead can no longer be claimed. */
class LeadNotClaimable extends Error {}

const leadNotFound = () => ApiError.notFound('Lead not found', 'LEAD_NOT_FOUND');
const leadArchived = () =>
  ApiError.conflict('This lead is archived. Restore it before converting.', 'LEAD_ARCHIVED');

/** 409 for an already converted lead; names the student only if the caller may see them. */
async function alreadyConverted(actor: AuthContext, studentId: Types.ObjectId | null | undefined): Promise<ApiError> {
  let details: Array<{ path: string; message: string }> | undefined;
  if (studentId) {
    try {
      const student = await Student.findOne(withScope(await studentReadScope(actor), [{ _id: studentId }]))
        .select('studentNumber')
        .lean();
      if (student) details = [{ path: 'id', message: `Converted to student ${student.studentNumber} (${student._id.toString()})` }];
    } catch {
      // No student read permission: say only that it was converted.
    }
  }
  return new ApiError(409, 'This lead has already been converted to a student', 'LEAD_ALREADY_CONVERTED', details);
}

/** Why a lead could not be claimed (re-read after the transaction was aborted). */
async function claimProblem(actor: AuthContext, leadId: string): Promise<ApiError> {
  const lead = await Lead.findOne(withScope(writeScope(actor), [{ _id: leadId }])).lean();
  if (!lead) return leadNotFound();
  if (lead.archivedAt) return leadArchived();
  return alreadyConverted(actor, lead.convertedStudent);
}

/**
 * The student's advisor is the lead's assignee, decided by the server only, provided that user is
 * still active and allowed to advise students. Otherwise the student starts without an advisor.
 */
async function advisorFor(assignedTo: Types.ObjectId | null | undefined): Promise<Types.ObjectId | null> {
  if (!assignedTo) return null;
  const user = await User.findById(assignedTo)
    .select('status role')
    .populate<{ role: { key: RoleKey } | null }>('role', 'key')
    .lean();
  if (!user?.role || user.status !== 'ACTIVE') return null;
  return hasPermission(user.role.key, PERMISSIONS.STUDENTS_UPDATE_ASSIGNED) ? user._id : null;
}

export interface ConversionResult {
  student: StudentDto;
  lead: LeadDto;
}

export async function convertLead(
  actor: AuthContext,
  leadId: string,
  input: ConvertLeadInput,
): Promise<WithWarnings<ConversionResult>> {
  const scope = writeScope(actor);

  // Early, friendly checks. They are repeated atomically inside the transaction.
  const lead = await Lead.findOne(withScope(scope, [{ _id: leadId }])).lean();
  if (!lead) throw leadNotFound();
  if (lead.archivedAt) throw leadArchived();
  if (lead.status === 'REGISTERED' || lead.convertedStudent) throw await alreadyConverted(actor, lead.convertedStudent);

  // Student details: copied from the lead, optionally corrected by the request.
  const pick = <T>(override: T | undefined, fromLead: T) => (override !== undefined ? override : fromLead);
  const profile = {
    fullName: input.fullName ?? lead.fullName,
    email: pick(input.email, lead.email ?? null),
    phone: pick(input.phone, lead.phone ?? null),
    country: pick(input.country, lead.country ?? null),
    city: pick(input.city, lead.city ?? null),
    profession: pick(input.profession, lead.profession ?? null),
    dateOfBirth: input.dateOfBirth ?? null,
  };
  if (!profile.email && !profile.phone) {
    throw ApiError.badRequest('A student needs a phone number or an email address', 'VALIDATION_ERROR', [
      { path: 'phone', message: 'Provide a phone number or an email address' },
    ]);
  }
  // Country-aware (D53), using the student's country (copied from the lead unless corrected).
  const phoneNormalized = normalizePhone(profile.phone, profile.country);

  const advisor = await advisorFor(lead.assignedTo);
  const studentId = new Types.ObjectId();

  try {
    await runContactTransaction(async (session) => {
      const now = new Date();

      const claimed = await Lead.findOneAndUpdate(
        withScope(scope, [{ _id: leadId, archivedAt: null, status: { $ne: 'REGISTERED' }, convertedStudent: null }]),
        {
          $set: {
            status: 'REGISTERED',
            statusChangedAt: now,
            lostReason: null,
            convertedStudent: studentId,
            convertedAt: now,
            convertedBy: actor.userId,
          },
        },
        { session, new: true },
      ).lean();
      if (!claimed) throw new LeadNotClaimable();

      // Claim first: simultaneous conversions of the same lead then fail on the claim
      // (LEAD_ALREADY_CONVERTED) rather than on the contact check.
      // Same duplicate policy as POST /students: never a silent duplicate, never a merge. Checked
      // inside this transaction after taking the contact locks, so a simultaneous conversion or
      // student creation with the same contact cannot both succeed (D37).
      await assertNoDuplicateStudent(session, actor, profile.email, phoneNormalized, input.allowDuplicate);

      const number = await nextSequence('student', STUDENT_NUMBER_START, session);
      await Student.create(
        [
          {
            _id: studentId,
            studentNumber: `ST-${number}`,
            ...profile,
            phoneNormalized,
            status: input.status,
            advisor,
            advisorAssignedAt: advisor ? now : null,
            advisorAssignedBy: advisor ? actor.userId : null,
            createdBy: actor.userId,
            conversion: {
              lead: claimed._id,
              leadReference: claimed.reference,
              source: claimed.source,
              utm: claimed.utm ?? null,
              campaign: claimed.campaign ?? null,
              convertedAt: now,
              convertedBy: actor.userId,
            },
          },
        ],
        { session },
      );
    });
  } catch (error) {
    if (error instanceof LeadNotClaimable) throw await claimProblem(actor, leadId);
    // The database-level guard: a student for this lead already exists.
    if (
      error instanceof mongoose.mongo.MongoServerError &&
      error.code === 11000 &&
      Object.keys((error.keyPattern as Record<string, unknown> | undefined) ?? {}).includes('conversion.lead')
    ) {
      throw await alreadyConverted(actor, (await Student.findOne({ 'conversion.lead': leadId }).lean())?._id);
    }
    throw error;
  }

  if (input.allowDuplicate) logStudentDuplicateOverride(actor, 'convert', studentId);
  return {
    data: {
      student: await loadStudentDto(studentId),
      lead: await leadsService.getById(actor, leadId),
    },
    // Other active leads sharing the new student's contact (the converted lead itself excluded).
    warnings: await leadMatchWarnings(actor, profile.email, phoneNormalized, leadId),
  };
}
