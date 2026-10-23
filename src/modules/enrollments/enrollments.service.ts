import mongoose, { Types } from 'mongoose';
import { runInTransaction } from '../../database/mongoose.js';
import type { AuthContext } from '../../types/express.js';
import { ApiError } from '../../utils/ApiError.js';
import { buildPaginationMeta, type PaginationMeta, toSkip } from '../../utils/pagination.js';
import { withScope } from '../../utils/scope.js';
import { Course, ENROLLABLE_COURSE_STATUSES } from '../courses/course.model.js';
import { enrollableCondition } from '../courses/courses.service.js';
import { USER_REF_FIELDS } from '../leads/lead.dto.js';
import { teachingCourseIds } from '../assignments/teaching.access.js';
import { type StudentScope, studentReadAccess, studentWriteScope } from '../students/student.access.js';
import { Student } from '../students/student.model.js';
import {
  type EnrollmentDto,
  type EnrollmentTeachingDto,
  type EnrollmentWithRefs,
  toEnrollmentDto,
  toEnrollmentTeachingDto,
} from './enrollment.dto.js';
import { Enrollment, type EnrollmentStatus } from './enrollment.model.js';
import type { CreateEnrollmentInput, ListEnrollmentsQuery } from './enrollments.schema.js';

/**
 * Enrollments link students to courses. Two counters stay consistent with them, always
 * changed in the same transaction:
 *   course.enrolledCount     – seat accounting (conditional increment: never above `seats`)
 *   student.activeEnrollments – lets archiving a student be a single atomic check
 * Both count every status except WITHDRAWN.
 */

const enrollmentNotFound = () => ApiError.notFound('Enrollment not found', 'ENROLLMENT_NOT_FOUND');

/** Raised inside a transaction to abort it; translated into an ApiError outside. */
class Abort extends Error {
  constructor(readonly reason: 'STUDENT' | 'COURSE' | 'ENROLLMENT') {
    super(reason);
  }
}

const holdsSeat = (status: EnrollmentStatus) => status !== 'WITHDRAWN';

function populate<T extends mongoose.Query<unknown, unknown>>(query: T): T {
  return query
    .populate('student', 'studentNumber fullName')
    .populate('course', 'code name')
    .populate('enrolledBy', USER_REF_FIELDS) as T;
}

async function loadDto(id: unknown): Promise<EnrollmentDto> {
  const enrollment = await populate(Enrollment.findById(id)).lean();
  if (!enrollment) throw enrollmentNotFound();
  return toEnrollmentDto(enrollment as unknown as EnrollmentWithRefs);
}

/**
 * Turns a student scope into an enrollment condition. For callers who see every student this
 * is no condition at all; for advisors it limits enrollments to their students.
 */
async function enrollmentScope(scope: StudentScope): Promise<Record<string, unknown>> {
  if (Object.keys(scope).length === 0) return {};
  const studentIds = await Student.distinct('_id', scope);
  return { student: { $in: studentIds } };
}

/**
 * Enrollments the caller may read. Follows the student for Sales (their advised students) and
 * the course for trainers (courses they teach): a trainer sees a student's enrollment in their
 * own course, not that student's enrollments in other courses.
 */
export async function enrollmentReadScope(actor: AuthContext): Promise<Record<string, unknown>> {
  switch (studentReadAccess(actor)) {
    case 'all':
      return {};
    case 'advised':
      return enrollmentScope({ advisor: new Types.ObjectId(actor.userId) });
    case 'teaching':
      return { course: { $in: await teachingCourseIds(actor.userId) } };
  }
}

/** Explains why a student could not be used: 404 outside the caller's scope, 409 if archived. */
async function studentProblem(studentId: string, scope: StudentScope): Promise<ApiError> {
  const student = await Student.findOne(withScope(scope, [{ _id: studentId }])).lean();
  if (!student) return ApiError.notFound('Student not found', 'STUDENT_NOT_FOUND');
  if (student.archivedAt) {
    return ApiError.conflict('This student is archived. Restore them before making changes.', 'STUDENT_ARCHIVED');
  }
  // Only reachable if the student changed between our checks (e.g. advisor reassigned mid-request).
  return ApiError.conflict('The student was changed by someone else; reload and try again', 'CONFLICT');
}

