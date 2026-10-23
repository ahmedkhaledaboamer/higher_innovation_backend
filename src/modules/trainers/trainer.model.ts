import { type HydratedDocument, type InferSchemaType, model, Schema } from 'mongoose';

/** Frontend `TrainerStatus`: 'Active' | 'On Leave' | 'Inactive'. */
export const TRAINER_STATUSES = ['ACTIVE', 'ON_LEAVE', 'INACTIVE'] as const;
export type TrainerStatus = (typeof TRAINER_STATUSES)[number];

/** Trainers in these statuses can receive new assignments and use their teaching access. */
export const WORKING_TRAINER_STATUSES: readonly TrainerStatus[] = ['ACTIVE', 'ON_LEAVE'];

/**
 * A trainer's professional profile (blueprint: Trainer with optional userId).
 *
 * Separate from User on purpose: not every trainer signs in (guest and external instructors),
 * and the profile is business data (specialization, capacity, bio), not authentication.
 * When a trainer does sign in, `user` links the profile to a TRAINER-role account; credentials
 * stay on the User only.
 */
const trainerSchema = new Schema(
  {
    /** Human-readable id, e.g. "TR-1001". */
    code: { type: String, required: true, unique: true },
    fullName: { type: String, required: true, trim: true, maxlength: 120 },
    /** Professional title, e.g. "Lead Data Science Instructor". */
    title: { type: String, trim: true, maxlength: 120, default: null },
    specialization: { type: String, trim: true, maxlength: 120, default: null },
    // One person per profile, so unlike leads/students a unique email is justified.
    email: { type: String, required: true, lowercase: true, trim: true, maxlength: 254 },
    phone: { type: String, trim: true, maxlength: 30, default: null },
    bio: { type: String, trim: true, maxlength: 3000, default: '' },
    status: { type: String, enum: TRAINER_STATUSES, required: true, default: 'ACTIVE' },
    experienceYears: { type: Number, min: 0, max: 70, default: null },
    /** Weekly teaching hours the trainer is contracted for. */
    weeklyCapacityHours: { type: Number, min: 0, max: 80, default: null },
    joinDate: { type: Date, default: null },
    city: { type: String, trim: true, maxlength: 80, default: null },
    country: { type: String, trim: true, maxlength: 80, default: null },

    /** Optional login account (role TRAINER). At most one profile per user. */
    user: { type: Schema.Types.ObjectId, ref: 'User', default: null },

    /**
     * Open (SCHEDULED/ACTIVE) assignments. Maintained in the same transactions as assignments,
     * which also serialises "archive trainer" against "assign trainer".
     */
    openAssignments: { type: Number, required: true, default: 0, min: 0 },

    archivedAt: { type: Date, default: null },
    archivedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

trainerSchema.index({ email: 1 }, { unique: true });
trainerSchema.index({ user: 1 }, { unique: true, partialFilterExpression: { user: { $type: 'objectId' } } });
trainerSchema.index({ archivedAt: 1, status: 1, fullName: 1 });
trainerSchema.index({ archivedAt: 1, createdAt: -1 });

export type TrainerFields = InferSchemaType<typeof trainerSchema>;
export type TrainerDocument = HydratedDocument<TrainerFields>;

export const Trainer = model('Trainer', trainerSchema);
