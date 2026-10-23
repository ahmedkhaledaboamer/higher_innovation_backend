import mongoose, { type ClientSession, Types } from 'mongoose';
import { runInTransaction } from '../../database/mongoose.js';
import type { AuthContext } from '../../types/express.js';
import { ApiError } from '../../utils/ApiError.js';
import { buildPaginationMeta, type PaginationMeta, toSkip } from '../../utils/pagination.js';
import { withScope } from '../../utils/scope.js';
import { Course } from '../courses/course.model.js';
import { USER_REF_FIELDS } from '../leads/lead.dto.js';
import { PERMISSIONS } from '../roles/permissions.js';
import { Trainer, WORKING_TRAINER_STATUSES } from '../trainers/trainer.model.js';
import { type AssignmentDto, type AssignmentWithRefs, toAssignmentDto } from './assignment.dto.js';
import { ASSIGNMENT_END_REASONS, TrainerAssignment } from './assignment.model.js';
import type { CreateAssignmentInput, ListAssignmentsQuery, UpdateAssignmentInput } from './assignments.schema.js';
import { trainerProfileOf } from './teaching.access.js';

/**
 * Trainer ↔ Course assignments.
 *
 * Counters `trainer.openAssignments` and `course.openAssignments` change in the same
 * transaction as the assignment, with conditional increments ("trainer not archived and
 * working", "course not archived"). Archiving a trainer or course writes the same document,
 * so the two operations serialise: an assignment can never be left open on an archived record.
 */

type EndReason = (typeof ASSIGNMENT_END_REASONS)[number];

const assignmentNotFound = () => ApiError.notFound('Assignment not found', 'ASSIGNMENT_NOT_FOUND');

class Abort extends Error {
  constructor(readonly reason: 'TRAINER' | 'COURSE' | 'ASSIGNMENT') {
    super(reason);
  }
}

function populate<T extends mongoose.Query<unknown, unknown>>(query: T): T {
  return query
    .populate('trainer', 'code fullName')
    .populate('course', 'code name')
    .populate('assignedBy', USER_REF_FIELDS)
    .populate('endedBy', USER_REF_FIELDS) as T;
}

async function loadDto(id: unknown): Promise<AssignmentDto> {
  const assignment = await populate(TrainerAssignment.findById(id)).lean();
  if (!assignment) throw assignmentNotFound();
  return toAssignmentDto(assignment as unknown as AssignmentWithRefs);
}

/** Assignments the caller may read: all (trainers:read) or their own (trainers:read_own). */
async function readScope(actor: AuthContext): Promise<Record<string, unknown>> {
  if (actor.permissions.includes(PERMISSIONS.TRAINERS_READ)) return {};
  if (actor.permissions.includes(PERMISSIONS.TRAINERS_READ_OWN)) {
    const trainer = await trainerProfileOf(actor.userId);
    return { trainer: trainer?._id ?? new Types.ObjectId() }; // no profile: matches nothing
  }
  throw ApiError.forbidden();
}

async function trainerProblem(trainerId: string): Promise<ApiError> {
  const trainer = await Trainer.findById(trainerId).lean();
  const detail = (message: string) => [{ path: 'trainerId', message }];
  if (!trainer) return ApiError.badRequest('The selected trainer does not exist', 'TRAINER_NOT_FOUND', detail('Trainer not found'));
  if (trainer.archivedAt) return new ApiError(409, 'This trainer is archived', 'TRAINER_ARCHIVED', detail('Trainer is archived'));
  return new ApiError(409, 'An INACTIVE trainer cannot be assigned', 'TRAINER_INACTIVE', detail('Trainer is inactive'));
}

async function courseProblem(courseId: string): Promise<ApiError> {
  const exists = await Course.exists({ _id: courseId });
  const detail = (message: string) => [{ path: 'courseId', message }];
  if (!exists) return ApiError.badRequest('The selected course does not exist', 'COURSE_NOT_FOUND', detail('Course not found'));
  return new ApiError(409, 'This course is archived', 'COURSE_ARCHIVED', detail('Course is archived'));
}

/** Maps the two unique indexes on open assignments to clear conflicts. */
function uniqueConflict(error: unknown): ApiError | null {
  if (!(error instanceof mongoose.mongo.MongoServerError) || error.code !== 11000) return null;
  const keys = Object.keys((error.keyPattern as Record<string, unknown> | undefined) ?? {});
  if (keys.includes('trainer')) {
    return ApiError.conflict('This trainer already has an open assignment to this course', 'ASSIGNMENT_EXISTS');
  }
  return ApiError.conflict('This course already has an open PRIMARY trainer', 'PRIMARY_TRAINER_EXISTS');
}

/**
 * Ends every open assignment of a trainer or a course (used when archiving them), keeping the
 * assignments as CANCELLED history and keeping the counters on the other side in sync.
 * Must run inside the caller's transaction.
 */
export async function endOpenAssignments(
  target: { trainer: Types.ObjectId | string } | { course: Types.ObjectId | string },
  reason: Exclude<EndReason, 'MANUAL'>,
  actorId: string,
  session: ClientSession,
): Promise<number> {
  const open = await TrainerAssignment.find({ ...target, isOpen: true }).session(session).lean();
  if (open.length === 0) return 0;

  const now = new Date();
  await TrainerAssignment.updateMany(
    { _id: { $in: open.map((a) => a._id) } },
    { $set: { status: 'CANCELLED', isOpen: false, endedAt: now, endedBy: actorId, endedReason: reason } },
    { session },
  );
  for (const assignment of open) {
    if ('trainer' in target) {
      await Course.updateOne({ _id: assignment.course }, { $inc: { openAssignments: -1 } }, { session });
    } else {
      await Trainer.updateOne({ _id: assignment.trainer }, { $inc: { openAssignments: -1 } }, { session });
    }
  }
  return open.length;
}

