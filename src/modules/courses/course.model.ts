import { type HydratedDocument, type InferSchemaType, model, Schema } from 'mongoose';

/**
 * DRAFT    – being prepared; not open for enrollment.
 * UPCOMING – published, starts later; open for enrollment.
 * ACTIVE   – running; open for enrollment.
 * Archiving (archivedAt) replaces the frontend's 'Archived' status, as for leads.
 */
export const COURSE_STATUSES = ['DRAFT', 'UPCOMING', 'ACTIVE'] as const;
export type CourseStatus = (typeof COURSE_STATUSES)[number];

/** Statuses in which a course accepts new enrollments. */
export const ENROLLABLE_COURSE_STATUSES: readonly CourseStatus[] = ['UPCOMING', 'ACTIVE'];

/** The levels used by the frontend's course and diploma data. */
export const COURSE_LEVELS = ['FOUNDATION', 'BEGINNER', 'INTERMEDIATE', 'ADVANCED', 'PROFESSIONAL', 'ALL_LEVELS'] as const;
export type CourseLevel = (typeof COURSE_LEVELS)[number];

const courseSchema = new Schema(
  {
    /** Short catalog code, e.g. "DA-101". Unique forever (also across archived courses). */
    code: { type: String, required: true, unique: true, uppercase: true, trim: true, maxlength: 20 },
    name: { type: String, required: true, trim: true, maxlength: 150 },
    description: { type: String, trim: true, maxlength: 5000, default: '' },
    level: { type: String, enum: COURSE_LEVELS, required: true },
    /** Display label, e.g. "16 weeks · 2 evenings/week". */
    duration: { type: String, trim: true, maxlength: 80, default: null },
    /** Total teaching hours. */
    hours: { type: Number, min: 0, max: 10_000, default: null },
    /** Whole units of the academy's currency (the frontend uses whole numbers, e.g. 18500). */
    price: { type: Number, required: true, min: 0 },
    /** Capacity. null = unlimited. */
    seats: { type: Number, min: 1, max: 10_000, default: null },
    startDate: { type: Date, default: null },
    endDate: { type: Date, default: null },
    status: { type: String, enum: COURSE_STATUSES, required: true, default: 'DRAFT' },

    /**
     * Number of enrollments that hold a seat (every status except WITHDRAWN).
     * Changed only together with enrollments, in the same transaction, using a conditional
     * increment so the course can never be overbooked.
     */
    enrolledCount: { type: Number, required: true, default: 0, min: 0 },

    /**
     * Open (SCHEDULED/ACTIVE) trainer assignments. Maintained in the same transactions as the
     * assignments, which also serialises "archive course" against "assign a trainer".
     */
    openAssignments: { type: Number, required: true, default: 0, min: 0 },

    archivedAt: { type: Date, default: null },
    archivedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

courseSchema.index({ archivedAt: 1, status: 1, startDate: 1 });
courseSchema.index({ archivedAt: 1, createdAt: -1 });

export type CourseFields = InferSchemaType<typeof courseSchema>;
export type CourseDocument = HydratedDocument<CourseFields>;

export const Course = model('Course', courseSchema);
