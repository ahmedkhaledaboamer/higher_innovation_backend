import { Types } from 'mongoose';
import { z } from 'zod';
import { MAX_RANGE_DAYS } from '../../config/reporting.js';
import { LEAD_SOURCES } from '../leads/lead.model.js';
import { paginationQuerySchema } from '../../utils/pagination.js';
import { booleanQuery, multiValue, objectIdSchema } from '../../utils/schemas.js';
import { BREAKDOWN_DIMENSIONS } from './leadReports.js';
import { INTERVALS, type Interval, type ReportRange, resolveRange } from './reportRange.js';

const calendarDay = z.iso.date('Use YYYY-MM-DD');

/** Range fields shared by every dashboard/report query. */
const rangeFields = {
  /** First calendar day (YYYY-MM-DD, Asia/Dubai), inclusive. Default: 29 days before `to`. */
  from: calendarDay.optional(),
  /** Last calendar day (YYYY-MM-DD, Asia/Dubai), inclusive. Default: today. */
  to: calendarDay.optional(),
};

/** Resolves `from`/`to` into `range`, enforcing the maximum length for the interval. */
function withRange<T extends z.ZodRawShape>(shape: T, maxDays: (query: Record<string, unknown>) => number) {
  return z.object({ ...rangeFields, ...shape }).transform((query, ctx) => {
    const { from, to } = query as { from?: string; to?: string };
    const resolved = resolveRange({ from, to }, maxDays(query as Record<string, unknown>));
    if ('error' in resolved) {
      ctx.addIssue({ code: 'custom', path: [resolved.path], message: resolved.error });
      return z.NEVER;
    }
    return { ...query, range: resolved.range as ReportRange };
  });
}

/** Lead filters for reports. Only validated plain values reach the database filter. */
const leadFilterFields = {
  source: multiValue(z.enum(LEAD_SOURCES)),
  campaign: multiValue(z.union([objectIdSchema, z.literal('none')])),
  assignedTo: multiValue(z.union([objectIdSchema, z.literal('unassigned')])),
  country: multiValue(z.string().trim().min(1).max(80)),
};

const summaryMax = () => MAX_RANGE_DAYS.summary;
const intervalMax = (query: Record<string, unknown>) => MAX_RANGE_DAYS[(query.interval as Interval) ?? 'day'];

export const dashboardQuerySchema = withRange({}, summaryMax);

export const leadSummaryQuerySchema = withRange(
  {
    ...leadFilterFields,
    /** Also return the same metrics for the preceding period of equal length. */
    compare: booleanQuery.default(false),
  },
  summaryMax,
);

export const leadTimeseriesQuerySchema = withRange(
  { ...leadFilterFields, interval: z.enum(INTERVALS).default('day') },
  intervalMax,
);

export const leadBreakdownQuerySchema = withRange(
  {
    ...leadFilterFields,
    groupBy: z.enum(BREAKDOWN_DIMENSIONS),
    page: paginationQuerySchema.shape.page,
    limit: paginationQuerySchema.shape.limit,
  },
  summaryMax,
);

export const campaignReportQuerySchema = withRange({}, summaryMax);

export const academyReportQuerySchema = withRange({ interval: z.enum(INTERVALS).default('month') }, intervalMax);

export type DashboardQuery = z.infer<typeof dashboardQuerySchema>;
export type LeadSummaryQuery = z.infer<typeof leadSummaryQuerySchema>;
export type LeadTimeseriesQuery = z.infer<typeof leadTimeseriesQuerySchema>;
export type LeadBreakdownQuery = z.infer<typeof leadBreakdownQuerySchema>;
export type CampaignReportQuery = z.infer<typeof campaignReportQuerySchema>;
export type AcademyReportQuery = z.infer<typeof academyReportQuerySchema>;

type LeadFilters = { source?: string[]; campaign?: string[]; assignedTo?: string[]; country?: string[] };

/** Builds the lead filter conditions from validated values (never from raw request objects). */
export function leadFilterConditions(filters: LeadFilters): Array<Record<string, unknown>> {
  const conditions: Array<Record<string, unknown>> = [];
  if (filters.source) conditions.push({ source: { $in: filters.source } });

  const idOrNone = (values: string[], field: string, noneToken: string) => {
    const ids = values.filter((v) => v !== noneToken).map((v) => new Types.ObjectId(v));
    const options: Array<Record<string, unknown>> = [];
    if (ids.length) options.push({ [field]: { $in: ids } });
    if (values.includes(noneToken)) options.push({ [field]: null });
    conditions.push({ $or: options });
  };
  if (filters.campaign) idOrNone(filters.campaign, 'campaign', 'none');
  if (filters.assignedTo) idOrNone(filters.assignedTo, 'assignedTo', 'unassigned');
  if (filters.country) {
    const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    conditions.push({ country: { $in: filters.country.map((c) => new RegExp(`^${escape(c)}$`, 'i')) } });
  }
  return conditions;
}
