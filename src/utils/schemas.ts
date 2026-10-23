import { isValidObjectId } from 'mongoose';
import { z } from 'zod';

/** A MongoDB ObjectId in a URL or body, e.g. "665f1c2e9b3e4a0012345678". */
export const objectIdSchema = z
  .string()
  .refine((value) => isValidObjectId(value) && /^[0-9a-f]{24}$/i.test(value), { message: 'Invalid id' });

export const idParamsSchema = z.object({ id: objectIdSchema });

/** Optional free-text field: trims, and turns "" into null so clearing a field works. */
export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === '' ? null : value))
    .nullable()
    .optional();

/** ISO date ("2026-10-20") or date-time ("2026-10-20T09:30:00Z"). */
export const dateInput = z.union([z.iso.datetime({ offset: true }), z.iso.date()]).transform((value) => new Date(value));

/** Query-string boolean: only the literal strings "true" / "false". */
export const booleanQuery = z.enum(['true', 'false']).transform((value) => value === 'true');

/**
 * Accepts `?status=NEW&status=LOST` or `?status=NEW,LOST`. Each value is validated
 * against `item`, so nothing but plain values ever reaches a database filter.
 */
export function multiValue<T extends z.ZodType>(item: T) {
  return z.preprocess(
    (value) => {
      if (value === undefined) return undefined;
      const parts = (Array.isArray(value) ? value : [value]).flatMap((part) => String(part).split(','));
      return parts.map((part) => part.trim()).filter(Boolean);
    },
    z.array(item).min(1).max(50).optional(),
  );
}
