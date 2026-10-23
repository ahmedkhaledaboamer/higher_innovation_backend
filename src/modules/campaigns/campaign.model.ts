import { type HydratedDocument, type InferSchemaType, model, Schema } from 'mongoose';
import { utmSchema } from '../leads/lead.model.js';

/** Frontend `MarketingPlatform`. */
export const CAMPAIGN_PLATFORMS = [
  'FACEBOOK_ADS',
  'INSTAGRAM_ADS',
  'GOOGLE_ADS',
  'TIKTOK',
  'LINKEDIN',
  'ORGANIC',
  'REFERRAL',
  'WEBSITE',
] as const;
export type CampaignPlatform = (typeof CAMPAIGN_PLATFORMS)[number];

/** Frontend `CampaignStatus` without 'Archived' (archiving is separate, as for every other module). */
export const CAMPAIGN_STATUSES = ['DRAFT', 'SCHEDULED', 'RUNNING', 'PAUSED', 'COMPLETED'] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

/**
 * Allowed status changes (PATCH /campaigns/:id/status). COMPLETED is final.
 *   DRAFT ─► SCHEDULED ─► RUNNING ⇄ PAUSED
 *     │         │            │        │
 *     └─────────┴► RUNNING   └► COMPLETED ◄┘      (SCHEDULED can also go back to DRAFT)
 */
export const CAMPAIGN_TRANSITIONS: Record<CampaignStatus, readonly CampaignStatus[]> = {
  DRAFT: ['SCHEDULED', 'RUNNING'],
  SCHEDULED: ['RUNNING', 'DRAFT'],
  RUNNING: ['PAUSED', 'COMPLETED'],
  PAUSED: ['RUNNING', 'COMPLETED'],
  COMPLETED: [],
};

/** Statuses a new campaign may start in. */
export const INITIAL_CAMPAIGN_STATUSES = ['DRAFT', 'SCHEDULED', 'RUNNING'] as const;

/**
 * Statuses in which a campaign can be attached to a lead. A campaign that has not started
 * (DRAFT/SCHEDULED) cannot have produced leads; leads arriving after a pause or completion are real.
 * Existing attributions are never removed when a campaign changes status or is archived.
 */
export const ATTRIBUTABLE_CAMPAIGN_STATUSES: readonly CampaignStatus[] = ['RUNNING', 'PAUSED', 'COMPLETED'];

const campaignSchema = new Schema(
  {
    /** Human-readable id, e.g. "CMP-1001". */
    code: { type: String, required: true, unique: true },
    name: { type: String, required: true, trim: true, maxlength: 150 },
    platform: { type: String, enum: CAMPAIGN_PLATFORMS, required: true },
    objective: { type: String, trim: true, maxlength: 300, default: null },
    description: { type: String, trim: true, maxlength: 3000, default: '' },
    /** The course the campaign promotes (frontend courseId). */
    course: { type: Schema.Types.ObjectId, ref: 'Course', default: null },
    /** Staff member responsible (frontend owner). */
    owner: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    /** Whole AED (config/money.ts). Planned budget; null = not set. */
    budget: { type: Number, min: 0, default: null },
    /** Whole AED, entered by Marketing (no ad-platform integration yet). */
    spent: { type: Number, required: true, min: 0, default: 0 },
    startDate: { type: Date, default: null },
    endDate: { type: Date, default: null },
    /** UTM values used in the campaign's links. `utm.campaign` is unique (case-insensitive) when set. */
    utm: { type: utmSchema, default: null },

    status: { type: String, enum: CAMPAIGN_STATUSES, required: true, default: 'DRAFT' },
    statusChangedAt: { type: Date, default: null },

    archivedAt: { type: Date, default: null },
    archivedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

// Attribution by utm_campaign must be unambiguous: one campaign per UTM campaign value.
campaignSchema.index(
  { 'utm.campaign': 1 },
  {
    unique: true,
    collation: { locale: 'en', strength: 2 },
    partialFilterExpression: { 'utm.campaign': { $type: 'string' } },
    name: 'unique_utm_campaign',
  },
);
campaignSchema.index({ archivedAt: 1, status: 1, startDate: -1 });
campaignSchema.index({ archivedAt: 1, platform: 1 });
campaignSchema.index({ archivedAt: 1, createdAt: -1 });

export type CampaignFields = InferSchemaType<typeof campaignSchema>;
export type CampaignDocument = HydratedDocument<CampaignFields>;

export const Campaign = model('Campaign', campaignSchema);
