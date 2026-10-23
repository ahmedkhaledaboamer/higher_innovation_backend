import { LEAD_STATUSES, type LeadStatus } from './lead.model.js';

/**
 * The single definition of lead metrics, shared by campaign metrics, the dashboard and reports.
 *
 * All counts are over **non-archived** leads and use each lead's **current** status (there is
 * no status history). A lead converted to a student has status REGISTERED, and a lead is
 * converted at most once (database-enforced), so "converted" never double-counts.
 */

/** Pipeline order used by the funnel. LOST is outside the funnel. */
export const FUNNEL_STAGES: readonly LeadStatus[] = [
  'NEW',
  'CONTACTED',
  'INTERESTED',
  'QUALIFIED',
  'MEETING_SCHEDULED',
  'PAYMENT_PENDING',
  'REGISTERED',
];

/** "Qualified": currently QUALIFIED or a later stage (LOST excluded). */
export const QUALIFIED_OR_LATER: readonly LeadStatus[] = FUNNEL_STAGES.slice(FUNNEL_STAGES.indexOf('QUALIFIED'));

export type StatusCounts = Record<LeadStatus, number>;

export function emptyStatusCounts(): StatusCounts {
  return Object.fromEntries(LEAD_STATUSES.map((status) => [status, 0])) as StatusCounts;
}

/** Builds full status counts from aggregation rows `{ _id: status, count }`. */
export function statusCountsFrom(rows: Array<{ _id: LeadStatus; count: number }>): StatusCounts {
  const counts = emptyStatusCounts();
  for (const row of rows) counts[row._id] = row.count;
  return counts;
}

export const ratio = (numerator: number, denominator: number, digits = 4): number =>
  denominator ? Number((numerator / denominator).toFixed(digits)) : 0;

export interface LeadCountSummary {
  leads: number;
  byStatus: StatusCounts;
  /** Currently QUALIFIED or later (not LOST). */
  qualified: number;
  /** Converted to a student (status REGISTERED). */
  converted: number;
  lost: number;
  /** Not yet converted and not lost. */
  open: number;
  /** converted / leads, 0..1; 0 when there are no leads. */
  conversionRate: number;
}

export function summarizeStatusCounts(byStatus: StatusCounts): LeadCountSummary {
  const leads = Object.values(byStatus).reduce((sum, n) => sum + n, 0);
  const qualified = QUALIFIED_OR_LATER.reduce((sum, status) => sum + byStatus[status], 0);
  return {
    leads,
    byStatus,
    qualified,
    converted: byStatus.REGISTERED,
    lost: byStatus.LOST,
    open: leads - byStatus.REGISTERED - byStatus.LOST,
    conversionRate: ratio(byStatus.REGISTERED, leads),
  };
}

export interface FunnelStage {
  stage: LeadStatus;
  /** Non-lost leads whose current status is this stage or later. */
  value: number;
  /** value / previous stage's value (0..1). */
  conversionFromPrevious: number;
  /** value / first stage's value (0..1). */
  conversionFromTop: number;
}

/**
 * Funnel from current statuses: a lead counts for every stage up to its current one. LOST leads
 * are excluded (the stage at which they were lost is not recorded) and reported separately.
 */
export function funnelFrom(byStatus: StatusCounts): { stages: FunnelStage[]; lost: number } {
  const values = FUNNEL_STAGES.map((_, index) =>
    FUNNEL_STAGES.slice(index).reduce((sum, status) => sum + byStatus[status], 0),
  );
  const top = values[0] ?? 0;
  return {
    stages: FUNNEL_STAGES.map((stage, index) => ({
      stage,
      value: values[index]!,
      conversionFromPrevious: index === 0 ? (top ? 1 : 0) : ratio(values[index]!, values[index - 1]!),
      conversionFromTop: ratio(values[index]!, top),
    })),
    lost: byStatus.LOST,
  };
}
