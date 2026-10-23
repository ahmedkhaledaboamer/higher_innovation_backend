import { type ClientSession, Types } from 'mongoose';
import { lockContacts, runContactTransaction } from '../../database/contactLock.model.js';
import { nextSequence } from '../../database/counter.model.js';
import type { AuthContext } from '../../types/express.js';
import { ApiError, type ErrorDetail } from '../../utils/ApiError.js';
import { buildPaginationMeta, escapeRegex, type PaginationMeta, toSkip } from '../../utils/pagination.js';
import { logger } from '../../utils/logger.js';
import { normalizePhone } from '../../utils/phone.js';
import { leadMatchWarnings, type WithWarnings } from '../contacts/contactWarnings.js';
import { withScope } from '../../utils/scope.js';
import { Enrollment } from '../enrollments/enrollment.model.js';
import { CAMPAIGN_REF_FIELDS } from '../campaigns/campaign.ref.js';
import { USER_REF_FIELDS } from '../leads/lead.dto.js';
import { hasPermission, PERMISSIONS, type RoleKey } from '../roles/permissions.js';
import { User } from '../users/user.model.js';
import {
  canAssignAdvisor,
  canManageAllStudents,
  canSeeAllStudents,
  studentReadAccess,
  studentReadScope,
  studentWriteScope,
} from './student.access.js';
import { type StudentDto, type StudentTeachingDto, type StudentWithRefs, toStudentDto, toStudentTeachingDto } from './student.dto.js';
import { Student } from './student.model.js';
import type { CreateStudentInput, ListStudentsQuery, UpdateStudentInput } from './students.schema.js';

const NUMBER_START = 1001;

const studentNotFound = () => ApiError.notFound('Student not found', 'STUDENT_NOT_FOUND');
const studentArchived = () =>
  ApiError.conflict('This student is archived. Restore them before making changes.', 'STUDENT_ARCHIVED');

/** Loads a student DTO without a visibility check. Internal use, e.g. right after lead conversion. */
export async function loadStudentDto(id: unknown): Promise<StudentDto> {
  return loadDto(id);
}

async function loadDto(id: unknown): Promise<StudentDto> {
  const student = await Student.findById(id)
    .populate('advisor', USER_REF_FIELDS)
    .populate('createdBy', USER_REF_FIELDS)
    .populate('conversion.convertedBy', USER_REF_FIELDS)
    .populate('conversion.campaign', CAMPAIGN_REF_FIELDS)
    .lean();
  if (!student) throw studentNotFound();
  return toStudentDto(student as unknown as StudentWithRefs);
}

/** The advisor must exist, be active, and hold a role that works with assigned students. */
async function validateAdvisor(userId: string): Promise<Types.ObjectId> {
  const user = await User.findById(userId)
    .select('status role')
    .populate<{ role: { key: RoleKey } | null }>('role', 'key')
    .lean();
  const invalid = (message: string, code: string) => ApiError.badRequest(message, code, [{ path: 'advisor', message }]);

  if (!user || !user.role) throw invalid('The selected user does not exist', 'ADVISOR_NOT_FOUND');
  if (user.status !== 'ACTIVE') throw invalid('The selected user is not active', 'ADVISOR_INACTIVE');
  if (!hasPermission(user.role.key, PERMISSIONS.STUDENTS_UPDATE_ASSIGNED)) {
    throw invalid('Advisors must be Sales, Admin or Owner users', 'ADVISOR_ROLE_NOT_ALLOWED');
  }
  return user._id;
}

async function findDuplicates(
  email: string | null | undefined,
  phoneNormalized: string | null,
  exceptId?: Types.ObjectId,
  session?: ClientSession,
) {
  const matches: Array<Record<string, unknown>> = [];
  if (email) matches.push({ email });
  if (phoneNormalized) matches.push({ phoneNormalized });
  if (matches.length === 0) return [];
  return Student.find({ archivedAt: null, $or: matches, ...(exceptId ? { _id: { $ne: exceptId } } : {}) })
    .select('studentNumber email phoneNormalized')
    .limit(5)
    .session(session ?? null)
    .lean();
}

function duplicateError(
  actor: AuthContext,
  duplicates: Awaited<ReturnType<typeof findDuplicates>>,
  email: string | null | undefined,
  phoneNormalized: string | null,
  action: 'write' | 'restore' = 'write',
): ApiError {
  const emailMatch = (m: { email?: string | null }) => Boolean(email) && m.email === email;
  // Only callers who can see every student learn which student matched.
  const details: ErrorDetail[] = canSeeAllStudents(actor)
    ? duplicates.map((m) => ({ path: emailMatch(m) ? 'email' : 'phone', message: `Matches student ${m.studentNumber}` }))
    : [
        ...(duplicates.some(emailMatch) ? [{ path: 'email', message: 'Already used by another student' }] : []),
        ...(duplicates.some((m) => phoneNormalized && m.phoneNormalized === phoneNormalized)
          ? [{ path: 'phone', message: 'Already used by another student' }]
          : []),
      ];
  const message =
    action === 'restore'
      ? 'This student cannot be restored: an active student already has this email or phone'
      : 'A student with this email or phone already exists';
  return new ApiError(409, message, 'DUPLICATE_STUDENT', details);
}

