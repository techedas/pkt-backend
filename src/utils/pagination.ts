import { z } from 'zod';

export interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface PageQuery {
  page: number;
  pageSize: number;
  search?: string;
  sortBy?: string;
  sortOrder: 'asc' | 'desc';
}

export const MAX_PAGE_SIZE = 200;

export const pageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(20),
  search: z
    .string()
    .trim()
    .max(200)
    .optional()
    .transform((v) => (v ? v : undefined)),
  sortBy: z.string().max(50).optional(),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

export function toSkipTake(q: Pick<PageQuery, 'page' | 'pageSize'>) {
  return { skip: (q.page - 1) * q.pageSize, take: q.pageSize };
}

export function buildPagination(q: Pick<PageQuery, 'page' | 'pageSize'>, total: number): Pagination {
  return {
    page: q.page,
    pageSize: q.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / q.pageSize)),
  };
}

/**
 * Resolve a client-supplied sort field against a whitelist so arbitrary
 * column names can never reach the query.
 */
export function resolveSort<T extends string>(
  sortBy: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  return sortBy && (allowed as readonly string[]).includes(sortBy) ? (sortBy as T) : fallback;
}
