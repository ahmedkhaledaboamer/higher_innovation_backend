import { Types } from 'mongoose';
import type { AuthContext } from '../../types/express.js';
import { ApiError } from '../../utils/ApiError.js';
import { teachingCourseIds } from '../assignments/teaching.access.js';
import { Enrollment } from '../enrollments/enrollment.model.js';
import { type Permission, PERMISSIONS } from '../roles/permissions.js';

/**
 * Record-level visibility for students, applied inside every query.
 *
 *   all      – students:read_all (Owner, Admin, Viewer): every student.
 *   advised  – students:read_assigned (Sales): students whose advisor is the caller.
 *   teaching – students:read_teaching (Trainer): students enrolled in a course the caller
 *              teaches (open assignment). These callers also get a reduced view (see dto).
 *
 * Out-of-scope students answer 404. Writes have their own scope: trainers have none.
 */
export type StudentScope = { advisor?: Types.ObjectId };
export type StudentReadAccess = 'all' | 'advised' | 'teaching';

const has = (actor: AuthContext, permission: Permission) => actor.permissions.includes(permission);

/** The widest read access the caller has (403 if none). */
export function studentReadAccess(actor: AuthContext): StudentReadAccess {
  if (has(actor, PERMISSIONS.STUDENTS_READ_ALL)) return 'all';
  if (has(actor, PERMISSIONS.STUDENTS_READ_ASSIGNED)) return 'advised';
  if (has(actor, PERMISSIONS.STUDENTS_READ_TEACHING)) return 'teaching';
  throw ApiError.forbidden();
}

/** MongoDB condition limiting students to the caller's read scope. */
export async function studentReadScope(actor: AuthContext): Promise<Record<string, unknown>> {
  switch (studentReadAccess(actor)) {
    case 'all':
      return {};
    case 'advised':
      return { advisor: new Types.ObjectId(actor.userId) };
    case 'teaching': {
      const courses = await teachingCourseIds(actor.userId);
      const students = courses.length ? await Enrollment.distinct('student', { course: { $in: courses } }) : [];
      return { _id: { $in: students } };
    }
  }
}

export function studentWriteScope(actor: AuthContext): StudentScope {
  if (has(actor, PERMISSIONS.STUDENTS_UPDATE_ALL)) return {};
  if (has(actor, PERMISSIONS.STUDENTS_UPDATE_ASSIGNED)) return { advisor: new Types.ObjectId(actor.userId) };
  throw ApiError.forbidden();
}

export const canAssignAdvisor = (actor: AuthContext) => has(actor, PERMISSIONS.STUDENTS_ASSIGN);
export const canSeeAllStudents = (actor: AuthContext) => has(actor, PERMISSIONS.STUDENTS_READ_ALL);
export const canManageAllStudents = (actor: AuthContext) => has(actor, PERMISSIONS.STUDENTS_UPDATE_ALL);
