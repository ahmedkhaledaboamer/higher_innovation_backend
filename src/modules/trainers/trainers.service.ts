import mongoose, { Types } from 'mongoose';
import { nextSequence } from '../../database/counter.model.js';
import { runInTransaction } from '../../database/mongoose.js';
import type { AuthContext } from '../../types/express.js';
import { ApiError } from '../../utils/ApiError.js';
import { buildPaginationMeta, escapeRegex, type PaginationMeta, toSkip } from '../../utils/pagination.js';
import { TrainerAssignment } from '../assignments/assignment.model.js';
import { endOpenAssignments } from '../assignments/assignments.service.js';
import { USER_REF_FIELDS } from '../leads/lead.dto.js';
import type { RoleKey } from '../roles/permissions.js';
import { User } from '../users/user.model.js';
import { type TrainerDto, type TrainerWithRefs, toTrainerDto } from './trainer.dto.js';
import { Trainer } from './trainer.model.js';
import type { CreateTrainerInput, ListTrainersQuery, UpdateTrainerInput } from './trainers.schema.js';

const CODE_START = 1001;

const trainerNotFound = () => ApiError.notFound('Trainer not found', 'TRAINER_NOT_FOUND');
const trainerArchived = () =>
  ApiError.conflict('This trainer is archived. Restore them before making changes.', 'TRAINER_ARCHIVED');
const emailTaken = () =>
  new ApiError(409, 'A trainer with this email already exists', 'TRAINER_EMAIL_TAKEN', [
    { path: 'email', message: 'Already used by another trainer profile' },
  ]);
const userTaken = () =>
  new ApiError(409, 'This user is already linked to another trainer profile', 'TRAINER_USER_TAKEN', [
    { path: 'userId', message: 'Already linked to another trainer' },
  ]);

async function loadDto(id: unknown): Promise<TrainerDto> {
  const trainer = await Trainer.findById(id)
    .populate('user', USER_REF_FIELDS)
    .populate('createdBy', USER_REF_FIELDS)
    .lean();
  if (!trainer) throw trainerNotFound();
  return toTrainerDto(trainer as unknown as TrainerWithRefs);
}

/** A linked account must exist, not be INACTIVE, and have the TRAINER role (the role whose access the link drives). */
async function validateUser(userId: string): Promise<Types.ObjectId> {
  const user = await User.findById(userId)
    .select('status role')
    .populate<{ role: { key: RoleKey } | null }>('role', 'key')
    .lean();
  const invalid = (message: string, code: string) => ApiError.badRequest(message, code, [{ path: 'userId', message }]);
  if (!user || !user.role) throw invalid('The selected user does not exist', 'USER_NOT_FOUND');
  if (user.status === 'INACTIVE') throw invalid('The selected user is inactive', 'USER_INACTIVE');
  if (user.role.key !== 'TRAINER') throw invalid('Only users with the TRAINER role can be linked to a trainer profile', 'USER_ROLE_NOT_TRAINER');
  return user._id;
}

/** Unique-index violations raised by races, as clear conflicts. */
function uniqueConflict(error: unknown): ApiError | null {
  if (!(error instanceof mongoose.mongo.MongoServerError) || error.code !== 11000) return null;
  const keys = Object.keys((error.keyPattern as Record<string, unknown> | undefined) ?? {});
  if (keys.includes('email')) return emailTaken();
  if (keys.includes('user')) return userTaken();
  return null;
}

async function listFilter(query: ListTrainersQuery): Promise<Record<string, unknown>> {
  const conditions: Array<Record<string, unknown>> = [{ archivedAt: query.archived ? { $ne: null } : null }];
  if (query.status) conditions.push({ status: { $in: query.status } });
  if (query.specialization) {
    conditions.push({ specialization: { $in: query.specialization.map((s) => new RegExp(`^${escapeRegex(s)}$`, 'i')) } });
  }
  if (query.course) {
    const trainerIds = await TrainerAssignment.distinct('trainer', {
      course: { $in: query.course.map((id) => new Types.ObjectId(id)) },
      isOpen: true,
    });
    conditions.push({ _id: { $in: trainerIds } });
  }
  if (query.search) {
    const pattern = new RegExp(escapeRegex(query.search), 'i');
    conditions.push({
      $or: [{ fullName: pattern }, { email: pattern }, { code: pattern }, { title: pattern }, { specialization: pattern }],
    });
  }
  return { $and: conditions };
}

