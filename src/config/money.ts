/**
 * Money, until the Payments phase:
 * - one currency for the whole academy: AED (UAE dirham), matching the frontend's formatter
 *   (`utils/format.ts` uses `currency: 'AED'`);
 * - amounts are whole dirhams stored as integers (no fils/decimals): course prices,
 *   diploma prices, enrollment price snapshots, lead budgets.
 *
 * This is a code constant on purpose, not an environment variable: changing it would silently
 * reinterpret every stored amount. A real currency change needs a data migration.
 */
export const CURRENCY = 'AED' as const;
export type Currency = typeof CURRENCY;
