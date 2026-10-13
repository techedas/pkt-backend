import { z } from 'zod';
import { pageQuerySchema } from '../utils/pagination';
import { optionalTrimmed, trimmed, uuid } from './common';

export const createProductSchema = z.object({
  productCode: z
    .string()
    .trim()
    .toUpperCase()
    .min(2)
    .max(30)
    .regex(/^[A-Z0-9_-]+$/, 'Use letters, numbers, "-" or "_" only'),
  productName: trimmed(150),
  description: optionalTrimmed(2000),
  category: optionalTrimmed(100),
  productOwner: optionalTrimmed(150),
  status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
});

export const updateProductSchema = createProductSchema.partial();

export const productStatusSchema = z.object({ status: z.enum(['ACTIVE', 'INACTIVE']) });

export const listProductsSchema = pageQuerySchema.extend({
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  category: z.string().max(100).optional(),
});

export const createTopicSchema = z.object({
  productId: uuid,
  parentId: uuid.nullable().optional(),
  name: trimmed(150),
  description: optionalTrimmed(2000),
  sequence: z.coerce.number().int().min(0).max(10000).optional(),
});

export const updateTopicSchema = z.object({
  name: trimmed(150).optional(),
  description: optionalTrimmed(2000),
  sequence: z.coerce.number().int().min(0).max(10000).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
});

export const listTopicsSchema = z.object({
  productId: uuid,
  includeInactive: z.enum(['true', 'false']).optional(),
});
