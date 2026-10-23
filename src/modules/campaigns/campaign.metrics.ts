import type { Types } from 'mongoose';
import { emptyStatusCounts, ratio, summarizeStatusCounts } from '../leads/lead.metrics.js';
import { Lead, type LeadStatus } from '../leads/lead.model.js';

/**
 * Campaign performance, derived from the leads attributed to each campaign at request time.
 * Nothing is stored, so totals cannot drift when leads are created, reassigned, converted,
 * archived or re-attributed concurrently. Archived leads are excluded.
 *
 * Ad-platform numbers (impressions, clicks, visitors) and revenue are not available until
 * integrations / payments exist, and are not invented here.
 */

export interface CampaignMetrics {
  leads: number;
  byStatus: Record<LeadStatus, number>;
  qualifiedLeads: number;
  /** Leads converted to students (status REGISTERED). */
  registeredStudents: number;
  lostLeads: number;
  /** registeredStudents / leads, 0..1 (4 decimals); 0 when there are no leads. */
  conversionRate: number;
  /** spent / leads in AED (2 decimals); null when there are no leads. */
  costPerLead: number | null;
  /** spent / budget, 0..n (4 decimals); null when no budget is set. */
  budgetUsed: number | null;
}

/** Lead counts per campaign and status, in one aggregation for all the given campaigns. */
export async function leadCountsByCampaign(
  campaignIds: Types.ObjectId[],
): Promise<Map<string, Record<LeadStatus, number>>> {
  const result = new Map<string, Record<LeadStatus, number>>();
  if (campaignIds.length === 0) return result;

  const rows = await Lead.aggregate<{ _id: { campaign: Types.ObjectId; status: LeadStatus }; count: number }>([
    { $match: { campaign: { $in: campaignIds }, archivedAt: null } },
    { $group: { _id: { campaign: '$campaign', status: '$status' }, count: { $sum: 1 } } },
  ]);
  for (const row of rows) {
    const key = row._id.campaign.toString();
    const counts = result.get(key) ?? emptyStatusCounts();
    counts[row._id.status] = row.count;
    result.set(key, counts);
  }
  return result;
}

export function computeMetrics(
  counts: Record<LeadStatus, number> | undefined,
  money: { spent: number; budget: number | null },
): CampaignMetrics {
  // Same definitions as the dashboard and reports (leads/lead.metrics.ts).
  const summary = summarizeStatusCounts(counts ?? emptyStatusCounts());
  return {
    leads: summary.leads,
    byStatus: summary.byStatus,
    qualifiedLeads: summary.qualified,
    registeredStudents: summary.converted,
    lostLeads: summary.lost,
    conversionRate: summary.conversionRate,
    costPerLead: summary.leads ? ratio(money.spent, summary.leads, 2) : null,
    budgetUsed: money.budget ? ratio(money.spent, money.budget) : null,
  };
}
