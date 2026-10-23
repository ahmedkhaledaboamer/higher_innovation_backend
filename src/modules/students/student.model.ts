import { type HydratedDocument, type InferSchemaType, model, Schema } from 'mongoose';
import { LEAD_SOURCES, utmSchema } from '../leads/lead.model.js';

/** Frontend `StudentStatus`: 'Active' | 'Pending' | 'Graduated' | 'Inactive'. Set by staff; no automatic transitions. */
export const STUDENT_STATUSES = ['ACTIVE', 'PENDING', 'GRADUATED', 'INACTIVE'] as const;
export type StudentStatus = (typeof STUDENT_STATUSES)[number];

/**
 * Where a converted student came from. Written only by lead conversion (POST /leads/:id/convert),
 * never by the student endpoints. Students created directly have no conversion block.
 */
const conversionSchema = new Schema(
  {
    lead: { type: Schema.Types.ObjectId, ref: 'Lead', required: true },
    leadReference: { type: String, required: true },
    /** The lead's source and UTM values at conversion time (attribution for reports). */
    source: { type: String, enum: LEAD_SOURCES, required: true },
    utm: { type: utmSchema, default: null },
    /** The lead's campaign at conversion time (Phase 7). Later re-attribution of the lead does not change it. */
    campaign: { type: Schema.Types.ObjectId, ref: 'Campaign', default: null },
    convertedAt: { type: Date, required: true },
    convertedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { _id: false },
);

const studentSchema = new Schema(
  {
    /** Human-readable id, e.g. "ST-1001". */
    studentNumber: { type: String, required: true, unique: true },

    fullName: { type: String, required: true, trim: true, maxlength: 120 },
    // Not unique, as for leads (shared family emails/phones); duplicates are checked in the service.
    email: { type: String, lowercase: true, trim: true, maxlength: 254, default: null },
    phone: { type: String, trim: true, maxlength: 30, default: null },
    phoneNormalized: { type: String, default: null },
    country: { type: String, trim: true, maxlength: 80, default: null },
    city: { type: String, trim: true, maxlength: 80, default: null },
    profession: { type: String, trim: true, maxlength: 120, default: null },
    dateOfBirth: { type: Date, default: null },

    status: { type: String, enum: STUDENT_STATUSES, required: true, default: 'ACTIVE' },

    /** The staff member responsible for the student (frontend `advisorId`). Drives Sales visibility. */
    advisor: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    advisorAssignedAt: { type: Date, default: null },
    advisorAssignedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },

    /**
     * Enrollments that are not WITHDRAWN. Maintained in the same transaction as the
     * enrollments, so "archive only without active enrollments" is a single atomic check.
     */
    activeEnrollments: { type: Number, required: true, default: 0, min: 0 },

    archivedAt: { type: Date, default: null },
    archivedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    conversion: { type: conversionSchema, default: null },
  },
  { timestamps: true },
);

studentSchema.index({ archivedAt: 1, advisor: 1, createdAt: -1 }); // an advisor's own students
studentSchema.index({ archivedAt: 1, status: 1, createdAt: -1 });
studentSchema.index({ archivedAt: 1, createdAt: -1 });
studentSchema.index({ email: 1 }, { partialFilterExpression: { email: { $type: 'string' } } });
studentSchema.index({ phoneNormalized: 1 }, { partialFilterExpression: { phoneNormalized: { $type: 'string' } } });
// The database-level guarantee that one lead can never produce two students.
studentSchema.index(
  { 'conversion.lead': 1 },
  { unique: true, partialFilterExpression: { 'conversion.lead': { $type: 'objectId' } } },
);

export type StudentFields = InferSchemaType<typeof studentSchema>;
export type StudentDocument = HydratedDocument<StudentFields>;

export const Student = model('Student', studentSchema);
