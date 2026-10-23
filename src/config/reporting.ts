/**
 * Reporting calendar.
 *
 * Dates in reports ("2026-10-01") are calendar days in the academy's timezone, Asia/Dubai.
 * Dubai is UTC+4 all year (no daylight saving), so a fixed offset converts calendar days to
 * instants exactly; MongoDB date bucketing uses the same IANA name.
 *
 * Like the currency, this is a code constant: changing it changes which day every record
 * falls on in historical reports. If the academy ever moves to a DST timezone, replace the
 * fixed offset with a timezone library.
 */
export const REPORT_TIMEZONE = 'Asia/Dubai' as const;
export const REPORT_UTC_OFFSET_MINUTES = 240;

/** Default range when none is given: the last 30 calendar days including today. */
export const DEFAULT_RANGE_DAYS = 30;

/** Longest range (inclusive days) per time-series interval, keeping series to ~100 points or fewer. */
export const MAX_RANGE_DAYS = {
  day: 92,
  week: 371,
  month: 1830,
  /** Summaries and breakdowns (no series). */
  summary: 1830,
} as const;
