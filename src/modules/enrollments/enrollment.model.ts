import { type HydratedDocument, type InferSchemaType, model, Schema } from 'mongoose';

/**
 * Frontend `EnrollmentStatus` / `LearningStatus`. WITHDRAWN releases the seat.
 * No transition rules are imposed beyond seat accounting: academic progression,
 * attendance and payment rules belong to later phases.
 */
export const ENROLLMENT_STATUSES = ['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'WITHDRAWN'] as const;
export type EnrollmentStatus = (typeof ENROLLMENT_STATUSES)[number];

/** Student 1 ──< Enrollment >── 1 Course. One document per (student, course), ever. */
const enrollmentSchema = new Schema(
  {
    student: { type: Schema.Types.ObjectId, ref: 'Student', required: true },
    course: { type: Schema.Types.ObjectId, ref: 'Course', required: true },
    status: { type: String, enum: ENROLLMENT_STATUSES, required: true, default: 'NOT_STARTED' },
    enrolledAt: { type: Date, required: true },
    statusChangedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    withdrawnAt: { type: Date, default: null },
    /** Course price when the student enrolled; later price changes do not affect it. */
    price: { type: Number, required: true, min: 0 },
    enrolledBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

// The business rule "a student is enrolled in a course at most once". Re-joining after
// withdrawing changes this document's status instead of creating a second one.
enrollmentSchema.index({ student: 1, course: 1 }, { unique: true });
enrollmentSchema.index({ course: 1, status: 1 }); // course rosters
enrollmentSchema.index({ status: 1, enrolledAt: -1 });
// Reports: enrollments, completions and withdrawals within a date range (Phase 8).
enrollmentSchema.index({ enrolledAt: 1 });
// Not partial: a `$type: date` partial index is not eligible for date-range queries.
enrollmentSchema.index({ completedAt: 1 });
enrollmentSchema.index({ withdrawnAt: 1 });

export type EnrollmentFields = InferSchemaType<typeof enrollmentSchema>;
export type EnrollmentDocument = HydratedDocument<EnrollmentFields>;

export const Enrollment = model('Enrollment', enrollmentSchema);
