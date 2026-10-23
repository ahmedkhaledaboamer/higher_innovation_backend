import type { Types } from 'mongoose';
import type { AuthContext } from '../../types/express.js';
import { withScope } from '../../utils/scope.js';
import { readScope as leadReadScope } from '../leads/lead.access.js';
import { Lead } from '../leads/lead.model.js';
import { PERMISSIONS } from '../roles/permissions.js';
import { studentReadScope } from '../students/student.access.js';
import { Student } from '../students/student.model.js';

/**
 * Cross-type contact warnings (D56): a lead whose email/phone matches an active student, or a student
 * whose email/phone matches an active lead, is still saved; the response carries a warning.
 *
 * - Never blocks, merges, links or changes the other record.
 * - Same-type duplicates are unaffected (they remain 409 under the D37 policy).
 * - Disclosure follows read access: matches are searched only inside the caller's own read scope for
 *   the other type (Sales: their own leads / advised students). A caller without read access to the
 *   other type gets no warning at all, so the warning never reveals records they could not list.
 * - Archived records of the other type are ignored, like the same-type duplicate check.
 * - Computed after the write, outside the transaction, read-only: it cannot weaken the same-type
 *   check or the contact locks.
 */

export type ContactWarningCode = 'CONTACT_MATCHES_STUDENT' | 'CONTACT_MATCHES_LEAD';

export interface ContactWarning {
  code: ContactWarningCode;
  message: string;
  /** Which contact values matched. */
  fields: Array<'email' | 'phone'>;
  /** Matching records the caller is allowed to read (at most 5). */
  matches: Array<{ id: string; reference?: string; studentNumber?: string }>;
}

const MAX_MATCHES = 5;

function contactConditions(email: string | null | undefined, phoneNormalized: string | null) {
  const or: Array<Record<string, unknown>> = [];
  if (email) or.push({ email });
  if (phoneNormalized) or.push({ phoneNormalized });
  return or;
}

function matchedFields(
  rows: Array<{ email?: string | null; phoneNormalized?: string | null }>,
  email: string | null | undefined,
  phoneNormalized: string | null,
): Array<'email' | 'phone'> {
  const fields: Array<'email' | 'phone'> = [];
  if (email && rows.some((row) => row.email === email)) fields.push('email');
  if (phoneNormalized && rows.some((row) => row.phoneNormalized === phoneNormalized)) fields.push('phone');
  return fields;
}

const canReadStudents = (actor: AuthContext) =>
  [PERMISSIONS.STUDENTS_READ_ALL, PERMISSIONS.STUDENTS_READ_ASSIGNED, PERMISSIONS.STUDENTS_READ_TEACHING].some((p) =>
    actor.permissions.includes(p),
  );
const canReadLeads = (actor: AuthContext) =>
  [PERMISSIONS.LEADS_READ_ALL, PERMISSIONS.LEADS_READ_ASSIGNED].some((p) => actor.permissions.includes(p));

/** Warning for a lead write: active students (in the caller's scope) sharing its contact. */
export async function studentMatchWarnings(
  actor: AuthContext,
  email: string | null | undefined,
  phoneNormalized: string | null,
): Promise<ContactWarning[]> {
  const or = contactConditions(email, phoneNormalized);
  if (or.length === 0 || !canReadStudents(actor)) return [];
  const rows = await Student.find(withScope(await studentReadScope(actor), [{ archivedAt: null, $or: or }]))
    .select('studentNumber email phoneNormalized')
    .limit(MAX_MATCHES)
    .lean();
  if (rows.length === 0) return [];
  return [
    {
      code: 'CONTACT_MATCHES_STUDENT',
      message: 'A student with this email or phone already exists. The lead was saved; check whether it is the same person.',
      fields: matchedFields(rows, email, phoneNormalized),
      matches: rows.map((row) => ({ id: row._id.toString(), studentNumber: row.studentNumber })),
    },
  ];
}

/** Warning for a student write: active leads (in the caller's scope) sharing its contact. */
export async function leadMatchWarnings(
  actor: AuthContext,
  email: string | null | undefined,
  phoneNormalized: string | null,
  exceptLeadId?: Types.ObjectId | string,
): Promise<ContactWarning[]> {
  const or = contactConditions(email, phoneNormalized);
  if (or.length === 0 || !canReadLeads(actor)) return [];
  const rows = await Lead.find(
    withScope(leadReadScope(actor), [
      { archivedAt: null, $or: or, ...(exceptLeadId ? { _id: { $ne: exceptLeadId } } : {}) },
    ]),
  )
    .select('reference email phoneNormalized')
    .limit(MAX_MATCHES)
    .lean();
  if (rows.length === 0) return [];
  return [
    {
      code: 'CONTACT_MATCHES_LEAD',
      message: 'A lead with this email or phone already exists. The student was saved; check whether it is the same person.',
      fields: matchedFields(rows, email, phoneNormalized),
      matches: rows.map((row) => ({ id: row._id.toString(), reference: row.reference })),
    },
  ];
}

/** A service result plus non-blocking warnings for the response envelope. */
export interface WithWarnings<T> {
  data: T;
  warnings: ContactWarning[];
}
