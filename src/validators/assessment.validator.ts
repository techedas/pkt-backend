import { z } from 'zod';
import { pageQuerySchema } from '../utils/pagination';
import { optionalDate, optionalTrimmed, trimmed, uuid } from './common';

const difficulty = z.enum(['EASY', 'MEDIUM', 'HARD']);

export const ruleSchema = z.object({
  topicId: uuid.nullable().optional(),
  subTopicId: uuid.nullable().optional(),
  difficultyLevel: difficulty.nullable().optional(),
  questionCount: z.coerce.number().int().min(1).max(500),
});

export const distributionSchema = z
  .object({
    EASY: z.coerce.number().int().min(0).max(500).optional(),
    MEDIUM: z.coerce.number().int().min(0).max(500).optional(),
    HARD: z.coerce.number().int().min(0).max(500).optional(),
  })
  .nullable()
  .optional();

const assessmentFields = {
  assessmentCode: z
    .string()
    .trim()
    .toUpperCase()
    .min(2)
    .max(50)
    .regex(/^[A-Z0-9_-]+$/, 'Use letters, numbers, "-" or "_" only')
    .optional(),
  assessmentName: trimmed(200),
  description: optionalTrimmed(5000),
  instructions: optionalTrimmed(10000),
  productId: uuid,
  selectionMode: z.enum(['MANUAL', 'DYNAMIC']).default('MANUAL'),
  totalQuestions: z.coerce.number().int().min(1).max(500).optional(),
  passingPercentage: z.coerce.number().min(0).max(100).optional(),
  durationMinutes: z.coerce.number().int().min(1).max(600).optional(),
  startDate: optionalDate,
  endDate: optionalDate,
  maxAttempts: z.coerce.number().int().min(1).max(50).optional(),
  reattemptPolicy: z.enum(['ALWAYS', 'ONLY_IF_FAILED']).default('ONLY_IF_FAILED'),
  reattemptSameQuestions: z.boolean().default(false),
  randomizeQuestions: z.boolean().default(true),
  randomizeOptions: z.boolean().default(true),
  allowPreviousQuestion: z.boolean().default(true),
  allowQuestionNavigation: z.boolean().default(true),
  showResultImmediately: z.boolean().optional(),
  showCorrectAnswers: z.boolean().optional(),
  showExplanation: z.boolean().optional(),
  negativeMarkingEnabled: z.boolean().default(false),
  autoSubmitOnTimeout: z.boolean().default(true),
  certificationEnabled: z.boolean().default(false),
  certificationValidityDays: z.coerce.number().int().min(1).max(3650).nullable().optional(),
  difficultyDistribution: distributionSchema,
  questionIds: z.array(uuid).max(500).optional(),
  rules: z.array(ruleSchema).max(100).optional(),
};

const dateOrder = (v: { startDate?: Date | null; endDate?: Date | null }, ctx: z.RefinementCtx) => {
  if (v.startDate && v.endDate && v.endDate <= v.startDate) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['endDate'], message: 'End date must be after start date' });
  }
};

export const createAssessmentSchema = z.object(assessmentFields).superRefine(dateOrder);

// Updates accept any subset; the service decides which fields are editable in the current status.
export const updateAssessmentSchema = z
  .object(assessmentFields)
  .partial()
  .extend({
    reattemptPolicy: z.enum(['ALWAYS', 'ONLY_IF_FAILED']).optional(),
    selectionMode: z.enum(['MANUAL', 'DYNAMIC']).optional(),
  })
  .superRefine(dateOrder);

export const assessmentStatusSchema = z.object({ status: z.enum(['INACTIVE', 'ACTIVE']) });

export const listAssessmentsSchema = pageQuerySchema.extend({
  productId: uuid.optional(),
  status: z.enum(['DRAFT', 'PUBLISHED', 'ACTIVE', 'EXPIRED', 'INACTIVE']).optional(),
  selectionMode: z.enum(['MANUAL', 'DYNAMIC']).optional(),
});

export const previewRulesSchema = z.object({
  productId: uuid,
  rules: z.array(ruleSchema).min(1).max(100),
  difficultyDistribution: distributionSchema,
});
