import { Types } from 'mongoose';
import { Campaign } from '../campaigns/campaign.model.js';
import {
  emptyStatusCounts,
  funnelFrom,
  type LeadCountSummary,
  ratio,
  statusCountsFrom,
  summarizeStatusCounts,
} from '../leads/lead.metrics.js';
import { Lead, type LeadStatus } from '../leads/lead.model.js';
import { User } from '../users/user.model.js';
import { bucketKeyExpression, bucketKeys, inRange, type Interval, type ReportRange, todayInReportZone, buildRange } from './reportRange.js';

/**
 * Lead aggregations shared by the dashboard and the lead reports.
 *
 * Time basis:
 *   cohort metrics      – leads whose createdAt is in the range, counted by their current status.
 *   conversion activity – leads whose convertedAt is in the range (when the conversion happened).
 * Archived leads are always excluded. `match` carries the caller's scope (e.g. Sales: their own
 * leads) and validated filters; it is AND-ed into every pipeline.
 */

export type LeadMatch = Record<string, unknown>;

const notArchived = { archivedAt: null };

export interface LeadRangeSummary extends LeadCountSummary {
  /** Leads converted to students during the range (by convertedAt), whatever their creation date. */
  conversionsInRange: number;
}

export async function leadRangeSummary(match: LeadMatch, range: ReportRange): Promise<LeadRangeSummary> {
  const [statusRows, conversionsInRange] = await Promise.all([
    Lead.aggregate<{ _id: LeadStatus; count: number }>([
      { $match: { $and: [match, notArchived, { createdAt: inRange(range) }] } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    Lead.countDocuments({ $and: [match, notArchived, { convertedAt: inRange(range) }] }),
  ]);
  return { ...summarizeStatusCounts(statusCountsFrom(statusRows)), conversionsInRange };
}

/** Open leads (not REGISTERED or LOST) whose next follow-up is due by the end of today (Dubai). */
export async function followUpsDue(match: LeadMatch): Promise<number> {
  const today = buildRange(todayInReportZone(), todayInReportZone());
  return Lead.countDocuments({
    $and: [match, notArchived, { status: { $nin: ['REGISTERED', 'LOST'] }, nextFollowUpAt: { $ne: null, $lt: today.end } }],
  });
}

export function funnel(summary: LeadCountSummary) {
  return funnelFrom(summary.byStatus);
}

export interface LeadSeriesPoint {
  /** First day of the bucket (YYYY-MM-DD, Dubai). */
  period: string;
  /** Cohort: leads created in the bucket... */
  leads: number;
  /** ...of which currently qualified or later, converted, lost. */
  qualified: number;
  converted: number;
  lost: number;
  /** Activity: conversions that happened in the bucket. */
  conversions: number;
}

export async function leadTimeseries(match: LeadMatch, range: ReportRange, interval: Interval): Promise<LeadSeriesPoint[]> {
  const [created, conversions] = await Promise.all([
    Lead.aggregate<{ _id: { period: string; status: LeadStatus }; count: number }>([
      { $match: { $and: [match, notArchived, { createdAt: inRange(range) }] } },
      { $group: { _id: { period: bucketKeyExpression('createdAt', interval), status: '$status' }, count: { $sum: 1 } } },
    ]),
    Lead.aggregate<{ _id: string; count: number }>([
      { $match: { $and: [match, notArchived, { convertedAt: inRange(range) }] } },
      { $group: { _id: bucketKeyExpression('convertedAt', interval), count: { $sum: 1 } } },
    ]),
  ]);

  const byPeriod = new Map<string, ReturnType<typeof emptyStatusCounts>>();
  for (const row of created) {
    const counts = byPeriod.get(row._id.period) ?? emptyStatusCounts();
    counts[row._id.status] = row.count;
    byPeriod.set(row._id.period, counts);
  }
  const conversionsByPeriod = new Map(conversions.map((row) => [row._id, row.count]));

  return bucketKeys(range, interval).map((period) => {
    const summary = summarizeStatusCounts(byPeriod.get(period) ?? emptyStatusCounts());
    return {
      period,
      leads: summary.leads,
      qualified: summary.qualified,
      converted: summary.converted,
      lost: summary.lost,
      conversions: conversionsByPeriod.get(period) ?? 0,
    };
  });
}

export const BREAKDOWN_DIMENSIONS = ['source', 'status', 'campaign', 'assignee', 'country'] as const;
export type BreakdownDimension = (typeof BREAKDOWN_DIMENSIONS)[number];

const DIMENSION_FIELD: Record<BreakdownDimension, string> = {
  source: '$source',
  status: '$status',
  campaign: '$campaign',
  assignee: '$assignedTo',
  country: '$country',
};

export interface BreakdownRow {
  /** Group value: enum value, id, country name, or null (no campaign / unassigned / no country). */
  key: string | null;
  label: string;
  leads: number;
  qualified: number;
  converted: number;
  lost: number;
  conversionRate: number;
  /** Share of all leads in the range (0..1). */
  share: number;
}

const NULL_LABELS: Record<BreakdownDimension, string> = {
  source: '(none)',
  status: '(none)',
  campaign: '(no campaign)',
  assignee: '(unassigned)',
  country: '(not set)',
};

/**
 * Leads created in the range, grouped by one dimension, sorted by lead count (desc), paginated.
 * One aggregation produces the page, the number of groups and the overall total.
 */
export async function leadBreakdown(
  match: LeadMatch,
  range: ReportRange,
  dimension: BreakdownDimension,
  page: { skip: number; limit: number },
): Promise<{ rows: BreakdownRow[]; groups: number; totalLeads: number }> {
  // Countries are compared case-insensitively ("Egypt" = "egypt").
  // ($toLower(null) is "", so missing countries are kept as null explicitly.)
  const key =
    dimension === 'country'
      ? { $cond: [{ $eq: [{ $ifNull: ['$country', null] }, null] }, null, { $toLower: '$country' }] }
      : DIMENSION_FIELD[dimension];

  const [result] = await Lead.aggregate<{
    page: Array<{ _id: unknown; leads: number; statuses: Array<{ status: LeadStatus; count: number }>; sample: string | null }>;
    groups: Array<{ count: number }>;
    total: Array<{ count: number }>;
  }>([
    { $match: { $and: [match, notArchived, { createdAt: inRange(range) }] } },
    { $group: { _id: { key, status: '$status' }, count: { $sum: 1 }, sample: { $first: '$country' } } },
    {
      $group: {
        _id: '$_id.key',
        leads: { $sum: '$count' },
        statuses: { $push: { status: '$_id.status', count: '$count' } },
        sample: { $first: '$sample' },
      },
    },
    {
      $facet: {
        page: [{ $sort: { leads: -1, _id: 1 } }, { $skip: page.skip }, { $limit: page.limit }],
        groups: [{ $count: 'count' }],
        total: [{ $group: { _id: null, count: { $sum: '$leads' } } }],
      },
    },
  ]);

  const totalLeads = result?.total[0]?.count ?? 0;
  const pageRows = result?.page ?? [];
  const labels = await labelsFor(dimension, pageRows.map((row) => row._id));

  return {
    groups: result?.groups[0]?.count ?? 0,
    totalLeads,
    rows: pageRows.map((row) => {
      const counts = emptyStatusCounts();
      for (const entry of row.statuses) counts[entry.status] = entry.count;
      const summary = summarizeStatusCounts(counts);
      const keyString = row._id === null || row._id === undefined ? null : String(row._id);
      return {
        key: keyString,
        label:
          keyString === null
            ? NULL_LABELS[dimension]
            : dimension === 'country'
              ? (row.sample ?? keyString)
              : (labels.get(keyString) ?? keyString),
        leads: summary.leads,
        qualified: summary.qualified,
        converted: summary.converted,
        lost: summary.lost,
        conversionRate: summary.conversionRate,
        share: ratio(summary.leads, totalLeads),
      };
    }),
  };
}

/** Human labels for one page of campaign / assignee ids (one query, no N+1). */
async function labelsFor(dimension: BreakdownDimension, keys: unknown[]): Promise<Map<string, string>> {
  const ids = keys.filter((key): key is Types.ObjectId => key instanceof Types.ObjectId);
  if (ids.length === 0) return new Map();
  if (dimension === 'campaign') {
    const campaigns = await Campaign.find({ _id: { $in: ids } }).select('code name').lean();
    return new Map(campaigns.map((c) => [c._id.toString(), `${c.name} (${c.code})`]));
  }
  if (dimension === 'assignee') {
    const users = await User.find({ _id: { $in: ids } }).select('firstName lastName').lean();
    return new Map(users.map((u) => [u._id.toString(), `${u.firstName} ${u.lastName}`.trim()]));
  }
  return new Map();
}