export const assignmentsService = {
  async list(actor: AuthContext, query: ListAssignmentsQuery): Promise<{ items: AssignmentDto[]; meta: PaginationMeta }> {
    const conditions: Array<Record<string, unknown>> = [];
    if (query.trainer) conditions.push({ trainer: { $in: query.trainer.map((id) => new Types.ObjectId(id)) } });
    if (query.course) conditions.push({ course: { $in: query.course.map((id) => new Types.ObjectId(id)) } });
    if (query.status) conditions.push({ status: { $in: query.status } });
    if (query.role) conditions.push({ role: { $in: query.role } });
    if (query.open !== undefined) conditions.push({ isOpen: query.open });

    const filter = withScope(await readScope(actor), conditions);
    const direction = query.sortDir === 'asc' ? 1 : -1;
    const [items, total] = await Promise.all([
      populate(
        TrainerAssignment.find(filter)
          .sort({ [query.sortBy]: direction, _id: direction })
          .skip(toSkip(query))
          .limit(query.limit),
      ).lean(),
      TrainerAssignment.countDocuments(filter),
    ]);
    return {
      items: (items as unknown as AssignmentWithRefs[]).map(toAssignmentDto),
      meta: buildPaginationMeta(query, total),
    };
  },

  async getById(actor: AuthContext, id: string): Promise<AssignmentDto> {
    if (!(await TrainerAssignment.exists(withScope(await readScope(actor), [{ _id: id }])))) throw assignmentNotFound();
    return loadDto(id);
  },

  async create(actor: AuthContext, input: CreateAssignmentInput): Promise<AssignmentDto> {
    let id: Types.ObjectId;
    try {
      id = await runInTransaction(async (session) => {
        const trainer = await Trainer.updateOne(
          { _id: input.trainerId, archivedAt: null, status: { $in: WORKING_TRAINER_STATUSES } },
          { $inc: { openAssignments: 1 } },
          { session },
        );
        if (trainer.matchedCount === 0) throw new Abort('TRAINER');

        const course = await Course.updateOne(
          { _id: input.courseId, archivedAt: null },
          { $inc: { openAssignments: 1 } },
          { session },
        );
        if (course.matchedCount === 0) throw new Abort('COURSE');

        const [created] = await TrainerAssignment.create(
          [
            {
              trainer: input.trainerId,
              course: input.courseId,
              role: input.role,
              status: input.status,
              isOpen: true,
              startDate: input.startDate ?? null,
              endDate: input.endDate ?? null,
              teachingHours: input.teachingHours ?? null,
              assignedBy: actor.userId,
            },
          ],
          { session },
        );
        return created!._id;
      });
    } catch (error) {
      if (error instanceof Abort && error.reason === 'TRAINER') throw await trainerProblem(input.trainerId);
      if (error instanceof Abort && error.reason === 'COURSE') throw await courseProblem(input.courseId);
      throw uniqueConflict(error) ?? error;
    }
    return loadDto(id);
  },

  async update(id: string, input: UpdateAssignmentInput): Promise<AssignmentDto> {
    const assignment = await TrainerAssignment.findById(id).lean();
    if (!assignment) throw assignmentNotFound();
    if (!assignment.isOpen) {
      throw ApiError.conflict('This assignment has ended and is kept as history; create a new one', 'ASSIGNMENT_ENDED');
    }

    const startDate = input.startDate !== undefined ? input.startDate : assignment.startDate;
    const endDate = input.endDate !== undefined ? input.endDate : assignment.endDate;
    if (startDate && endDate && endDate < startDate) {
      throw ApiError.badRequest('endDate cannot be before startDate', 'VALIDATION_ERROR', [
        { path: 'endDate', message: 'endDate cannot be before startDate' },
      ]);
    }

    const set: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      if (value !== undefined) set[key] = value;
    }
    try {
      const result = await TrainerAssignment.updateOne({ _id: id, isOpen: true }, { $set: set }, { runValidators: true });
      if (result.matchedCount === 0) throw ApiError.conflict('This assignment has ended', 'ASSIGNMENT_ENDED');
    } catch (error) {
      throw uniqueConflict(error) ?? error;
    }
    return loadDto(id);
  },

  /** Ends an open assignment (COMPLETED or CANCELLED). Final; the record is kept as history. */
  async end(actor: AuthContext, id: string, status: 'COMPLETED' | 'CANCELLED'): Promise<AssignmentDto> {
    const assignment = await TrainerAssignment.findById(id).lean();
    if (!assignment) throw assignmentNotFound();

    try {
      await runInTransaction(async (session) => {
        const ended = await TrainerAssignment.updateOne(
          { _id: id, isOpen: true },
          { $set: { status, isOpen: false, endedAt: new Date(), endedBy: actor.userId, endedReason: 'MANUAL' } },
          { session },
        );
        if (ended.matchedCount === 0) throw new Abort('ASSIGNMENT');
        await Trainer.updateOne({ _id: assignment.trainer }, { $inc: { openAssignments: -1 } }, { session });
        await Course.updateOne({ _id: assignment.course }, { $inc: { openAssignments: -1 } }, { session });
      });
    } catch (error) {
      if (error instanceof Abort) throw ApiError.conflict('This assignment has already ended', 'ASSIGNMENT_ENDED');
      throw error;
    }
    return loadDto(id);
  },
};
