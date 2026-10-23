import { TrainerAssignment } from '../modules/assignments/assignment.model.js';
import { ActionToken } from '../modules/auth/actionToken.model.js';
import { Campaign } from '../modules/campaigns/campaign.model.js';
import { Course } from '../modules/courses/course.model.js';
import { Diploma } from '../modules/diplomas/diploma.model.js';
import { Enrollment } from '../modules/enrollments/enrollment.model.js';
import { Lead } from '../modules/leads/lead.model.js';
import { LeadNote } from '../modules/leads/leadNote.model.js';
import { RefreshToken } from '../modules/auth/refreshToken.model.js';
import { ROLE_DEFINITIONS } from '../modules/roles/permissions.js';
import { Role } from '../modules/roles/role.model.js';
import { Student } from '../modules/students/student.model.js';
import { Trainer } from '../modules/trainers/trainer.model.js';
import { User } from '../modules/users/user.model.js';
import { hashPassword } from '../utils/password.js';
import { ContactLock } from './contactLock.model.js';
import { Counter } from './counter.model.js';

/** Every model; add new ones here so their indexes are created by `db:indexes` / `db:seed`. */
export const ALL_MODELS = [Role, User, RefreshToken, ActionToken, Counter, ContactLock, Lead, LeadNote, Course, Student, Enrollment, Trainer, TrainerAssignment, Diploma, Campaign] as const;

/**
 * Makes the indexes in MongoDB match the schemas (creates missing ones, drops ones
 * no longer declared). Development builds indexes automatically; production does not,
 * so run this on deploy.
 */
export async function syncAllIndexes(): Promise<string[]> {
  for (const model of ALL_MODELS) {
    await model.syncIndexes();
  }
  return ALL_MODELS.map((model) => model.collection.collectionName);
}

/** Creates the seven system roles, or refreshes their name/description/level. Safe to run repeatedly. */
export async function seedRoles(): Promise<void> {
  await Role.bulkWrite(
    Object.values(ROLE_DEFINITIONS).map((definition) => ({
      updateOne: {
        filter: { key: definition.key },
        update: {
          $set: { name: definition.name, description: definition.description, level: definition.level, isSystem: true },
        },
        upsert: true,
      },
    })),
  );
}

export interface OwnerInput {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
}

export type SeedOwnerResult = { created: true; email: string } | { created: false; reason: 'OWNER_EXISTS' };

/**
 * Creates the initial Owner, the only way an Owner account can come into existence.
 * Never modifies an existing account: if an Owner exists it does nothing, and if the
 * email belongs to a non-Owner user it refuses rather than silently promoting them.
 */
export async function seedOwner(input: OwnerInput): Promise<SeedOwnerResult> {
  const ownerRole = await Role.findOne({ key: 'OWNER' }).lean();
  if (!ownerRole) throw new Error('OWNER role is missing; run seedRoles() first');

  if (await User.exists({ role: ownerRole._id })) return { created: false, reason: 'OWNER_EXISTS' };

  if (await User.exists({ email: input.email })) {
    throw new Error(
      `A non-Owner user with email ${input.email} already exists. Choose another SEED_OWNER_EMAIL; existing accounts are never promoted automatically.`,
    );
  }

  await User.create({
    firstName: input.firstName,
    lastName: input.lastName,
    email: input.email,
    passwordHash: await hashPassword(input.password),
    passwordChangedAt: new Date(),
    role: ownerRole._id,
    status: 'ACTIVE',
  });
  return { created: true, email: input.email };
}

export async function ownerExists(): Promise<boolean> {
  const ownerRole = await Role.findOne({ key: 'OWNER' }).lean();
  return ownerRole ? Boolean(await User.exists({ role: ownerRole._id })) : false;
}
