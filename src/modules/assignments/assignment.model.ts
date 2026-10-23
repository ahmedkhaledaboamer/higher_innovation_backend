import { type HydratedDocument, type InferSchemaType, model, Schema } from 'mongoose';

/** Frontend `AssignmentRole`: 'Primary Trainer' | 'Assistant Trainer'. */
export const ASSIGNMENT_ROLES = ['PRIMARY', 'ASSISTANT'] as const;
export type AssignmentRole = (typeof ASSIGNMENT_ROLES)[number];

/**
 * Frontend `AssignmentStatus`. SCHEDULED and ACTIVE are "open": they count as the trainer
 * teaching the course (and grant teaching access). COMPLETED and CANCELLED are final and
 * kept as history; assigning the trainer again creates a new assignment.
 */
export const ASSIGNMENT_STATUSES = ['SCHEDULED', 'ACTIVE', 'COMPLETED', 'CANCELLED'] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];
export const OPEN_ASSIGNMENT_STATUSES: readonly AssignmentStatus[] = ['SCHEDULED', 'ACTIVE'];

/** Why an assignment ended. */
export const ASSIGNMENT_END_REASONS = ['MANUAL', 'TRAINER_ARCHIVED', 'COURSE_ARCHIVED'] as const;

/** Trainer >──< Course (blueprint TrainerAssignment). */
const assignmentSchema = new Schema(
  {
    trainer: { type: Schema.Types.ObjectId, ref: 'Trainer', required: true },
    course: { type: Schema.Types.ObjectId, ref: 'Course', required: true },
    role: { type: String, enum: ASSIGNMENT_ROLES, required: true },
    status: { type: String, enum: ASSIGNMENT_STATUSES, required: true },
    /** true while SCHEDULED/ACTIVE. Exists so the unique indexes below can target open assignments. */
    isOpen: { type: Boolean, required: true },
    startDate: { type: Date, default: null },
    endDate: { type: Date, default: null },
    teachingHours: { type: Number, min: 0, max: 10_000, default: null },

    endedAt: { type: Date, default: null },
    endedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    endedReason: { type: String, enum: [...ASSIGNMENT_END_REASONS, null], default: null },
    assignedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

// Database-level rules (history rows with isOpen: false are not constrained):
// a trainer has at most one open assignment per course...
assignmentSchema.index({ trainer: 1, course: 1 }, { unique: true, partialFilterExpression: { isOpen: true } });
// ...and a course has at most one open PRIMARY trainer (frontend: a single primaryTrainerId).
assignmentSchema.index(
  { course: 1 },
  { unique: true, partialFilterExpression: { isOpen: true, role: 'PRIMARY' }, name: 'one_open_primary_per_course' },
);
assignmentSchema.index({ course: 1, isOpen: 1 });
assignmentSchema.index({ trainer: 1, isOpen: 1, createdAt: -1 });

export type AssignmentFields = InferSchemaType<typeof assignmentSchema>;
export type AssignmentDocument = HydratedDocument<AssignmentFields>;

export const TrainerAssignment = model('TrainerAssignment', assignmentSchema);
