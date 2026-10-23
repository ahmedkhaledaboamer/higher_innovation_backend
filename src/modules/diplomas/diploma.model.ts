import { type HydratedDocument, type InferSchemaType, model, Schema } from 'mongoose';
import { COURSE_LEVELS } from '../courses/course.model.js';

/** Frontend `DiplomaStatus`: 'Active' | 'Upcoming' | 'Closed'. Archiving is separate (archivedAt). */
export const DIPLOMA_STATUSES = ['UPCOMING', 'ACTIVE', 'CLOSED'] as const;
export type DiplomaStatus = (typeof DIPLOMA_STATUSES)[number];

export const MAX_DIPLOMA_COURSES = 50;

/**
 * A program made of several courses (blueprint: "Diploma contains multiple courses").
 * Diploma >──< Course: `courses` is an ordered list of course references, and the same course
 * may appear in several diplomas. Being in a diploma never enrolls or charges anyone.
 */
const diplomaSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 150 },
    description: { type: String, trim: true, maxlength: 5000, default: '' },
    level: { type: String, enum: COURSE_LEVELS, required: true },
    /** Display label, e.g. "9 months". */
    duration: { type: String, trim: true, maxlength: 80, default: null },
    /** Whole AED (see config/money.ts). Independent of the sum of course prices. */
    price: { type: Number, min: 0, default: null },
    status: { type: String, enum: DIPLOMA_STATUSES, required: true, default: 'UPCOMING' },
    courses: {
      type: [{ type: Schema.Types.ObjectId, ref: 'Course' }],
      default: [],
      validate: {
        validator: (ids: unknown[]) => ids.length <= MAX_DIPLOMA_COURSES,
        message: `A diploma can contain at most ${MAX_DIPLOMA_COURSES} courses`,
      },
    },
    archivedAt: { type: Date, default: null },
    archivedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

// Names are unique ignoring case ("Data Analytics" = "data analytics"), archived ones included.
diplomaSchema.index({ name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });
// "Which diplomas contain this course?" (multikey index).
diplomaSchema.index({ courses: 1 });
diplomaSchema.index({ archivedAt: 1, status: 1, createdAt: -1 });

export type DiplomaFields = InferSchemaType<typeof diplomaSchema>;
export type DiplomaDocument = HydratedDocument<DiplomaFields>;

export const Diploma = model('Diploma', diplomaSchema);
