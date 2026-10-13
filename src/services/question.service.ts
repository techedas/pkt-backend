import type { Prisma, QuestionStatus } from '@prisma/client';
import type { z } from 'zod';
import { prisma } from '../config/database';
import { questionInclude, questionRepository, type QuestionFilter } from '../repositories/question.repository';
import type { RequestContext } from '../types/auth';
import { AppError } from '../utils/errors';
import { questionContentHash } from '../utils/helpers';
import type { SheetRow } from '../utils/spreadsheet';
import {
  bulkQuestionRowSchema,
  OPTION_CODES,
  type attachmentSchema,
  type createQuestionSchema,
} from '../validators/question.validator';
import { auditService } from './audit.service';
import { scopeService } from './scope.service';

type QuestionInput = z.infer<typeof createQuestionSchema>;
type AttachmentInput = z.infer<typeof attachmentSchema>;
type BulkRow = z.infer<typeof bulkQuestionRowSchema>;

type QuestionWithRelations = Prisma.QuestionGetPayload<{ include: typeof questionInclude }>;

export function toQuestionDto(q: QuestionWithRelations) {
  return {
    id: q.id,
    questionNo: q.questionNo,
    questionCode: `Q${q.questionNo}`,
    productId: q.productId,
    product: q.product,
    topicId: q.topicId,
    topic: q.topic,
    subTopicId: q.subTopicId,
    subTopic: q.subTopic,
    questionText: q.questionText,
    questionType: q.questionType,
    difficultyLevel: q.difficultyLevel,
    marks: q.marks,
    negativeMarks: q.negativeMarks,
    explanation: q.explanation,
    status: q.status,
    version: q.version,
    createdBy: q.createdBy ? { id: q.createdBy.id, name: `${q.createdBy.firstName} ${q.createdBy.lastName}` } : null,
    createdAt: q.createdAt,
    updatedAt: q.updatedAt,
    options: q.options.map((o) => ({ id: o.id, optionCode: o.optionCode, optionText: o.optionText, isCorrect: o.isCorrect, sequence: o.sequence })),
    attachments: q.attachments.map((a) => ({ id: a.id, attachmentType: a.attachmentType, url: a.url, caption: a.caption, sequence: a.sequence })),
  };
}

/** Ensure topic/subtopic belong to the product and to each other. */
async function assertTopics(productId: string, topicId: string, subTopicId?: string | null) {
  const topic = await prisma.productTopic.findFirst({ where: { id: topicId, deletedAt: null } });
  if (!topic || topic.productId !== productId || topic.parentId) {
    throw AppError.badRequest('Selected topic does not belong to the selected product.', 'INVALID_TOPIC');
  }
  if (subTopicId) {
    const sub = await prisma.productTopic.findFirst({ where: { id: subTopicId, deletedAt: null } });
    if (!sub || sub.parentId !== topicId) {
      throw AppError.badRequest('Selected subtopic does not belong to the selected topic.', 'INVALID_SUBTOPIC');
    }
  }
}

