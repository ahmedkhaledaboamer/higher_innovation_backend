import type { Types } from 'mongoose';
import { CURRENCY, type Currency } from '../../config/money.js';
import { toCourseRef, type CourseRefDto } from '../courses/course.dto.js';
import { toUserRef, type UserRefDto } from '../leads/lead.dto.js';
import type { CampaignMetrics } from './campaign.metrics.js';
import type { CampaignPlatform, CampaignStatus } from './campaign.model.js';

interface PopulatedUser {
  _id: Types.ObjectId;
  firstName: string;
  lastName: string;
  email: string;
}

export interface CampaignWithRefs {
  _id: Types.ObjectId;
  code: string;
  name: string;
  platform: CampaignPlatform;
  objective?: string | null;
  description?: string | null;
  course?: { _id: Types.ObjectId; code: string; name: string } | null;
  owner?: PopulatedUser | null;
  budget?: number | null;
  spent: number;
  startDate?: Date | null;
  endDate?: Date | null;
  utm?: Record<string, string | null | undefined> | null;
  status: CampaignStatus;
  statusChangedAt?: Date | null;
  archivedAt?: Date | null;
  createdBy?: PopulatedUser | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CampaignDto {
  id: string;
  /** e.g. "CMP-1001" */
  code: string;
  name: string;
  platform: CampaignPlatform;
  objective: string | null;
  description: string;
  course: CourseRefDto | null;
  owner: UserRefDto | null;
  /** Whole units of `currency`. */
  budget: number | null;
  spent: number;
  currency: Currency;
  startDate: string | null;
  endDate: string | null;
  utm: { source: string | null; medium: string | null; campaign: string | null; term: string | null; content: string | null } | null;
  status: CampaignStatus;
  statusChangedAt: string | null;
  /** Derived from attributed leads at request time. */
  metrics: CampaignMetrics;
  archived: boolean;
  archivedAt: string | null;
  createdBy: UserRefDto | null;
  createdAt: string;
  updatedAt: string;
}

export const CAMPAIGN_COURSE_FIELDS = 'code name';

const iso = (date?: Date | null) => (date ? date.toISOString() : null);

export function toCampaignDto(campaign: CampaignWithRefs, metrics: CampaignMetrics): CampaignDto {
  const utm = campaign.utm;
  return {
    id: campaign._id.toString(),
    code: campaign.code,
    name: campaign.name,
    platform: campaign.platform,
    objective: campaign.objective ?? null,
    description: campaign.description ?? '',
    course: toCourseRef(campaign.course),
    owner: toUserRef(campaign.owner),
    budget: campaign.budget ?? null,
    spent: campaign.spent,
    currency: CURRENCY,
    startDate: iso(campaign.startDate),
    endDate: iso(campaign.endDate),
    utm: utm
      ? {
          source: utm.source ?? null,
          medium: utm.medium ?? null,
          campaign: utm.campaign ?? null,
          term: utm.term ?? null,
          content: utm.content ?? null,
        }
      : null,
    status: campaign.status,
    statusChangedAt: iso(campaign.statusChangedAt),
    metrics,
    archived: Boolean(campaign.archivedAt),
    archivedAt: iso(campaign.archivedAt),
    createdBy: toUserRef(campaign.createdBy),
    createdAt: campaign.createdAt.toISOString(),
    updatedAt: campaign.updatedAt.toISOString(),
  };
}