export const trainersService = {
  async list(query: ListTrainersQuery): Promise<{ items: TrainerDto[]; meta: PaginationMeta }> {
    const filter = await listFilter(query);
    const direction = query.sortDir === 'asc' ? 1 : -1;
    const [items, total] = await Promise.all([
      Trainer.find(filter)
        .sort({ [query.sortBy]: direction, _id: direction })
        .collation({ locale: 'en', strength: 2 })
        .skip(toSkip(query))
        .limit(query.limit)
        .populate('user', USER_REF_FIELDS)
        .populate('createdBy', USER_REF_FIELDS)
        .lean(),
      Trainer.countDocuments(filter),
    ]);
    return {
      items: (items as unknown as TrainerWithRefs[]).map(toTrainerDto),
      meta: buildPaginationMeta(query, total),
    };
  },

  async getById(id: string): Promise<TrainerDto> {
    return loadDto(id);
  },

  /** The caller's own trainer profile (users linked to one). */
  async me(actor: AuthContext): Promise<TrainerDto> {
    const trainer = await Trainer.findOne({ user: actor.userId, archivedAt: null }).select('_id').lean();
    if (!trainer) throw ApiError.notFound('No trainer profile is linked to your account', 'TRAINER_PROFILE_NOT_FOUND');
    return loadDto(trainer._id);
  },

  async create(actor: AuthContext, input: CreateTrainerInput): Promise<TrainerDto> {
    if (await Trainer.exists({ email: input.email })) throw emailTaken();
    const { userId, ...fields } = input;
    const user = userId ? await validateUser(userId) : null;
    if (user && (await Trainer.exists({ user }))) throw userTaken();

    try {
      const trainer = await Trainer.create({
        ...fields,
        title: fields.title ?? null,
        specialization: fields.specialization ?? null,
        phone: fields.phone ?? null,
        experienceYears: fields.experienceYears ?? null,
        weeklyCapacityHours: fields.weeklyCapacityHours ?? null,
        joinDate: fields.joinDate ?? null,
        city: fields.city ?? null,
        country: fields.country ?? null,
        code: `TR-${await nextSequence('trainer', CODE_START)}`,
        user,
        createdBy: actor.userId,
      });
      return loadDto(trainer._id);
    } catch (error) {
      throw uniqueConflict(error) ?? error;
    }
  },

  async update(id: string, input: UpdateTrainerInput): Promise<TrainerDto> {
    const trainer = await Trainer.findById(id).lean();
    if (!trainer) throw trainerNotFound();
    if (trainer.archivedAt) throw trainerArchived();

    const { userId, ...fields } = input;
    const set: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) set[key] = value;
    }
    if (fields.email && fields.email !== trainer.email && (await Trainer.exists({ email: fields.email }))) throw emailTaken();
    if (userId !== undefined) {
      const user = userId ? await validateUser(userId) : null;
      if (user && (await Trainer.exists({ user, _id: { $ne: trainer._id } }))) throw userTaken();
      set.user = user;
    }

    try {
      const result = await Trainer.updateOne({ _id: id, archivedAt: null }, { $set: set }, { runValidators: true });
      if (result.matchedCount === 0) throw trainerArchived();
    } catch (error) {
      throw uniqueConflict(error) ?? error;
    }
    return loadDto(id);
  },

  /**
   * Archives the profile and ends (CANCELLED, reason TRAINER_ARCHIVED) all its open assignments
   * in one transaction, so the linked user loses teaching access at once. History is kept.
   */
  async archive(actor: AuthContext, id: string): Promise<TrainerDto> {
    await runInTransaction(async (session) => {
      const result = await Trainer.updateOne(
        { _id: id, archivedAt: null },
        { $set: { archivedAt: new Date(), archivedBy: actor.userId, openAssignments: 0 } },
        { session },
      );
      if (result.matchedCount === 0) {
        if (!(await Trainer.exists({ _id: id }).session(session))) throw trainerNotFound();
        throw ApiError.conflict('This trainer is already archived', 'TRAINER_ALREADY_ARCHIVED');
      }
      await endOpenAssignments({ trainer: id }, 'TRAINER_ARCHIVED', actor.userId, session);
    });
    return loadDto(id);
  },

  /** Restoring does not reopen the ended assignments; assign the trainer again if needed. */
  async restore(id: string): Promise<TrainerDto> {
    const result = await Trainer.updateOne(
      { _id: id, archivedAt: { $ne: null } },
      { $set: { archivedAt: null, archivedBy: null } },
    );
    if (result.matchedCount === 0) {
      if (!(await Trainer.exists({ _id: id }))) throw trainerNotFound();
      throw ApiError.conflict('This trainer is not archived', 'TRAINER_NOT_ARCHIVED');
    }
    return loadDto(id);
  },
};
