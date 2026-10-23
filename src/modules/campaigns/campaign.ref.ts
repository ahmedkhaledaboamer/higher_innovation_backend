import type { Types } from 'mongoose';

// Kept free of other module imports: lead and student DTOs embed this reference.

/** Minimal campaign reference embedded in leads and converted students. */
export interface CampaignRefDto {
  id: string;
  code: string;
  name: string;
  archived: boolean;
}

export const CAMPAIGN_REF_FIELDS = 'code name archivedAt';

export function toCampaignRef(
  campaign?: { _id: Types.ObjectId; code: string; name: string; archivedAt?: Date | null } | null,
): CampaignRefDto | null {
  return campaign
    ? { id: campaign._id.toString(), code: campaign.code, name: campaign.name, archived: Boolean(campaign.archivedAt) }
    : null;
}
