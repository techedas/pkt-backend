import { z } from 'zod';

export const uuid = z.string().uuid('must be a valid id');
export const idParam = z.object({ id: uuid });

/** Accepts "true"/"false" query strings as booleans. */
export const boolQuery = z
  .union([z.boolean(), z.enum(['true', 'false'])])
  .transform((v) => v === true || v === 'true');

/** Optional date: '' and null clear the value, undefined leaves it untouched. */
export const optionalDate = z.preprocess((v) => (v === '' ? null : v), z.coerce.date().nullable().optional());

export const trimmed = (max: number) => z.string().trim().min(1).max(max);
export const optionalTrimmed = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((v) => (v === '' ? null : v));
