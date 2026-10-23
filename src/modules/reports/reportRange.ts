import { DEFAULT_RANGE_DAYS, REPORT_TIMEZONE, REPORT_UTC_OFFSET_MINUTES } from '../../config/reporting.js';

/**
 * Date ranges for dashboards and reports.
 *
 *   from, to  – inclusive calendar days (YYYY-MM-DD) in Asia/Dubai.
 *   start     – instant of `from` 00:00 Dubai.
 *   end       – instant of the day after `to` 00:00 Dubai (exclusive upper bound).
 *
 * A record belongs to the range when start <= timestamp < end.
 */

export const INTERVALS = ['day', 'week', 'month'] as const;
export type Interval = (typeof INTERVALS)[number];

export interface ReportRange {
  from: string;
  to: string;
  start: Date;
  end: Date;
  /** Number of calendar days, inclusive. */
  days: number;
  timezone: typeof REPORT_TIMEZONE;
}

const OFFSET_MS = REPORT_UTC_OFFSET_MINUTES * 60_000;
const DAY_MS = 86_400_000;

/** "2026-10-01" → UTC epoch ms of that calendar day at 00:00 (as if it were UTC). */
function dayNumber(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y!, m! - 1, d!);
}

function formatDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Today's calendar date in the reporting timezone. */
export function todayInReportZone(now: Date = new Date()): string {
  return formatDay(now.getTime() + OFFSET_MS);
}

export function buildRange(from: string, to: string): ReportRange {
  const fromDay = dayNumber(from);
  const toDay = dayNumber(to);
  return {
    from,
    to,
    start: new Date(fromDay - OFFSET_MS),
    end: new Date(toDay + DAY_MS - OFFSET_MS),
    days: Math.round((toDay - fromDay) / DAY_MS) + 1,
    timezone: REPORT_TIMEZONE,
  };
}

/** The range of the same length immediately before `range` (for period-over-period comparison). */
export function previousRange(range: ReportRange): ReportRange {
  const fromDay = dayNumber(range.from);
  return buildRange(formatDay(fromDay - range.days * DAY_MS), formatDay(fromDay - DAY_MS));
}

/**
 * Every bucket key between from and to, so empty periods appear as zeros.
 * Keys match the MongoDB expression from `bucketKeyExpression`: the first day of the bucket,
 * YYYY-MM-DD in Dubai; weeks start on Monday; months on the 1st.
 */
export function bucketKeys(range: ReportRange, interval: Interval): string[] {
  const keys: string[] = [];
  const last = dayNumber(range.to);
  let cursor = dayNumber(range.from);

  if (interval === 'week') {
    const weekday = (new Date(cursor).getUTCDay() + 6) % 7; // Monday = 0
    cursor -= weekday * DAY_MS;
  }
  if (interval === 'month') {
    const date = new Date(cursor);
    cursor = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  }

  while (cursor <= last) {
    keys.push(formatDay(cursor));
    if (interval === 'day') cursor += DAY_MS;
    else if (interval === 'week') cursor += 7 * DAY_MS;
    else {
      const date = new Date(cursor);
      cursor = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
    }
  }
  return keys;
}

/** MongoDB expression giving a timestamp field's bucket key (same format as bucketKeys). */
export function bucketKeyExpression(field: string, interval: Interval): Record<string, unknown> {
  return {
    $dateToString: {
      format: '%Y-%m-%d',
      timezone: REPORT_TIMEZONE,
      date: { $dateTrunc: { date: `$${field}`, unit: interval, timezone: REPORT_TIMEZONE, startOfWeek: 'monday' } },
    },
  };
}

/** Condition "field within range". */
export function inRange(range: ReportRange): Record<string, Date> {
  return { $gte: range.start, $lt: range.end };
}

/* ------------------------------ range resolution ------------------------------ */

/** Applies defaults (last 30 days including today) and the maximum length. */
export function resolveRange(
  input: { from?: string | undefined; to?: string | undefined },
  maxDays: number,
): { range: ReportRange } | { error: string; path: string } {
  const to = input.to ?? todayInReportZone();
  const from = input.from ?? formatDay(dayNumber(to) - (DEFAULT_RANGE_DAYS - 1) * DAY_MS);
  if (dayNumber(from) > dayNumber(to)) return { error: '`from` must be on or before `to`', path: 'from' };
  const range = buildRange(from, to);
  if (range.days > maxDays) return { error: `The range can span at most ${maxDays} days`, path: 'to' };
  return { range };
}
