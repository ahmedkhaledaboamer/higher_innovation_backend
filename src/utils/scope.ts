/**
 * Combines a record-level scope (from the session) with request conditions so the
 * scope always applies: `{ $and: [scope, ...conditions] }`. Request conditions can
 * only narrow the result, never widen it.
 */
// `scope` is a plain filter record. Typed so that passing an un-awaited Promise is a compile error.
export function withScope(
  scope: Record<string, unknown>,
  conditions: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const all = [scope, ...conditions].filter((condition) => Object.keys(condition).length > 0);
  return all.length === 0 ? {} : { $and: all };
}
