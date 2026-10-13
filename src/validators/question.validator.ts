import { z } from 'zod';
import { pageQuerySchema } from '../utils/pagination';
import { optionalTrimmed, uuid } from './common';

/** Question types that can currently be authored. Others exist in the schema for future use. */
export const SUPPORTED_QUESTION_TYPES = ['MCQ_SINGLE'] as const;

export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 6;
export const OPTION_CODES = ['A', 'B', 'C', 'D', 'E', 'F'] as const;

const optionSchema = z.object({
  optionText: z.string().trim().min(1, 'Option text is required').max(1000),
  isCorrect: z.boolean(),
});

const questionFields = {
  productId: uuid,
  topicId: uuid,
  subTopicId: uuid.nullable().optional(),
  questionText: z.string().trim().min(5, 'Question text is too short').max(5000),
  questionType: z.enum(SUPPORTED_QUESTION_TYPES).default('MCQ_SINGLE'),
  difficultyLevel: z.enum(['EASY', 'MEDIUM', 'HARD']).default('MEDIUM'),
  marks: z.coerce.number().positive().max(100).default(1),
  negativeMarks: z.coerce.number().min(0).max(100).default(0),
  explanation: optionalTrimmed(5000),
  status: z.enum(['DRAFT', 'ACTIVE', 'INACTIVE']).default('DRAFT'),
  options: z.array(optionSchema).min(MIN_OPTIONS, `At least ${MIN_OPTIONS} options are required`).max(MAX_OPTIONS, `At most ${MAX_OPTIONS} options are allowed`),
};

function checkOptions(q: { options: Array<{ optionText: string; isCorrect: boolean }>; negativeMarks: number; marks: number }, ctx: z.RefinementCtx) {
  const correct = q.options.filter((o) => o.isCorrect).length;
  if (correct !== 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['options'], message: 'Exactly one option must be marked correct' });
  }
  const texts = q.options.map((o) => o.optionText.trim().toLowerCase());
  if (new Set(texts).size !== texts.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['options'], message: 'Options must be unique' });
  }
  if (q.negativeMarks > q.marks) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['negativeMarks'], message: 'Negative marks cannot exceed marks' });
  }
}

export const createQuestionSchema = z.object(questionFields).superRefine(checkOptions);

export const updateQuestionSchema = z.object(questionFields).superRefine(checkOptions);

export const questionStatusSchema = z.object({ status: z.enum(['DRAFT', 'ACTIVE', 'INACTIVE']) });

export const listQuestionsSchema = pageQuerySchema.extend({
  productId: uuid.optional(),
  topicId: uuid.optional(),
  subTopicId: uuid.optional(),
  difficultyLevel: z.enum(['EASY', 'MEDIUM', 'HARD']).optional(),
  status: z.enum(['DRAFT', 'ACTIVE', 'INACTIVE']).optional(),
  questionType: z.enum(['MCQ_SINGLE', 'MCQ_MULTIPLE', 'TRUE_FALSE', 'TEXT', 'SCENARIO', 'AUDIO', 'VIDEO']).optional(),
  createdById: uuid.optional(),
  excludeIds: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').filter(Boolean) : undefined)),
});

export const attachmentSchema = z.object({
  attachmentType: z.enum(['IMAGE', 'AUDIO', 'VIDEO', 'DOCUMENT', 'LINK']),
  url: z
    .string()
    .trim()
    .url('Must be a valid URL')
    .max(1000)
    .refine((u) => /^https?:\/\//i.test(u), 'Only http(s) URLs are allowed'),
  caption: z.string().trim().max(300).optional().nullable(),
  sequence: z.coerce.number().int().min(0).max(1000).optional(),
});

export const attachmentParams = z.object({ id: z.string().uuid(), attachmentId: z.string().uuid() });

export const bulkQuestionRowSchema = z.object({
  productCode: z.string().trim().min(1).max(30),
  topic: z.string().trim().min(1).max(150),
  subtopic: z.string().trim().max(150).optional().nullable(),
  question: z.string().trim().min(5).max(5000),
  options: z.array(z.string().trim().max(1000)).length(MAX_OPTIONS),
  correctAnswer: z.string().trim().toUpperCase().regex(/^[A-F]$/, 'Correct Answer must be one of A-F'),
  difficulty: z.enum(['EASY', 'MEDIUM', 'HARD']),
  marks: z.coerce.number().positive().max(100),
  negativeMarks: z.coerce.number().min(0).max(100),
  explanation: z.string().trim().max(5000).optional().nullable(),
});

export const bulkQuestionConfirmSchema = z.object({
  rows: z.array(bulkQuestionRowSchema).min(1).max(5000),
  status: z.enum(['DRAFT', 'ACTIVE']).default('ACTIVE'),
});
