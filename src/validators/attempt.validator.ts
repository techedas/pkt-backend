import { z } from 'zod';
import { pageQuerySchema } from '../utils/pagination';
import { uuid } from './common';

export const attemptIdParam = z.object({ attemptId: uuid });
export const assessmentIdParam = z.object({ assessmentId: uuid });

export const saveAnswerSchema = z
  .object({
    questionId: uuid,
    // null clears the answer; omitted leaves it unchanged (e.g. only toggling "mark for review").
    selectedOptionId: uuid.nullable().optional(),
    markedForReview: z.boolean().optional(),
  })
  .refine((v) => v.selectedOptionId !== undefined || v.markedForReview !== undefined, {
    message: 'Provide selectedOptionId and/or markedForReview',
  });

export const historyQuerySchema = pageQuerySchema.extend({ assessmentId: uuid.optional() });
