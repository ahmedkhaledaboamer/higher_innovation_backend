import mongoose from 'mongoose';
import { afterEach, beforeEach, vi } from 'vitest';

/**
 * Makes concurrency tests deterministic: delays every same-type duplicate-check query (a `find` with
 * an `$or` on email/phoneNormalized against leads or students) so concurrent requests overlap
 * between their check and their write. Without the contact locks, every request would pass its
 * check during the delay; with them, exactly one wins.
 *
 * Returns a counter of delayed queries so tests can assert the overlap really happened.
 */
export function delayDuplicateChecks(delayMs = 150): { count: number } {
  const state = { count: 0 };

  beforeEach(() => {
    state.count = 0;
    const original = mongoose.Query.prototype.exec;
    vi.spyOn(mongoose.Query.prototype, 'exec').mockImplementation(async function (
      this: mongoose.Query<unknown, unknown>,
      ...args
    ) {
      if (isDuplicateCheck(this)) {
        state.count += 1;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      return original.apply(this, args as []);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  return state;
}

function isDuplicateCheck(query: mongoose.Query<unknown, unknown>): boolean {
  const collection = query.model?.collection?.collectionName;
  const filter = query.getFilter() as { $or?: Array<Record<string, unknown>> };
  return (
    (collection === 'leads' || collection === 'students') &&
    (query as unknown as { op?: string }).op === 'find' &&
    Array.isArray(filter.$or) &&
    filter.$or.some((condition) => 'email' in condition || 'phoneNormalized' in condition)
  );
}