/** Explains why a course cannot take an enrollment right now. */
async function courseProblem(courseId: string): Promise<ApiError> {
  const course = await Course.findById(courseId).lean();
  const detail = (message: string) => [{ path: 'courseId', message }];
  if (!course) return ApiError.badRequest('The selected course does not exist', 'COURSE_NOT_FOUND', detail('Course not found'));
  if (course.archivedAt) {
    return new ApiError(409, 'This course is archived', 'COURSE_ARCHIVED', detail('Course is archived'));
  }
  if (!ENROLLABLE_COURSE_STATUSES.includes(course.status)) {
    return new ApiError(409, `A ${course.status} course does not accept enrollments`, 'COURSE_NOT_OPEN', detail('Course is not open'));
  }
  return new ApiError(409, 'This course has no seats left', 'COURSE_FULL', detail(`All ${course.seats} seats are taken`));
}

function statusTimestamps(status: EnrollmentStatus, now: Date) {
  return {
    status,
    statusChangedAt: now,
    completedAt: status === 'COMPLETED' ? now : null,
    withdrawnAt: status === 'WITHDRAWN' ? now : null,
  };
}

export const enrollmentsService = {
  /** Trainers (teaching access) receive the reduced EnrollmentTeachingDto. */
  async list(
    actor: AuthContext,
    query: ListEnrollmentsQuery,
  ): Promise<{ items: Array<EnrollmentDto | EnrollmentTeachingDto>; meta: PaginationMeta }> {
    const conditions: Array<Record<string, unknown>> = [];
    if (query.student) conditions.push({ student: { $in: query.student.map((id) => new Types.ObjectId(id)) } });
    if (query.course) conditions.push({ course: { $in: query.course.map((id) => new Types.ObjectId(id)) } });
    if (query.status) conditions.push({ status: { $in: query.status } });
    if (query.enrolledFrom || query.enrolledTo) {
      conditions.push({
        enrolledAt: {
          ...(query.enrolledFrom ? { $gte: query.enrolledFrom } : {}),
          ...(query.enrolledTo ? { $lte: query.enrolledTo } : {}),
        },
      });
    }

    const filter = withScope(await enrollmentReadScope(actor), conditions);
    const direction = query.sortDir === 'asc' ? 1 : -1;
    const [items, total] = await Promise.all([
      populate(
        Enrollment.find(filter)
          .sort({ [query.sortBy]: direction, _id: direction })
          .skip(toSkip(query))
          .limit(query.limit),
      ).lean(),
      Enrollment.countDocuments(filter),
    ]);
    return {
      items: (items as unknown as EnrollmentWithRefs[]).map(
        studentReadAccess(actor) === 'teaching' ? toEnrollmentTeachingDto : toEnrollmentDto,
      ),
      meta: buildPaginationMeta(query, total),
    };
  },

  async getById(actor: AuthContext, id: string): Promise<EnrollmentDto | EnrollmentTeachingDto> {
    const visible = await Enrollment.exists(withScope(await enrollmentReadScope(actor), [{ _id: id }]));
    if (!visible) throw enrollmentNotFound();
    const dto = await loadDto(id);
    if (studentReadAccess(actor) !== 'teaching') return dto;
    const { price: _price, currency: _currency, enrolledBy: _enrolledBy, ...rest } = dto;
    return rest;
  },

  /**
   * Enrolls a student in a course. One transaction: take a seat on the course (only if it is
   * open and has room), count the enrollment on the student (only if visible to the caller and
   * not archived), insert the enrollment (unique per student + course).
   */
  async create(actor: AuthContext, studentId: string, input: CreateEnrollmentInput): Promise<EnrollmentDto> {
    const scope = studentWriteScope(actor);

    // Friendly check first; the unique index is the backstop for concurrent requests.
    const existing = await Enrollment.findOne({ student: studentId, course: input.courseId }).select('_id status').lean();
    if (existing) {
      // Do not reveal enrollments of students outside the caller's scope.
      if (!(await Student.exists(withScope(scope, [{ _id: studentId }])))) throw await studentProblem(studentId, scope);
      throw new ApiError(
        409,
        existing.status === 'WITHDRAWN'
          ? 'This student withdrew from this course before. Change that enrollment\'s status to re-enroll.'
          : 'This student is already enrolled in this course',
        'ENROLLMENT_EXISTS',
        [{ path: 'courseId', message: `Existing enrollment ${existing._id.toString()}` }],
      );
    }

    let enrollmentId: Types.ObjectId;
    try {
      enrollmentId = await runInTransaction(async (session) => {
        const student = await Student.findOneAndUpdate(
          withScope(scope, [{ _id: studentId, archivedAt: null }]),
          { $inc: { activeEnrollments: 1 } },
          { session },
        ).lean();
        if (!student) throw new Abort('STUDENT');

        const course = await Course.findOneAndUpdate(
          { _id: input.courseId, ...enrollableCondition() },
          { $inc: { enrolledCount: 1 } },
          { session },
        ).lean();
        if (!course) throw new Abort('COURSE');

        const [created] = await Enrollment.create(
          [
            {
              student: student._id,
              course: course._id,
              status: 'NOT_STARTED',
              enrolledAt: input.enrolledAt ?? new Date(),
              price: course.price,
              enrolledBy: actor.userId,
            },
          ],
          { session },
        );
        return created!._id;
      });
    } catch (error) {
      if (error instanceof Abort && error.reason === 'STUDENT') throw await studentProblem(studentId, scope);
      if (error instanceof Abort && error.reason === 'COURSE') throw await courseProblem(input.courseId);
      if (error instanceof mongoose.mongo.MongoServerError && error.code === 11000) {
        throw ApiError.conflict('This student is already enrolled in this course', 'ENROLLMENT_EXISTS');
      }
      throw error;
    }
    return loadDto(enrollmentId);
  },

  /**
   * Changes the status. Leaving WITHDRAWN takes a seat again (the course must be open with room);
   * entering WITHDRAWN releases it. Other changes only update the status.
   */
  async updateStatus(actor: AuthContext, id: string, status: EnrollmentStatus): Promise<EnrollmentDto> {
    const scope = studentWriteScope(actor);
    const enrollment = await Enrollment.findOne(withScope(await enrollmentScope(scope), [{ _id: id }])).lean();
    if (!enrollment) throw enrollmentNotFound();
    if (enrollment.status === status) return loadDto(id);

    const studentId = enrollment.student.toString();
    const courseId = enrollment.course.toString();
    const delta = Number(holdsSeat(status)) - Number(holdsSeat(enrollment.status)); // +1, 0 or -1

    try {
      await runInTransaction(async (session) => {
        // The enrollment must still have the status we read; otherwise a concurrent change won.
        const updated = await Enrollment.updateOne(
          { _id: id, status: enrollment.status },
          { $set: statusTimestamps(status, new Date()) },
          { session },
        );
        if (updated.matchedCount === 0) throw new Abort('ENROLLMENT');

        // The student must still be in scope and not archived, also when only the status changes.
        const student = await Student.updateOne(
          withScope(scope, [{ _id: studentId, archivedAt: null }]),
          { $inc: { activeEnrollments: delta } },
          { session },
        );
        if (student.matchedCount === 0) throw new Abort('STUDENT');

        if (delta === 1) {
          const course = await Course.updateOne(
            { _id: courseId, ...enrollableCondition() },
            { $inc: { enrolledCount: 1 } },
            { session },
          );
          if (course.matchedCount === 0) throw new Abort('COURSE');
        } else if (delta === -1) {
          await Course.updateOne({ _id: courseId }, { $inc: { enrolledCount: -1 } }, { session });
        }
      });
    } catch (error) {
      if (error instanceof Abort && error.reason === 'ENROLLMENT') {
        throw ApiError.conflict('The enrollment was changed by someone else; reload and try again', 'CONFLICT');
      }
      if (error instanceof Abort && error.reason === 'STUDENT') throw await studentProblem(studentId, scope);
      if (error instanceof Abort && error.reason === 'COURSE') throw await courseProblem(courseId);
      throw error;
    }
    return loadDto(id);
  },
};