async function assertNotDuplicate(productId: string, text: string, excludeId?: string) {
  const hash = questionContentHash(productId, text);
  const dup = await prisma.question.findFirst({
    where: { productId, contentHash: hash, deletedAt: null, ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: { questionNo: true },
  });
  if (dup) throw AppError.conflict(`A similar question already exists (Q${dup.questionNo}).`, 'DUPLICATE_QUESTION');
  return hash;
}

/** Block removing a question that live assessments depend on. */
async function assertNotInLiveAssessment(questionId: string) {
  const used = await prisma.assessmentQuestion.findMany({
    where: { questionId, assessment: { deletedAt: null, status: { in: ['DRAFT', 'PUBLISHED', 'ACTIVE'] } } },
    select: { assessment: { select: { assessmentCode: true, status: true } } },
  });
  if (used.length) {
    throw AppError.conflict(
      `This question is used in assessment(s): ${used.map((u) => `${u.assessment.assessmentCode} (${u.assessment.status})`).join(', ')}. Remove it from those assessments first.`,
      'QUESTION_IN_USE',
    );
  }
}

const optionRows = (options: QuestionInput['options']) =>
  options.map((o, i) => ({ optionCode: OPTION_CODES[i], optionText: o.optionText, isCorrect: o.isCorrect, sequence: i + 1 }));

export const questionService = {
  async list(ctx: RequestContext, f: QuestionFilter) {
    const { rows, pagination } = await questionRepository.list({ ...f, productScope: scopeService.productIds(ctx.user) });
    return { rows: rows.map(toQuestionDto), pagination };
  },

  async get(ctx: RequestContext, id: string) {
    const q = await questionRepository.findById(id);
    if (!q) throw AppError.notFound('Question');
    scopeService.assertProductAccess(ctx.user, q.productId);
    const usage = await prisma.assessmentQuestion.findMany({
      where: { questionId: id, assessment: { deletedAt: null } },
      select: { assessment: { select: { id: true, assessmentCode: true, assessmentName: true, status: true } } },
    });
    return { ...toQuestionDto(q), usedIn: usage.map((u) => u.assessment) };
  },

  async create(ctx: RequestContext, input: QuestionInput) {
    scopeService.assertProductAccess(ctx.user, input.productId);
    await assertTopics(input.productId, input.topicId, input.subTopicId);
    const contentHash = await assertNotDuplicate(input.productId, input.questionText);
    const { options, ...data } = input;
    const q = await prisma.question.create({
      data: { ...data, subTopicId: data.subTopicId ?? null, contentHash, createdById: ctx.user.id, options: { create: optionRows(options) } },
      include: questionInclude,
    });
    const dto = toQuestionDto(q);
    await auditService.log(ctx, 'QUESTION_ADDED', 'Question', q.id, undefined, dto);
    return dto;
  },

  /**
   * Update a question. Attempts keep their own snapshot, so edits never alter
   * historical results; the version number records that the content changed.
   */
  async update(ctx: RequestContext, id: string, input: QuestionInput) {
    const existing = await questionRepository.findById(id);
    if (!existing) throw AppError.notFound('Question');
    scopeService.assertProductAccess(ctx.user, existing.productId);
    scopeService.assertProductAccess(ctx.user, input.productId);
    if (input.productId !== existing.productId) await assertNotInLiveAssessment(id);
    await assertTopics(input.productId, input.topicId, input.subTopicId);
    const contentHash = await assertNotDuplicate(input.productId, input.questionText, id);
    if (input.status !== 'ACTIVE' && existing.status === 'ACTIVE') await assertNotInLiveAssessment(id);

    const { options, ...data } = input;
    const q = await prisma.$transaction(async (tx) => {
      await tx.questionOption.deleteMany({ where: { questionId: id } });
      return tx.question.update({
        where: { id },
        data: {
          ...data,
          subTopicId: data.subTopicId ?? null,
          contentHash,
          version: { increment: 1 },
          options: { create: optionRows(options) },
        },
        include: questionInclude,
      });
    });
    const dto = toQuestionDto(q);
    await auditService.log(ctx, 'QUESTION_MODIFIED', 'Question', id, toQuestionDto(existing), dto);
    return dto;
  },

  async setStatus(ctx: RequestContext, id: string, status: QuestionStatus) {
    const existing = await prisma.question.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw AppError.notFound('Question');
    scopeService.assertProductAccess(ctx.user, existing.productId);
    if (status !== 'ACTIVE') await assertNotInLiveAssessment(id);
    await prisma.question.update({ where: { id }, data: { status } });
    await auditService.log(ctx, `QUESTION_${status}`, 'Question', id, { status: existing.status }, { status });
    return { id, status };
  },

  async remove(ctx: RequestContext, id: string) {
    const existing = await prisma.question.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw AppError.notFound('Question');
    scopeService.assertProductAccess(ctx.user, existing.productId);
    await assertNotInLiveAssessment(id);
    await prisma.question.update({ where: { id }, data: { deletedAt: new Date(), status: 'INACTIVE' } });
    await auditService.log(ctx, 'QUESTION_DELETED', 'Question', id, { questionNo: existing.questionNo }, undefined);
  },

  // -------------------------------------------------------------------------
  // Attachments (question_attachments)
  // -------------------------------------------------------------------------

  async assertQuestionAccess(ctx: RequestContext, questionId: string) {
    const q = await prisma.question.findFirst({ where: { id: questionId, deletedAt: null }, select: { productId: true } });
    if (!q) throw AppError.notFound('Question');
    scopeService.assertProductAccess(ctx.user, q.productId);
  },

  async listAttachments(ctx: RequestContext, questionId: string) {
    await this.assertQuestionAccess(ctx, questionId);
    return prisma.questionAttachment.findMany({ where: { questionId }, orderBy: [{ sequence: 'asc' }, { createdAt: 'asc' }] });
  },

  async addAttachment(ctx: RequestContext, questionId: string, input: AttachmentInput) {
    await this.assertQuestionAccess(ctx, questionId);
    const sequence = input.sequence ?? (await prisma.questionAttachment.count({ where: { questionId } })) + 1;
    const attachment = await prisma.questionAttachment.create({
      data: { questionId, attachmentType: input.attachmentType, url: input.url, caption: input.caption ?? null, sequence, createdById: ctx.user.id },
    });
    await auditService.log(ctx, 'QUESTION_ATTACHMENT_ADDED', 'Question', questionId, undefined, attachment);
    return attachment;
  },

  async updateAttachment(ctx: RequestContext, questionId: string, attachmentId: string, input: Partial<AttachmentInput>) {
    await this.assertQuestionAccess(ctx, questionId);
    const existing = await prisma.questionAttachment.findFirst({ where: { id: attachmentId, questionId } });
    if (!existing) throw AppError.notFound('Attachment');
    const updated = await prisma.questionAttachment.update({
      where: { id: attachmentId },
      data: {
        ...(input.attachmentType ? { attachmentType: input.attachmentType } : {}),
        ...(input.url ? { url: input.url } : {}),
        ...(input.caption !== undefined ? { caption: input.caption ?? null } : {}),
        ...(input.sequence !== undefined ? { sequence: input.sequence } : {}),
      },
    });
    await auditService.log(ctx, 'QUESTION_ATTACHMENT_UPDATED', 'Question', questionId, existing, updated);
    return updated;
  },

  async removeAttachment(ctx: RequestContext, questionId: string, attachmentId: string) {
    await this.assertQuestionAccess(ctx, questionId);
    const existing = await prisma.questionAttachment.findFirst({ where: { id: attachmentId, questionId } });
    if (!existing) throw AppError.notFound('Attachment');
    await prisma.questionAttachment.delete({ where: { id: attachmentId } });
    await auditService.log(ctx, 'QUESTION_ATTACHMENT_REMOVED', 'Question', questionId, existing, undefined);
  },

  async creators(ctx: RequestContext) {
    const rows = await prisma.question.findMany({
      where: { deletedAt: null, createdById: { not: null }, ...scopeService.productFilter(ctx.user) },
      distinct: ['createdById'],
      select: { createdBy: { select: { id: true, firstName: true, lastName: true } } },
    });
    return rows.filter((r) => r.createdBy).map((r) => ({ id: r.createdBy!.id, name: `${r.createdBy!.firstName} ${r.createdBy!.lastName}` }));
  },

  // -------------------------------------------------------------------------
  // Bulk upload
  // -------------------------------------------------------------------------

  /**
   * Validate uploaded rows without writing anything. Each row gets `errors`
   * (row will be skipped) and `warnings` (row is fine, e.g. a topic will be created).
   */
  async bulkPreview(ctx: RequestContext, sheetRows: SheetRow[]) {
    const products = await prisma.product.findMany({
      where: { deletedAt: null, ...(ctx.user.productScope ? { id: { in: ctx.user.productScope } } : {}) },
      include: { topics: { where: { deletedAt: null } } },
    });
    const productByCode = new Map(products.map((p) => [p.productCode.toUpperCase(), p]));
    const existingHashes = await questionRepository.existingHashes(products.map((p) => p.id));
    const fileHashes = new Map<string, number>();

    const rows = sheetRows.map((raw, index) => {
      const rowNumber = index + 2;
      const candidate = {
        productCode: (raw.productcode ?? '').toUpperCase(),
        topic: raw.topic ?? '',
        subtopic: raw.subtopic || null,
        question: raw.question ?? raw.questiontext ?? '',
        options: OPTION_CODES.map((c) => raw[`option${c.toLowerCase()}`] ?? ''),
        correctAnswer: (raw.correctanswer ?? '').toUpperCase(),
        difficulty: (raw.difficulty || 'MEDIUM').toUpperCase(),
        marks: raw.marks || '1',
        negativeMarks: raw.negativemarks || '0',
        explanation: raw.explanation || null,
      };
      const errors: string[] = [];
      const warnings: string[] = [];
      const parsed = bulkQuestionRowSchema.safeParse(candidate);
      if (!parsed.success) errors.push(...parsed.error.issues.map((i) => `${i.path.join('.') || 'row'}: ${i.message}`));
      const data = (parsed.success ? parsed.data : candidate) as BulkRow;

      const filled = data.options.map((o, i) => ({ code: OPTION_CODES[i], text: (o ?? '').trim() })).filter((o) => o.text);
      if (filled.length < 2) errors.push('At least 2 options are required');
      const lastFilled = Math.max(...data.options.map((o, i) => ((o ?? '').trim() ? i : -1)));
      if (filled.length && lastFilled + 1 !== filled.length) errors.push('Options must be filled in order (no gaps between A-F)');
      if (data.correctAnswer && !filled.some((o) => o.code === data.correctAnswer)) {
        errors.push(`Correct Answer ${data.correctAnswer} refers to an empty option`);
      }
      const lowered = filled.map((o) => o.text.toLowerCase());
      if (new Set(lowered).size !== lowered.length) errors.push('Options must be unique');
      if (Number(data.negativeMarks) > Number(data.marks)) errors.push('Negative marks cannot exceed marks');

      const product = productByCode.get(data.productCode);
      let topicId: string | null = null;
      let subTopicId: string | null = null;
      if (!product) {
        errors.push(`Unknown product code ${data.productCode || '(blank)'}${ctx.user.productScope ? ' or not assigned to you' : ''}`);
      } else {
        const topic = product.topics.find((t) => !t.parentId && t.name.toLowerCase() === data.topic.toLowerCase());
        if (topic) topicId = topic.id;
        else if (data.topic) warnings.push(`Topic "${data.topic}" will be created`);
        if (data.subtopic) {
          const sub = topic && product.topics.find((t) => t.parentId === topic.id && t.name.toLowerCase() === data.subtopic!.toLowerCase());
          if (sub) subTopicId = sub.id;
          else warnings.push(`Subtopic "${data.subtopic}" will be created`);
        }
        if (data.question) {
          const hash = questionContentHash(product.id, data.question);
          const existing = existingHashes.get(hash);
          if (existing) errors.push(`Duplicate of existing question Q${existing.questionNo}`);
          else if (fileHashes.has(hash)) errors.push(`Duplicate of row ${fileHashes.get(hash)} in this file`);
          else fileHashes.set(hash, rowNumber);
        }
      }
      return { rowNumber, data, topicId, subTopicId, errors, warnings, isDuplicate: errors.some((e) => e.startsWith('Duplicate')) };
    });

    const valid = rows.filter((r) => !r.errors.length).length;
    return {
      rows,
      summary: {
        total: rows.length,
        valid,
        invalid: rows.length - valid,
        duplicates: rows.filter((r) => r.isDuplicate).length,
      },
    };
  },

  /** Re-validate on the server and store valid rows. Missing topics/subtopics are created. */
  async bulkConfirm(ctx: RequestContext, rows: BulkRow[], status: 'DRAFT' | 'ACTIVE') {
    const preview = await this.bulkPreview(
      ctx,
      rows.map((r) => ({
        productcode: r.productCode,
        topic: r.topic,
        subtopic: r.subtopic ?? '',
        question: r.question,
        ...Object.fromEntries(OPTION_CODES.map((c, i) => [`option${c.toLowerCase()}`, r.options[i] ?? ''])),
        correctanswer: r.correctAnswer,
        difficulty: r.difficulty,
        marks: String(r.marks),
        negativemarks: String(r.negativeMarks),
        explanation: r.explanation ?? '',
      })),
    );
    const valid = preview.rows.filter((r) => !r.errors.length);
    const products = new Map(
      (await prisma.product.findMany({ where: { productCode: { in: [...new Set(valid.map((r) => r.data.productCode))] } } })).map((p) => [
        p.productCode.toUpperCase(),
        p,
      ]),
    );

    let createdCount = 0;
    const topicCreated: string[] = [];
    await prisma.$transaction(
      async (tx) => {
        const topicCache = new Map<string, string>();
        const resolveTopic = async (productId: string, parentId: string | null, name: string) => {
          const key = `${productId}|${parentId ?? ''}|${name.toLowerCase()}`;
          if (topicCache.has(key)) return topicCache.get(key)!;
          let topic = await tx.productTopic.findFirst({
            where: { productId, parentId, deletedAt: null, name: { equals: name, mode: 'insensitive' } },
          });
          if (!topic) {
            const sequence = (await tx.productTopic.count({ where: { productId, parentId, deletedAt: null } })) + 1;
            topic = await tx.productTopic.create({ data: { productId, parentId, name, sequence } });
            topicCreated.push(parentId ? `subtopic ${name}` : `topic ${name}`);
          }
          topicCache.set(key, topic.id);
          return topic.id;
        };

        for (const row of valid) {
          const d = row.data;
          const product = products.get(d.productCode)!;
          const topicId = await resolveTopic(product.id, null, d.topic);
          const subTopicId = d.subtopic ? await resolveTopic(product.id, topicId, d.subtopic) : null;
          const options = d.options
            .map((text, i) => ({ text: (text ?? '').trim(), code: OPTION_CODES[i] }))
            .filter((o) => o.text)
            .map((o, i) => ({ optionCode: o.code, optionText: o.text, isCorrect: o.code === d.correctAnswer, sequence: i + 1 }));
          await tx.question.create({
            data: {
              productId: product.id,
              topicId,
              subTopicId,
              questionText: d.question,
              questionType: 'MCQ_SINGLE',
              difficultyLevel: d.difficulty,
              marks: Number(d.marks),
              negativeMarks: Number(d.negativeMarks),
              explanation: d.explanation || null,
              status,
              contentHash: questionContentHash(product.id, d.question),
              createdById: ctx.user.id,
              options: { create: options },
            },
          });
          createdCount++;
        }
      },
      { timeout: 120_000 },
    );

    await auditService.log(ctx, 'QUESTIONS_BULK_UPLOADED', 'Question', null, undefined, {
      created: createdCount,
      skipped: preview.rows.length - valid.length,
      topicsCreated: topicCreated,
    });
    return {
      created: createdCount,
      skipped: preview.rows.length - valid.length,
      topicsCreated: topicCreated,
      errors: preview.rows.filter((r) => r.errors.length).map((r) => ({ rowNumber: r.rowNumber, errors: r.errors })),
    };
  },
};