/**
 * Records that a manager kept a duplicate contact on purpose. Uses the application log (there is
 * no separate audit store); ids only, no contact data.
 */
export function logStudentDuplicateOverride(
  actor: AuthContext,
  action: 'create' | 'update' | 'convert',
  studentId: Types.ObjectId | string,
): void {
  logger.info(
    { event: 'duplicate_contact_allowed', entity: 'student', action, actorId: actor.userId, recordId: String(studentId) },
    'Duplicate contact kept by manager',
  );
}

/**
 * The student duplicate policy, shared by POST /students and lead conversion:
 * an active student with the same email or normalised phone is a 409 DUPLICATE_STUDENT,
 * unless a students:update_all holder explicitly sets allowDuplicate (e.g. siblings sharing
 * a parent's phone). Never merges records.
 *
 * Must run inside the transaction that then writes the student (`session`): it first takes the
 * contact locks, so a concurrent request with the same contact is retried and then sees this
 * student (D37). allowDuplicate still takes the locks: it is serialised, not blocked.
 */
export async function assertNoDuplicateStudent(
  session: ClientSession,
  actor: AuthContext,
  email: string | null | undefined,
  phoneNormalized: string | null,
  allowDuplicate: boolean,
): Promise<void> {
  if (allowDuplicate && !canManageAllStudents(actor)) {
    throw ApiError.forbidden('Only student managers can create duplicate students', 'FORBIDDEN_FIELD');
  }
  await lockContacts(session, 'student', email, phoneNormalized);
  if (allowDuplicate) return;
  const duplicates = await findDuplicates(email, phoneNormalized, undefined, session);
  if (duplicates.length > 0) throw duplicateError(actor, duplicates, email, phoneNormalized);
}

async function listConditions(query: ListStudentsQuery): Promise<Array<Record<string, unknown>>> {
  const conditions: Array<Record<string, unknown>> = [{ archivedAt: query.archived ? { $ne: null } : null }];

  if (query.status) conditions.push({ status: { $in: query.status } });
  if (query.country) {
    conditions.push({ country: { $in: query.country.map((c) => new RegExp(`^${escapeRegex(c)}$`, 'i')) } });
  }
  if (query.advisor) {
    const ids = query.advisor.filter((value) => value !== 'unassigned').map((id) => new Types.ObjectId(id));
    const options: Array<Record<string, unknown>> = [];
    if (ids.length > 0) options.push({ advisor: { $in: ids } });
    if (query.advisor.includes('unassigned')) options.push({ advisor: null });
    conditions.push({ $or: options });
  }
  if (query.course) {
    const studentIds = await Enrollment.distinct('student', {
      course: { $in: query.course.map((id) => new Types.ObjectId(id)) },
      status: { $ne: 'WITHDRAWN' },
    });
    conditions.push({ _id: { $in: studentIds } });
  }
  if (query.createdFrom || query.createdTo) {
    conditions.push({
      createdAt: {
        ...(query.createdFrom ? { $gte: query.createdFrom } : {}),
        ...(query.createdTo ? { $lte: query.createdTo } : {}),
      },
    });
  }
  if (query.search) {
    const pattern = new RegExp(escapeRegex(query.search), 'i');
    const options: Array<Record<string, unknown>> = [{ fullName: pattern }, { email: pattern }, { studentNumber: pattern }];
    const digits = query.search.replace(/\D/g, '');
    if (digits.length >= 3) options.push({ phoneNormalized: new RegExp(escapeRegex(digits)) });
    // A local search such as "050 123…" also finds numbers stored as +97150123… (D53).
    if (digits.length >= 4 && /^0[1-9]/.test(digits)) {
      options.push({ phoneNormalized: new RegExp(escapeRegex(digits.slice(1))) });
    }
    conditions.push({ $or: options });
  }
  return conditions;
}

