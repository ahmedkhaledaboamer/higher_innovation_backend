import { z } from 'zod';

/** Query-string fields shared by every list endpoint: ?page=2&limit=20 */
export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export function toSkip({ page, limit }: PaginationQuery): number {
  return (page - 1) * limit;
}

export function buildPaginationMeta({ page, limit }: PaginationQuery, total: number): PaginationMeta {
  return { page, limit, total, totalPages: Math.ceil(total / limit) };
}

/** Escapes user input for use inside a RegExp, so a search for "a.b" matches literally. */
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
