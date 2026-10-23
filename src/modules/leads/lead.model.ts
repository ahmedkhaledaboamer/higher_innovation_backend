import { type HydratedDocument, type InferSchemaType, model, Schema } from 'mongoose';

/**
 * Pipeline stages. The union of the frontend's lead statuses and pipeline stages.
 * REGISTERED means "converted to a student" and is set only by the conversion flow (Phase 5).
 */
export const LEAD_STATUSES = [
  'NEW',
  'CONTACTED',
  'INTERESTED',
  'QUALIFIED',
  'MEETING_SCHEDULED',
  'PAYMENT_PENDING',
  'REGISTERED',
  'LOST',
] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

/** Where the lead came from (frontend `LeadSourceName`). */
export const LEAD_SOURCES = [
  'FACEBOOK_ADS',
  'INSTAGRAM_ADS',
  'GOOGLE_ADS',
  'LANDING_PAGE',
  'WEBSITE',
  'REFERRAL',
  'ORGANIC',
] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

export const LEAD_PRIORITIES = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'] as const;
export type LeadPriority = (typeof LEAD_PRIORITIES)[number];

/** Frontend `LeadTag`: 'Hot Lead' | 'Cold Lead' | 'VIP' | 'Urgent' | 'Returning'. */
export const LEAD_TAGS = ['HOT', 'COLD', 'VIP', 'URGENT', 'RETURNING'] as const;
export type LeadTag = (typeof LEAD_TAGS)[number];

/** UTM campaign parameters captured at intake. Also copied to a student on conversion. */
export const utmSchema = new Schema(
  {
    source: { type: String, trim: true, maxlength: 200 },
    medium: { type: String, trim: true, maxlength: 200 },
    campaign: { type: String, trim: true, maxlength: 200 },
    term: { type: String, trim: true, maxlength: 200 },
    content: { type: String, trim: true, maxlength: 200 },
  },
  { _id: false },
);

const leadSchema = new Schema(
  {
    /** Human-readable id shown in the UI, e.g. "LD-1001". */
    reference: { type: String, required: true, unique: true },

    fullName: { type: String, required: true, trim: true, maxlength: 120 },
    // Neither email nor phone is unique: the same person can enquire twice, and families
    // share numbers. Duplicates are detected in the service instead.
    email: { type: String, lowercase: true, trim: true, maxlength: 254, default: null },
    phone: { type: String, trim: true, maxlength: 30, default: null },
    /** Digits only (with a leading + when international), for duplicate detection and search. */
    phoneNormalized: { type: String, default: null },
    country: { type: String, trim: true, maxlength: 80, default: null },
    city: { type: String, trim: true, maxlength: 80, default: null },
    profession: { type: String, trim: true, maxlength: 120, default: null },

    source: { type: String, enum: LEAD_SOURCES, required: true },
    utm: { type: utmSchema, default: null },
    /**
     * The marketing campaign that produced the lead (Phase 7). Set on create (callers with
     * campaigns:read) or through PATCH /leads/:id/campaign; never by PATCH /leads/:id.
     * Kept when the campaign is later archived or completed (historical attribution).
     * Leads created before Phase 7 simply have no campaign.
     */
    campaign: { type: Schema.Types.ObjectId, ref: 'Campaign', default: null },
    campaignAttributedAt: { type: Date, default: null },
    campaignAttributedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    // The interested course/diploma reference is still deferred (see docs/ARCHITECTURE.md D18).

    status: { type: String, enum: LEAD_STATUSES, required: true, default: 'NEW' },
    statusChangedAt: { type: Date, default: null },
    lostReason: { type: String, trim: true, maxlength: 500, default: null },
    priority: { type: String, enum: LEAD_PRIORITIES, required: true, default: 'MEDIUM' },
    tags: { type: [{ type: String, enum: LEAD_TAGS }], default: [] },
    /** What the lead can spend, in the academy's currency. */
    budget: { type: Number, min: 0, default: null },

    assignedTo: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    assignedAt: { type: Date, default: null },
    assignedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },

    nextFollowUpAt: { type: Date, default: null },
    /** Maintained together with the leadnotes collection (same transaction). */
    notesCount: { type: Number, required: true, default: 0, min: 0 },

    /** Archived leads are hidden from default lists and read-only until restored. Never hard-deleted. */
    archivedAt: { type: Date, default: null },
    archivedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },

    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    /**
     * Set only by POST /leads/:id/convert, in the same transaction that creates the student
     * and sets status REGISTERED. Not accepted by any create/update endpoint.
     */
    convertedStudent: { type: Schema.Types.ObjectId, ref: 'Student', default: null },
    convertedAt: { type: Date, default: null },
    convertedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

// Indexes for the list screen's common queries. Equality fields first, then the sort.
leadSchema.index({ archivedAt: 1, assignedTo: 1, createdAt: -1 }); // a salesperson's own leads
leadSchema.index({ archivedAt: 1, status: 1, createdAt: -1 }); // filter by status
leadSchema.index({ archivedAt: 1, createdAt: -1 }); // default list, newest first
leadSchema.index({ archivedAt: 1, source: 1 });
// Reports (Phase 8). Compound with archivedAt (always an equality in report queries) and not
// partial: the planner cannot use a `$type: date` partial index for a date-range query.
leadSchema.index({ archivedAt: 1, convertedAt: 1 }); // conversions within a range
leadSchema.index({ archivedAt: 1, nextFollowUpAt: 1 }); // follow-ups due
// Campaign metrics and "leads of this campaign" lists.
leadSchema.index({ campaign: 1, archivedAt: 1, status: 1 }, { partialFilterExpression: { campaign: { $type: 'objectId' } } });
leadSchema.index({ nextFollowUpAt: 1 }, { partialFilterExpression: { nextFollowUpAt: { $type: 'date' } } });
// Duplicate detection.
leadSchema.index({ email: 1 }, { partialFilterExpression: { email: { $type: 'string' } } });
leadSchema.index({ phoneNormalized: 1 }, { partialFilterExpression: { phoneNormalized: { $type: 'string' } } });
// A student comes from at most one lead (the student side is guarded too: see student.model).
leadSchema.index(
  { convertedStudent: 1 },
  { unique: true, partialFilterExpression: { convertedStudent: { $type: 'objectId' } } },
);

export type LeadFields = InferSchemaType<typeof leadSchema>;
export type LeadDocument = HydratedDocument<LeadFields>;

export const Lead = model('Lead', leadSchema);