export const studentsService = {
  /** Trainers (teaching access) receive the reduced StudentTeachingDto. */
  async list(
    actor: AuthContext,
    query: ListStudentsQuery,
  ): Promise<{ items: Array<StudentDto | StudentTeachingDto>; meta: PaginationMeta }> {
    const filter = withScope(await studentReadScope(actor), await listConditions(query));
    const direction = query.sortDir === 'asc' ? 1 : -1;
    const [items, total] = await Promise.all([
      Student.find(filter)
        .sort({ [query.sortBy]: direction, _id: direction })
        .collation({ locale: 'en', strength: 2 })
        .skip(toSkip(query))
        .limit(query.limit)
        .populate('advisor', USER_REF_FIELDS)
        .populate('createdBy', USER_REF_FIELDS)
    .populate('conversion.convertedBy', USER_REF_FIELDS)
    .populate('conversion.campaign', CAMPAIGN_REF_FIELDS)
        .lean(),
      Student.countDocuments(filter),
    ]);
    return {
      items: (items as unknown as StudentWithRefs[]).map(
        studentReadAccess(actor) === 'teaching' ? toStudentTeachingDto : toStudentDto,
      ),
      meta: buildPaginationMeta(query, total),
    };
  },

  async getById(actor: AuthContext, id: string): Promise<StudentDto | StudentTeachingDto> {
    // Out-of-scope students are reported as not found, so ids cannot be probed.
    if (!(await Student.exists(withScope(await studentReadScope(actor), [{ _id: id }])))) throw studentNotFound();
    const dto = await loadDto(id);
    if (studentReadAccess(actor) !== 'teaching') return dto;
    const { id: sid, studentNumber, fullName, email, status } = dto;
    return { id: sid, studentNumber, fullName, email, status };
  },

  async create(actor: AuthContext, input: CreateStudentInput): Promise<WithWarnings<StudentDto>> {
    // Advisor: chosen only by students:assign holders; Sales users advise the students they create.
    let advisor: Types.ObjectId | null = null;
    if (input.advisor !== undefined) {
      if (!canAssignAdvisor(actor)) throw ApiError.forbidden('You are not allowed to assign advisors', 'FORBIDDEN_FIELD');
      advisor = input.advisor ? await validateAdvisor(input.advisor) : null;
    } else if (!canSeeAllStudents(actor)) {
      advisor = new Types.ObjectId(actor.userId);
    }

    // Country-aware (D53): a leading-0 number becomes +971… only when the country is the UAE.
    const phoneNormalized = normalizePhone(input.phone, input.country);
    const now = new Date();
    // Drawn outside the transaction so concurrent creates do not contend on the counter (gaps are fine).
    const studentNumber = `ST-${await nextSequence('student', NUMBER_START)}`;

    // Lock, check and insert in one transaction (D37; see database/contactLock.model.ts).
    const studentId = await runContactTransaction(async (session) => {
      await assertNoDuplicateStudent(session, actor, input.email, phoneNormalized, input.allowDuplicate);
      const [student] = await Student.create(
        [
          {
            studentNumber,
            fullName: input.fullName,
            email: input.email ?? null,
            phone: input.phone ?? null,
            phoneNormalized,
            country: input.country ?? null,
            city: input.city ?? null,
            profession: input.profession ?? null,
            dateOfBirth: input.dateOfBirth ?? null,
            status: input.status,
            advisor,
            advisorAssignedAt: advisor ? now : null,
            advisorAssignedBy: advisor ? actor.userId : null,
            createdBy: actor.userId,
          },
        ],
        { session },
      );
      return student!._id;
    });
    if (input.allowDuplicate) logStudentDuplicateOverride(actor, 'create', studentId);
    return {
      data: await loadDto(studentId),
      warnings: await leadMatchWarnings(actor, input.email, phoneNormalized),
    };
  },

  async update(actor: AuthContext, id: string, input: UpdateStudentInput): Promise<WithWarnings<StudentDto>> {
    // D55: only student managers (students:update_all = Owner, Admin) may keep a duplicate contact on edit.
    if (input.allowDuplicate && !canManageAllStudents(actor)) {
      throw ApiError.forbidden('Only student managers can keep a duplicate contact', 'FORBIDDEN_FIELD');
    }
    const student = await Student.findOne(withScope(studentWriteScope(actor), [{ _id: id }])).lean();
    if (!student) throw studentNotFound();
    if (student.archivedAt) throw studentArchived();

    const email = input.email !== undefined ? input.email : student.email;
    const phone = input.phone !== undefined ? input.phone : student.phone;
    if (!email && !phone) {
      throw ApiError.badRequest('A student needs a phone number or an email address', 'VALIDATION_ERROR', [
        { path: 'phone', message: 'Provide a phone number or an email address' },
      ]);
    }

    const { allowDuplicate, ...fields } = input;
    const set: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) set[key] = value;
    }
    // The canonical phone depends on the phone and the country (D53): recompute when either changes.
    const country = input.country !== undefined ? input.country : student.country;
    const recompute = input.phone !== undefined || input.country !== undefined;
    const phoneNormalized = recompute ? normalizePhone(phone, country) : (student.phoneNormalized ?? null);
    if (recompute) set.phoneNormalized = phoneNormalized;

    const emailChanged = input.email !== undefined && input.email !== student.email;
    const phoneChanged = recompute && phoneNormalized !== (student.phoneNormalized ?? null);
    // Scope and archive state re-checked in the write itself.
    const write = async (session?: ClientSession) => {
      const result = await Student.updateOne(
        withScope(studentWriteScope(actor), [{ _id: id, archivedAt: null }]),
        { $set: set },
        { runValidators: true, session },
      );
      if (result.matchedCount === 0) throw studentNotFound();
    };

    if (emailChanged || phoneChanged) {
      // Lock, check and write the new contact values in one transaction (D37).
      const newEmail = emailChanged ? email : null;
      const newPhone = phoneChanged ? phoneNormalized : null;
      // An authorised allowDuplicate skips only the same-type duplicate check, never the locks.
      await runContactTransaction(async (session) => {
        await lockContacts(session, 'student', newEmail, newPhone);
        if (!allowDuplicate) {
          const duplicates = await findDuplicates(newEmail, newPhone, student._id, session);
          if (duplicates.length > 0) throw duplicateError(actor, duplicates, email, phoneNormalized);
        }
        await write(session);
      });
      if (allowDuplicate) logStudentDuplicateOverride(actor, 'update', student._id);
      return { data: await loadDto(id), warnings: await leadMatchWarnings(actor, newEmail, newPhone) };
    }
    await write();
    return { data: await loadDto(id), warnings: [] };
  },

  async assignAdvisor(actor: AuthContext, id: string, advisorId: string | null): Promise<StudentDto> {
    const student = await Student.findOne(withScope(await studentReadScope(actor), [{ _id: id }])).lean();
    if (!student) throw studentNotFound();
    if (student.archivedAt) throw studentArchived();

    const advisor = advisorId ? await validateAdvisor(advisorId) : null;
    if (String(student.advisor ?? '') === String(advisor ?? '')) return loadDto(id);

    await Student.updateOne(
      { _id: id, archivedAt: null },
      { $set: { advisor, advisorAssignedAt: advisor ? new Date() : null, advisorAssignedBy: actor.userId } },
    );
    return loadDto(id);
  },

  /** Only students without active enrollments can be archived: withdraw them first. */
  async archive(actor: AuthContext, id: string): Promise<StudentDto> {
    const result = await Student.updateOne(
      withScope(await studentReadScope(actor), [{ _id: id, archivedAt: null, activeEnrollments: 0 }]),
      { $set: { archivedAt: new Date(), archivedBy: actor.userId } },
    );
    if (result.matchedCount === 0) {
      const student = await Student.findOne(withScope(await studentReadScope(actor), [{ _id: id }])).lean();
      if (!student) throw studentNotFound();
      if (student.archivedAt) throw ApiError.conflict('This student is already archived', 'STUDENT_ALREADY_ARCHIVED');
      throw ApiError.conflict(
        `This student has ${student.activeEnrollments} active enrollment(s). Withdraw them before archiving.`,
        'STUDENT_HAS_ACTIVE_ENROLLMENTS',
      );
    }
    return loadDto(id);
  },

  /**
   * Restoring brings a student back into the active set, so it must not duplicate an active
   * student's contact (D54): lock, check and write in one transaction. On a conflict nothing changes
   * (the student stays archived) and the answer is 409 DUPLICATE_STUDENT.
   */
  async restore(actor: AuthContext, id: string): Promise<StudentDto> {
    const scope = await studentReadScope(actor);
    const student = await Student.findOne(withScope(scope, [{ _id: id }]))
      .select('email phoneNormalized archivedAt')
      .lean();
    if (!student) throw studentNotFound();
    if (!student.archivedAt) throw ApiError.conflict('This student is not archived', 'STUDENT_NOT_ARCHIVED');

    const email = student.email ?? null;
    const phoneNormalized = student.phoneNormalized ?? null;
    await runContactTransaction(async (session) => {
      await lockContacts(session, 'student', email, phoneNormalized);
      const duplicates = await findDuplicates(email, phoneNormalized, student._id, session);
      if (duplicates.length > 0) throw duplicateError(actor, duplicates, email, phoneNormalized, 'restore');
      const result = await Student.updateOne(
        withScope(scope, [{ _id: id, archivedAt: { $ne: null } }]),
        { $set: { archivedAt: null, archivedBy: null } },
        { session },
      );
      // Restored by a concurrent request in the meantime.
      if (result.matchedCount === 0) throw ApiError.conflict('This student is not archived', 'STUDENT_NOT_ARCHIVED');
    });
    return loadDto(id);
  },
};
