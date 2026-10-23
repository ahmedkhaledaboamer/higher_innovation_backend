import type { Types } from 'mongoose';
import { Trainer, WORKING_TRAINER_STATUSES } from '../trainers/trainer.model.js';
import { TrainerAssignment } from './assignment.model.js';

/**
 * Teaching scope for users linked to a trainer profile (role TRAINER).
 *
 * A trainer "teaches" a course while they have an open (SCHEDULED/ACTIVE) assignment to it and
 * their profile is not archived or INACTIVE. Archiving a course or a trainer ends the open
 * assignments, so this never includes archived courses.
 *
 * Computed on every request from the database, so ending an assignment removes access immediately.
 */
export async function trainerProfileOf(userId: string) {
  return Trainer.findOne({ user: userId, archivedAt: null }).lean();
}

export async function teachingCourseIds(userId: string): Promise<Types.ObjectId[]> {
  const trainer = await Trainer.findOne({
    user: userId,
    archivedAt: null,
    status: { $in: WORKING_TRAINER_STATUSES },
  })
    .select('_id')
    .lean();
  if (!trainer) return [];
  return TrainerAssignment.distinct('course', { trainer: trainer._id, isOpen: true });
}
