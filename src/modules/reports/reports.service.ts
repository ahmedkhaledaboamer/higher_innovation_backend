import type { AuthContext } from '../../types/express.js';
import { buildPaginationMeta } from '../../utils/pagination.js';
import { withScope } from '../../utils/scope.js';
import { readScope as leadReadScope } from '../leads/lead.access.js';
import type { LeadCountSummary } from '../leads/lead.metrics.js';
import {
  campaignPortfolio,
  courseCapacity,
  enrollmentSummary,
  enrollmentTimeseries,
  platformPerformance,
  popularCourses,
  studentCountries,
  studentSummary,
} from './academyReports.js';
import { funnel, leadBreakdown, leadRangeSummary, leadTimeseries } from './leadReports.js';
import { previousRange } from './reportRange.js';
import {
  type AcademyReportQuery,
  type CampaignReportQuery,
  type LeadBreakdownQuery,
  leadFilterConditions,
  type LeadSummaryQuery,
  type LeadTimeseriesQuery,
} from './reports.schema.js';

/**
 * Report endpoints. Routes already require read-all permissions; the caller's lead scope is still
 * applied here (it is empty for read-all roles) so a mis-wired route can never widen access.
 */

const TOP_LIMIT = 10;

function rangeDto(range: { from: string; to: string; days: number; timezone: string }) {
  return { from: range.from, to: range.to, days: range.days, timezone: range.timezone };
}

/** current - previous, and the relative change (null when previous is 0). */
function change(current: number, previous: number) {
  return { absolute: current - previous, relative: previous ? Number(((current - previous) / previous).toFixed(4)) : null };
}

function comparison(current: LeadCountSummary & { conversionsInRange: number }, previous: LeadCountSummary & { conversionsInRange: number }) {
  return {
    leads: change(current.leads, previous.leads),
    qualified: change(current.qualified, previous.qualified),
    converted: change(current.converted, previous.converted),
    lost: change(current.lost, previous.lost),
    conversionsInRange: change(current.conversionsInRange, previous.conversionsInRange),
    conversionRate: { absolute: Number((current.conversionRate - previous.conversionRate).toFixed(4)), relative: null },
  };
}

export const reportsService = {
  async leadSummary(actor: AuthContext, query: LeadSummaryQuery) {
    const match = withScope(leadReadScope(actor), leadFilterConditions(query));
    const current = await leadRangeSummary(match, query.range);
    const result = { range: rangeDto(query.range), summary: current, funnel: funnel(current) };
    if (!query.compare) return result;

    const prevRange = previousRange(query.range);
    const previous = await leadRangeSummary(match, prevRange);
    return { ...result, previous: { range: rangeDto(prevRange), summary: previous }, change: comparison(current, previous) };
  },

  async leadTimeseries(actor: AuthContext, query: LeadTimeseriesQuery) {
    const match = withScope(leadReadScope(actor), leadFilterConditions(query));
    return {
      range: rangeDto(query.range),
      interval: query.interval,
      points: await leadTimeseries(match, query.range, query.interval),
    };
  },

  async leadBreakdown(actor: AuthContext, query: LeadBreakdownQuery) {
    const match = withScope(leadReadScope(actor), leadFilterConditions(query));
    const { rows, groups, totalLeads } = await leadBreakdown(match, query.range, query.groupBy, {
      skip: (query.page - 1) * query.limit,
      limit: query.limit,
    });
    return {
      data: { range: rangeDto(query.range), groupBy: query.groupBy, totalLeads, rows },
      meta: buildPaginationMeta({ page: query.page, limit: query.limit }, groups),
    };
  },

  async campaigns(query: CampaignReportQuery) {
    const [portfolio, platforms] = await Promise.all([campaignPortfolio(), platformPerformance(query.range)]);
    return { range: rangeDto(query.range), portfolio, ...platforms };
  },

  async academy(query: AcademyReportQuery) {
    const [students, enrollments, courses, popular, countries, trend] = await Promise.all([
      studentSummary({}),
      enrollmentSummary({}, query.range),
      courseCapacity(),
      popularCourses({}, query.range, TOP_LIMIT),
      studentCountries({}, TOP_LIMIT),
      enrollmentTimeseries({}, query.range, query.interval),
    ]);
    return {
      range: rangeDto(query.range),
      interval: query.interval,
      students,
      enrollments,
      courses,
      popularCourses: popular.map((course) => ({ ...course, courseId: course.courseId.toString() })),
      countries,
      trend,
    };
  },
};
