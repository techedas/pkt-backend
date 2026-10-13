import { z } from 'zod';
import { pageQuerySchema } from '../utils/pagination';
import { uuid } from './common';

export const reportFilterSchema = z.object({
  productId: uuid.optional(),
  assessmentId: uuid.optional(),
  userId: uuid.optional(),
  topicId: uuid.optional(),
  department: z.string().max(100).optional(),
  team: z.string().max(100).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export const resultsQuerySchema = pageQuerySchema.merge(reportFilterSchema).extend({
  result: z.enum(['PASS', 'FAIL']).optional(),
});

export const pendingQuerySchema = pageQuerySchema.merge(reportFilterSchema).extend({
  overdueOnly: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

export const questionAnalyticsQuerySchema = pageQuerySchema.merge(reportFilterSchema).extend({
  flag: z.enum(['VERY_EASY', 'DIFFICULT', 'AMBIGUOUS', 'FLAGGED']).optional(),
});

export const exportQuerySchema = resultsQuerySchema.extend({
  format: z.enum(['csv']).default('csv'),
  overdueOnly: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

export const exportTypeParam = z.object({
  type: z.enum(['user-results', 'assessment-results', 'product-report', 'knowledge-gap', 'pending-assessments']),
});
