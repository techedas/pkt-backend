import type { AssessmentStatus, Prisma } from '@prisma/client';
import type { z } from 'zod';
import { prisma, type Tx } from '../config/database';
import {
  effectiveAssessmentStatus,
  FROZEN_ASSESSMENT_FIELDS,
  OPERATIONAL_ASSESSMENT_FIELDS,
} from '../models/assessmentStatus';
import {
  planAllocation,
  ruleMatches,
  selectDynamicQuestions,
  SelectionError,
  type DifficultyDistribution,
  type SelectionRule,
} from '../models/questionSelection';
import {
  assessmentDetailInclude,
  assessmentRepository,
  distributionToObject,
  distributionToRows,
  latestVersion,
  versionDetailInclude,
  type AssessmentDetail,
} from '../repositories/assessment.repository';
import type { RequestContext } from '../types/auth';
import { AppError } from '../utils/errors';
import { round2 } from '../utils/helpers';
import { buildPagination, resolveSort, toSkipTake, type PageQuery } from '../utils/pagination';
import type { createAssessmentSchema, ruleSchema, updateAssessmentSchema } from '../validators/assessment.validator';
import { auditService } from './audit.service';
import { scopeService } from './scope.service';
import { nextSequence } from './sequence.service';
import { settingsService } from './settings.service';

type CreateInput = z.infer<typeof createAssessmentSchema>;
type UpdateInput = z.infer<typeof updateAssessmentSchema>;
type RuleInput = z.infer<typeof ruleSchema>;

const SORT = ['createdAt', 'assessmentName', 'assessmentCode', 'startDate', 'endDate', 'status'] as const;

function toAssessmentDto(a: AssessmentDetail, now = new Date()) {
  const { _count, questions, rules, difficultyDistribution, ...rest } = a;
  return {
    ...rest,
    difficultyDistribution: distributionToObject(difficultyDistribution),
    effectiveStatus: effectiveAssessmentStatus(a, now),
    assignmentCount: _count.assignments,
    attemptCount: _count.attempts,
    versionCount: _count.versions,
    questions: questions.map((aq) => ({
      id: aq.question.id,
      questionNo: aq.question.questionNo,
      questionCode: `Q${aq.question.questionNo}`,
      questionText: aq.question.questionText,
      difficultyLevel: aq.question.difficultyLevel,
      marks: aq.question.marks,
      negativeMarks: aq.question.negativeMarks,
      status: aq.question.deletedAt ? 'DELETED' : aq.question.status,
      topic: aq.question.topic,
      subTopic: aq.question.subTopic,
      sequence: aq.sequence,
    })),
    rules: rules.map((r) => ({
      id: r.id,
      topicId: r.topicId,
      topic: r.topic,
      subTopicId: r.subTopicId,
      subTopic: r.subTopic,
      difficultyLevel: r.difficultyLevel,
      questionCount: r.questionCount,
      sequence: r.sequence,
    })),
  };
}

const ruleLabel = (r: { topic?: { name: string } | null; subTopic?: { name: string } | null; difficultyLevel?: string | null }, i: number) =>
  [r.topic?.name ?? 'Any topic', r.subTopic?.name, r.difficultyLevel].filter(Boolean).join(' / ') || `Rule ${i + 1}`;

async function assertRuleTopics(productId: string, rules: RuleInput[]) {
  const ids = rules.flatMap((r) => [r.topicId, r.subTopicId]).filter(Boolean) as string[];
  if (!ids.length) return;
  const topics = await prisma.productTopic.findMany({ where: { id: { in: ids }, deletedAt: null } });
  const byId = new Map(topics.map((t) => [t.id, t]));
  for (const r of rules) {
    if (r.topicId) {
      const t = byId.get(r.topicId);
      if (!t || t.productId !== productId || t.parentId) throw AppError.badRequest('A rule refers to a topic outside this product.', 'INVALID_RULE');
    }
    if (r.subTopicId) {
      const s = byId.get(r.subTopicId);
      if (!s || s.productId !== productId || !s.parentId) throw AppError.badRequest('A rule refers to an invalid subtopic.', 'INVALID_RULE');
      if (r.topicId && s.parentId !== r.topicId) throw AppError.badRequest('A rule subtopic does not belong to its topic.', 'INVALID_RULE');
    }
  }
}

async function assertManualQuestions(productId: string, questionIds: string[]) {
  if (new Set(questionIds).size !== questionIds.length) throw AppError.badRequest('A question was selected more than once.', 'DUPLICATE_SELECTION');
  if (!questionIds.length) return;
  const found = await prisma.question.findMany({ where: { id: { in: questionIds }, deletedAt: null }, select: { id: true, productId: true } });
  if (found.length !== questionIds.length) throw AppError.badRequest('One or more selected questions no longer exist.', 'INVALID_QUESTION');
  if (found.some((q) => q.productId !== productId)) {
    throw AppError.badRequest('All selected questions must belong to the assessment product.', 'INVALID_QUESTION');
  }
}

async function generateCode(productId: string) {
  const product = await prisma.product.findUniqueOrThrow({ where: { id: productId } });
  const year = new Date().getFullYear();
  const seq = await nextSequence(`ASSESSMENT-${product.productCode}-${year}`);
  return `${product.productCode}-${year}-${String(seq).padStart(3, '0')}`;
}

/** Total marks: exact for MANUAL, estimated from the eligible pool for DYNAMIC. */
async function computeTotals(productId: string, mode: 'MANUAL' | 'DYNAMIC', questionIds: string[], rules: RuleInput[]) {
  if (mode === 'MANUAL') {
    const qs = await prisma.question.findMany({ where: { id: { in: questionIds } }, select: { marks: true } });
    return { totalQuestions: questionIds.length, totalMarks: round2(qs.reduce((s, q) => s + q.marks, 0)) };
  }
  const pool = await assessmentRepository.loadPool(productId);
  let marks = 0;
  for (const r of rules) {
    const eligible = pool.filter((q) => ruleMatches(r, q));
    const avg = eligible.length ? eligible.reduce((s, q) => s + q.marks, 0) / eligible.length : 1;
    marks += avg * r.questionCount;
  }
  return { totalQuestions: rules.reduce((s, r) => s + r.questionCount, 0), totalMarks: round2(marks) };
}

/**
 * Record the assessment's current configuration as a new immutable version
 * (called on publish and when a published assessment's operational fields change).
 */
async function createVersion(tx: Tx, assessmentId: string, publishedById: string | null, changeNote: string) {
  const a = await tx.assessment.findUniqueOrThrow({
    where: { id: assessmentId },
    include: {
      product: true,
      questions: { orderBy: { sequence: 'asc' } },
      rules: { orderBy: { sequence: 'asc' } },
      difficultyDistribution: true,
    },
  });
  const previous = await latestVersion(assessmentId, tx);
  return tx.assessmentVersion.create({
    data: {
      assessmentId,
      versionNumber: (previous?.versionNumber ?? 0) + 1,
      publishedById,
      changeNote,
      assessmentCode: a.assessmentCode,
      assessmentName: a.assessmentName,
      productId: a.productId,
      productCode: a.product.productCode,
      productName: a.product.productName,
      selectionMode: a.selectionMode,
      totalQuestions: a.totalQuestions,
      totalMarks: a.totalMarks,
      passingPercentage: a.passingPercentage,
      durationMinutes: a.durationMinutes,
      startDate: a.startDate,
      endDate: a.endDate,
      maxAttempts: a.maxAttempts,
      reattemptPolicy: a.reattemptPolicy,
      reattemptSameQuestions: a.reattemptSameQuestions,
      randomizeQuestions: a.randomizeQuestions,
      randomizeOptions: a.randomizeOptions,
      allowPreviousQuestion: a.allowPreviousQuestion,
      allowQuestionNavigation: a.allowQuestionNavigation,
      showResultImmediately: a.showResultImmediately,
      showCorrectAnswers: a.showCorrectAnswers,
      showExplanation: a.showExplanation,
      negativeMarkingEnabled: a.negativeMarkingEnabled,
      autoSubmitOnTimeout: a.autoSubmitOnTimeout,
      certificationEnabled: a.certificationEnabled,
      certificationValidityDays: a.certificationValidityDays,
      questions: { create: a.questions.map((q) => ({ questionId: q.questionId, sequence: q.sequence })) },
      rules: {
        create: a.rules.map((r) => ({
          topicId: r.topicId,
          subTopicId: r.subTopicId,
          difficultyLevel: r.difficultyLevel,
          questionCount: r.questionCount,
          sequence: r.sequence,
        })),
      },
      distribution: { create: a.difficultyDistribution.map((d) => ({ difficultyLevel: d.difficultyLevel, questionCount: d.questionCount })) },
    },
  });
}

type VersionDetail = Prisma.AssessmentVersionGetPayload<{ include: typeof versionDetailInclude }>;

function toVersionDto(v: VersionDetail) {
  const { questions, rules, distribution, ...rest } = v;
  return {
    ...rest,
    difficultyDistribution: distributionToObject(distribution),
    questions: questions.map((q) => ({
      questionId: q.questionId,
      sequence: q.sequence,
      questionCode: `Q${q.question.questionNo}`,
      questionText: q.question.questionText,
      difficultyLevel: q.question.difficultyLevel,
      marks: q.question.marks,
    })),
    rules: rules.map((r) => ({
      topicId: r.topicId,
      topic: r.topic,
      subTopicId: r.subTopicId,
      subTopic: r.subTopic,
      difficultyLevel: r.difficultyLevel,
      questionCount: r.questionCount,
      sequence: r.sequence,
    })),
  };
}

export const assessmentService = {
  /** Persist date-driven status transitions (also run by the scheduler). */
  async syncStatuses(now = new Date()) {
    const [expired, activated, scheduled] = await prisma.$transaction([
      prisma.assessment.updateMany({
        where: { deletedAt: null, status: { in: ['PUBLISHED', 'ACTIVE'] }, endDate: { lt: now } },
        data: { status: 'EXPIRED' },
      }),
      prisma.assessment.updateMany({
        where: {
          deletedAt: null,
          status: { in: ['PUBLISHED', 'EXPIRED'] },
          publishedAt: { not: null },
          OR: [{ startDate: null }, { startDate: { lte: now } }],
          AND: [{ OR: [{ endDate: null }, { endDate: { gte: now } }] }],
        },
        data: { status: 'ACTIVE' },
      }),
      prisma.assessment.updateMany({
        where: { deletedAt: null, status: 'ACTIVE', startDate: { gt: now } },
        data: { status: 'PUBLISHED' },
      }),
    ]);
    return { expired: expired.count, activated: activated.count, scheduled: scheduled.count };
  },

  async list(ctx: RequestContext, q: PageQuery & { productId?: string; status?: AssessmentStatus; selectionMode?: 'MANUAL' | 'DYNAMIC' }) {
    await this.syncStatuses();
    const where: Prisma.AssessmentWhereInput = {
      deletedAt: null,
      ...scopeService.productFilter(ctx.user),
      ...(q.productId ? { productId: q.productId } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.selectionMode ? { selectionMode: q.selectionMode } : {}),
      ...(q.search
        ? {
            OR: [
              { assessmentName: { contains: q.search, mode: 'insensitive' } },
              { assessmentCode: { contains: q.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const sortBy = resolveSort(q.sortBy, SORT, 'createdAt');
    const [rows, total] = await Promise.all([
      prisma.assessment.findMany({
        where,
        orderBy: { [sortBy]: q.sortOrder },
        ...toSkipTake(q),
        include: {
          product: { select: { id: true, productCode: true, productName: true } },
          createdBy: { select: { id: true, firstName: true, lastName: true } },
          _count: { select: { assignments: { where: { status: 'ACTIVE' } }, attempts: true } },
        },
      }),
      prisma.assessment.count({ where }),
    ]);
    const now = new Date();
    return {
      rows: rows.map(({ _count, ...a }) => ({
        ...a,
        effectiveStatus: effectiveAssessmentStatus(a, now),
        assignmentCount: _count.assignments,
        attemptCount: _count.attempts,
      })),
      pagination: buildPagination(q, total),
    };
  },

  async get(ctx: RequestContext, id: string) {
    const a = await assessmentRepository.findDetail(id);
    if (!a) throw AppError.notFound('Assessment');
    scopeService.assertProductAccess(ctx.user, a.productId);
    return toAssessmentDto(a);
  },

  async create(ctx: RequestContext, input: CreateInput) {
    scopeService.assertProductAccess(ctx.user, input.productId);
    const product = await prisma.product.findFirst({ where: { id: input.productId, deletedAt: null } });
    if (!product) throw AppError.notFound('Product');

    const settings = await settingsService.getAll();
    const code = input.assessmentCode ?? (await generateCode(input.productId));
    if (await prisma.assessment.findUnique({ where: { assessmentCode: code } })) {
      throw AppError.conflict(`Assessment code ${code} already exists.`, 'DUPLICATE_ASSESSMENT');
    }
    const questionIds = input.questionIds ?? [];
    const rules = input.rules ?? [];
    if (input.selectionMode === 'MANUAL') await assertManualQuestions(input.productId, questionIds);
    else await assertRuleTopics(input.productId, rules);
    const totals = await computeTotals(input.productId, input.selectionMode, questionIds, rules);

    const { questionIds: _q, rules: _r, difficultyDistribution, ...fields } = input;
    const assessment = await prisma.assessment.create({
      data: {
        ...fields,
        assessmentCode: code,
        totalQuestions: totals.totalQuestions || input.totalQuestions || 0,
        totalMarks: totals.totalMarks,
        passingPercentage: input.passingPercentage ?? settings.defaultPassingPercentage,
        durationMinutes: input.durationMinutes ?? settings.defaultDurationMinutes,
        maxAttempts: input.maxAttempts ?? settings.maxTestAttempts,
        showResultImmediately: input.showResultImmediately ?? settings.resultVisibility.showResultImmediately,
        showCorrectAnswers: input.showCorrectAnswers ?? settings.resultVisibility.showCorrectAnswers,
        showExplanation: input.showExplanation ?? settings.resultVisibility.showExplanation,
        certificationValidityDays: input.certificationEnabled
          ? input.certificationValidityDays ?? settings.certificationValidityDays
          : input.certificationValidityDays ?? null,
        difficultyDistribution:
          input.selectionMode === 'DYNAMIC' ? { create: distributionToRows(difficultyDistribution) } : undefined,
        status: 'DRAFT',
        createdById: ctx.user.id,
        questions:
          input.selectionMode === 'MANUAL' ? { create: questionIds.map((questionId, i) => ({ questionId, sequence: i + 1 })) } : undefined,
        rules:
          input.selectionMode === 'DYNAMIC'
            ? {
                create: rules.map((r, i) => ({
                  topicId: r.topicId ?? null,
                  subTopicId: r.subTopicId ?? null,
                  difficultyLevel: r.difficultyLevel ?? null,
                  questionCount: r.questionCount,
                  sequence: i + 1,
                })),
              }
            : undefined,
      },
      include: assessmentDetailInclude,
    });
    await auditService.log(ctx, 'ASSESSMENT_CREATED', 'Assessment', assessment.id, undefined, { assessmentCode: code, ...fields });
    return toAssessmentDto(assessment);
  },

  /**
   * DRAFT assessments are fully editable. Once published, the scoring configuration,
   * questions and rules are frozen; only operational fields (name, description,
   * instructions, end date) may change. Use "clone" to create a new version.
   */
  async update(ctx: RequestContext, id: string, input: UpdateInput) {
    const existing = await assessmentRepository.findDetail(id);
    if (!existing) throw AppError.notFound('Assessment');
    scopeService.assertProductAccess(ctx.user, existing.productId);
    if (input.productId) scopeService.assertProductAccess(ctx.user, input.productId);

    if (existing.status !== 'DRAFT') {
      const blocked = Object.keys(input).filter(
        (k) =>
          (input as Record<string, unknown>)[k] !== undefined &&
          !(OPERATIONAL_ASSESSMENT_FIELDS as readonly string[]).includes(k) &&
          ((FROZEN_ASSESSMENT_FIELDS as readonly string[]).includes(k) || k === 'questionIds' || k === 'rules'),
      );
      if (blocked.length) {
        throw AppError.conflict(
          `This assessment is ${existing.status.toLowerCase()} and its configuration is locked (${blocked.join(', ')}). Clone it to create a new version.`,
          'ASSESSMENT_LOCKED',
        );
      }
      const data: Prisma.AssessmentUpdateInput = {};
      for (const k of OPERATIONAL_ASSESSMENT_FIELDS) if (input[k] !== undefined) (data as Record<string, unknown>)[k] = input[k];
      if (input.endDate && existing.startDate && input.endDate <= existing.startDate) {
        throw AppError.badRequest('End date must be after start date.', 'VALIDATION_ERROR');
      }
      await prisma.$transaction(async (tx) => {
        await tx.assessment.update({ where: { id }, data });
        // New attempts run under the updated name / end date; earlier attempts keep their version.
        if (Object.keys(data).length) await createVersion(tx, id, ctx.user.id, `Updated ${Object.keys(data).join(', ')}`);
      });
      if (input.endDate !== undefined) await this.syncStatuses();
      await auditService.log(ctx, 'ASSESSMENT_UPDATED', 'Assessment', id, pickKeys(existing, Object.keys(data)), data);
      return this.get(ctx, id);
    }

    const productId = input.productId ?? existing.productId;
    const mode = input.selectionMode ?? existing.selectionMode;
    const questionIds = input.questionIds ?? (input.productId && input.productId !== existing.productId ? [] : existing.questions.map((q) => q.questionId));
    const rules: RuleInput[] =
      input.rules ??
      (input.productId && input.productId !== existing.productId
        ? []
        : existing.rules.map((r) => ({ topicId: r.topicId, subTopicId: r.subTopicId, difficultyLevel: r.difficultyLevel, questionCount: r.questionCount })));
    if (mode === 'MANUAL') await assertManualQuestions(productId, questionIds);
    else await assertRuleTopics(productId, rules);
    if (input.assessmentCode && input.assessmentCode !== existing.assessmentCode) {
      if (await prisma.assessment.findUnique({ where: { assessmentCode: input.assessmentCode } })) {
        throw AppError.conflict(`Assessment code ${input.assessmentCode} already exists.`, 'DUPLICATE_ASSESSMENT');
      }
    }
    const startDate = input.startDate !== undefined ? input.startDate : existing.startDate;
    const endDate = input.endDate !== undefined ? input.endDate : existing.endDate;
    if (startDate && endDate && endDate <= startDate) throw AppError.badRequest('End date must be after start date.', 'VALIDATION_ERROR');

    const totals = await computeTotals(productId, mode, questionIds, rules);
    const { questionIds: _q, rules: _r, difficultyDistribution, ...fields } = input;
    await prisma.$transaction(async (tx) => {
      await tx.assessmentQuestion.deleteMany({ where: { assessmentId: id } });
      await tx.assessmentQuestionRule.deleteMany({ where: { assessmentId: id } });
      // Distribution only applies to DYNAMIC selection; undefined leaves it unchanged.
      if (mode === 'MANUAL' || difficultyDistribution !== undefined) {
        await tx.assessmentDifficultyDistribution.deleteMany({ where: { assessmentId: id } });
        if (mode === 'DYNAMIC') {
          await tx.assessmentDifficultyDistribution.createMany({
            data: distributionToRows(difficultyDistribution).map((d) => ({ ...d, assessmentId: id })),
          });
        }
      }
      await tx.assessment.update({
        where: { id },
        data: {
          ...fields,
          totalQuestions: totals.totalQuestions,
          totalMarks: totals.totalMarks,
        },
      });
      if (mode === 'MANUAL') {
        await tx.assessmentQuestion.createMany({ data: questionIds.map((questionId, i) => ({ assessmentId: id, questionId, sequence: i + 1 })) });
      } else {
        await tx.assessmentQuestionRule.createMany({
          data: rules.map((r, i) => ({
            assessmentId: id,
            topicId: r.topicId ?? null,
            subTopicId: r.subTopicId ?? null,
            difficultyLevel: r.difficultyLevel ?? null,
            questionCount: r.questionCount,
            sequence: i + 1,
          })),
        });
      }
    });
    await auditService.log(ctx, 'ASSESSMENT_UPDATED', 'Assessment', id, pickKeys(existing, Object.keys(fields)), fields);
    return this.get(ctx, id);
  },

  /** Check a DYNAMIC rule set against the current question bank (used by the builder UI). */
  async previewRules(ctx: RequestContext, productId: string, rules: RuleInput[], distribution?: DifficultyDistribution | null) {
    scopeService.assertProductAccess(ctx.user, productId);
    await assertRuleTopics(productId, rules);
    const pool = await assessmentRepository.loadPool(productId);
    const perRule = rules.map((r) => {
      const eligible = pool.filter((q) => ruleMatches(r, q));
      return {
        ...r,
        available: eligible.length,
        availableByDifficulty: {
          EASY: eligible.filter((q) => q.difficultyLevel === 'EASY').length,
          MEDIUM: eligible.filter((q) => q.difficultyLevel === 'MEDIUM').length,
          HARD: eligible.filter((q) => q.difficultyLevel === 'HARD').length,
        },
        sufficient: eligible.length >= r.questionCount,
      };
    });
    let feasible = true;
    let message = 'The question bank can satisfy these rules.';
    let details: unknown[] = [];
    try {
      planAllocation(pool, rules, distribution);
      selectDynamicQuestions(pool, rules, distribution);
    } catch (err) {
      if (!(err instanceof SelectionError)) throw err;
      feasible = false;
      message = err.message;
      details = err.details;
    }
    return {
      feasible,
      message,
      details,
      totalQuestions: rules.reduce((s, r) => s + r.questionCount, 0),
      poolSize: pool.length,
      rules: perRule,
    };
  },

  /** Validate everything required to run the assessment. Returns a list of problems. */
  async validateForPublish(a: AssessmentDetail): Promise<string[]> {
    const problems: string[] = [];
    if (a.product.status !== 'ACTIVE') problems.push('The product is inactive.');
    if (a.endDate && a.endDate < new Date()) problems.push('The end date is in the past.');
    if (a.durationMinutes < 1) problems.push('Duration must be at least 1 minute.');
    if (a.passingPercentage < 0 || a.passingPercentage > 100) problems.push('Passing percentage must be between 0 and 100.');

    if (a.selectionMode === 'MANUAL') {
      if (!a.questions.length) problems.push('Select at least one question.');
      const inactive = a.questions.filter((q) => q.question.status !== 'ACTIVE' || q.question.deletedAt);
      if (inactive.length) {
        problems.push(`These questions are not active: ${inactive.map((q) => `Q${q.question.questionNo}`).join(', ')}.`);
      }
    } else {
      if (!a.rules.length) problems.push('Add at least one question selection rule.');
      else {
        const pool = await assessmentRepository.loadPool(a.productId);
        const rules: SelectionRule[] = a.rules.map((r, i) => ({ ...r, label: ruleLabel(r, i) }));
        const distribution = distributionToObject(a.difficultyDistribution);
        try {
          planAllocation(pool, rules, distribution);
          selectDynamicQuestions(pool, rules, distribution);
        } catch (err) {
          if (!(err instanceof SelectionError)) throw err;
          const detail = (err.details as Array<{ rule?: string; required?: number; available?: number }>)
            .filter((d) => d.rule)
            .map((d) => `${d.rule}: needs ${d.required}, ${d.available} available`)
            .join('; ');
          problems.push(`${err.message}${detail ? ` (${detail})` : ''}`);
        }
      }
    }
    return problems;
  },

  async checkReadiness(ctx: RequestContext, id: string) {
    const a = await assessmentRepository.findDetail(id);
    if (!a) throw AppError.notFound('Assessment');
    scopeService.assertProductAccess(ctx.user, a.productId);
    const problems = await this.validateForPublish(a);
    return { ready: problems.length === 0, problems };
  },

  async publish(ctx: RequestContext, id: string) {
    const a = await assessmentRepository.findDetail(id);
    if (!a) throw AppError.notFound('Assessment');
    scopeService.assertProductAccess(ctx.user, a.productId);
    if (a.status !== 'DRAFT') throw AppError.conflict('Only draft assessments can be published.', 'INVALID_STATUS');
    const problems = await this.validateForPublish(a);
    if (problems.length) throw AppError.badRequest('The assessment cannot be published yet.', 'PUBLISH_VALIDATION_FAILED', problems);

    const now = new Date();
    const status = a.startDate && a.startDate > now ? 'PUBLISHED' : 'ACTIVE';
    const version = await prisma.$transaction(async (tx) => {
      await tx.assessment.update({ where: { id }, data: { status, publishedAt: now } });
      // The frozen configuration is stored as rows in assessment_versions (+ questions, rules, distribution).
      return createVersion(tx, id, ctx.user.id, 'Published');
    });
    await auditService.log(ctx, 'ASSESSMENT_PUBLISHED', 'Assessment', id, { status: 'DRAFT' }, { status, versionNumber: version.versionNumber });
    return this.get(ctx, id);
  },

  async setStatus(ctx: RequestContext, id: string, target: 'INACTIVE' | 'ACTIVE') {
    const a = await prisma.assessment.findFirst({ where: { id, deletedAt: null } });
    if (!a) throw AppError.notFound('Assessment');
    scopeService.assertProductAccess(ctx.user, a.productId);
    if (a.status === 'DRAFT') throw AppError.conflict('Publish the assessment first.', 'INVALID_STATUS');
    let status: AssessmentStatus = 'INACTIVE';
    if (target === 'ACTIVE') {
      if (a.status !== 'INACTIVE') throw AppError.conflict('Assessment is already active.', 'INVALID_STATUS');
      status = effectiveAssessmentStatus({ ...a, status: 'ACTIVE' });
    }
    await prisma.assessment.update({ where: { id }, data: { status } });
    await auditService.log(
      ctx,
      status === 'INACTIVE' ? 'ASSESSMENT_DEACTIVATED' : 'ASSESSMENT_REACTIVATED',
      'Assessment',
      id,
      { status: a.status },
      { status },
    );
    return this.get(ctx, id);
  },

  /** Copy an assessment (any status) into a new DRAFT version. */
  async clone(ctx: RequestContext, id: string) {
    const a = await assessmentRepository.findDetail(id);
    if (!a) throw AppError.notFound('Assessment');
    scopeService.assertProductAccess(ctx.user, a.productId);
    const baseCode = a.assessmentCode.replace(/-V\d+$/, '');
    let version = a.version + 1;
    let code = `${baseCode}-V${version}`;
    while (await prisma.assessment.findUnique({ where: { assessmentCode: code } })) code = `${baseCode}-V${++version}`;

    const copy = await prisma.assessment.create({
      data: {
        assessmentCode: code,
        assessmentName: `${a.assessmentName} (v${version})`,
        description: a.description,
        instructions: a.instructions,
        productId: a.productId,
        assessmentType: a.assessmentType,
        selectionMode: a.selectionMode,
        totalQuestions: a.totalQuestions,
        totalMarks: a.totalMarks,
        passingPercentage: a.passingPercentage,
        durationMinutes: a.durationMinutes,
        maxAttempts: a.maxAttempts,
        reattemptPolicy: a.reattemptPolicy,
        reattemptSameQuestions: a.reattemptSameQuestions,
        randomizeQuestions: a.randomizeQuestions,
        randomizeOptions: a.randomizeOptions,
        allowPreviousQuestion: a.allowPreviousQuestion,
        allowQuestionNavigation: a.allowQuestionNavigation,
        showResultImmediately: a.showResultImmediately,
        showCorrectAnswers: a.showCorrectAnswers,
        showExplanation: a.showExplanation,
        negativeMarkingEnabled: a.negativeMarkingEnabled,
        autoSubmitOnTimeout: a.autoSubmitOnTimeout,
        certificationEnabled: a.certificationEnabled,
        certificationValidityDays: a.certificationValidityDays,
        difficultyDistribution: {
          create: a.difficultyDistribution.map((d) => ({ difficultyLevel: d.difficultyLevel, questionCount: d.questionCount })),
        },
        version,
        status: 'DRAFT',
        createdById: ctx.user.id,
        questions: { create: a.questions.map((q) => ({ questionId: q.questionId, sequence: q.sequence })) },
        rules: {
          create: a.rules.map((r) => ({
            topicId: r.topicId,
            subTopicId: r.subTopicId,
            difficultyLevel: r.difficultyLevel,
            questionCount: r.questionCount,
            sequence: r.sequence,
          })),
        },
      },
    });
    await auditService.log(ctx, 'ASSESSMENT_CLONED', 'Assessment', copy.id, { sourceId: id }, { assessmentCode: code });
    return this.get(ctx, copy.id);
  },

  async remove(ctx: RequestContext, id: string) {
    const a = await prisma.assessment.findFirst({ where: { id, deletedAt: null } });
    if (!a) throw AppError.notFound('Assessment');
    scopeService.assertProductAccess(ctx.user, a.productId);
    if (a.status !== 'DRAFT') throw AppError.conflict('Only draft assessments can be deleted. Deactivate it instead.', 'INVALID_STATUS');
    await prisma.assessment.update({ where: { id }, data: { deletedAt: new Date(), assessmentCode: `${a.assessmentCode}.deleted.${Date.now()}` } });
    await auditService.log(ctx, 'ASSESSMENT_DELETED', 'Assessment', id, { assessmentCode: a.assessmentCode }, undefined);
  },

  // -------------------------------------------------------------------------
  // Difficulty distribution (assessment_difficulty_distribution)
  // -------------------------------------------------------------------------

  async getDistribution(ctx: RequestContext, id: string) {
    const a = await assessmentRepository.findDetail(id);
    if (!a) throw AppError.notFound('Assessment');
    scopeService.assertProductAccess(ctx.user, a.productId);
    return {
      assessmentId: id,
      rows: a.difficultyDistribution.map(({ difficultyLevel, questionCount }) => ({ difficultyLevel, questionCount })),
      distribution: distributionToObject(a.difficultyDistribution),
      rulesTotal: a.rules.reduce((s, r) => s + r.questionCount, 0),
    };
  },

  /** Replace the distribution of a DRAFT dynamic assessment (null / empty clears it). */
  async setDistribution(ctx: RequestContext, id: string, distribution: DifficultyDistribution | null) {
    const a = await assessmentRepository.findDetail(id);
    if (!a) throw AppError.notFound('Assessment');
    scopeService.assertProductAccess(ctx.user, a.productId);
    if (a.status !== 'DRAFT') throw AppError.conflict('The configuration of a published assessment is locked.', 'ASSESSMENT_LOCKED');
    if (a.selectionMode !== 'DYNAMIC') throw AppError.badRequest('A difficulty distribution applies only to dynamic selection.', 'INVALID_MODE');
    const rows = distributionToRows(distribution);
    const total = rows.reduce((s, r) => s + r.questionCount, 0);
    const rulesTotal = a.rules.reduce((s, r) => s + r.questionCount, 0);
    if (rows.length && rulesTotal && total !== rulesTotal) {
      throw AppError.badRequest(`The distribution totals ${total} but the rules total ${rulesTotal}.`, 'DISTRIBUTION_MISMATCH');
    }
    await prisma.$transaction([
      prisma.assessmentDifficultyDistribution.deleteMany({ where: { assessmentId: id } }),
      prisma.assessmentDifficultyDistribution.createMany({ data: rows.map((r) => ({ ...r, assessmentId: id })) }),
    ]);
    await auditService.log(ctx, 'ASSESSMENT_DISTRIBUTION_UPDATED', 'Assessment', id, distributionToObject(a.difficultyDistribution), distribution);
    return this.getDistribution(ctx, id);
  },

  // -------------------------------------------------------------------------
  // Published versions (assessment_versions)
  // -------------------------------------------------------------------------

  async listVersions(ctx: RequestContext, id: string) {
    const a = await prisma.assessment.findFirst({ where: { id, deletedAt: null }, select: { productId: true } });
    if (!a) throw AppError.notFound('Assessment');
    scopeService.assertProductAccess(ctx.user, a.productId);
    const versions = await prisma.assessmentVersion.findMany({
      where: { assessmentId: id },
      orderBy: { versionNumber: 'desc' },
      include: { _count: { select: { attempts: true, questions: true, rules: true } } },
    });
    return versions.map(({ _count, ...v }) => ({ ...v, attemptCount: _count.attempts, questionCount: _count.questions, ruleCount: _count.rules }));
  },

  async getVersion(ctx: RequestContext, id: string, versionId: string) {
    const v = await prisma.assessmentVersion.findFirst({ where: { id: versionId, assessmentId: id }, include: versionDetailInclude });
    if (!v) throw AppError.notFound('Assessment version');
    scopeService.assertProductAccess(ctx.user, v.productId);
    return toVersionDto(v);
  },

  async options(ctx: RequestContext) {
    return prisma.assessment.findMany({
      where: { deletedAt: null, status: { not: 'DRAFT' }, ...scopeService.productFilter(ctx.user) },
      select: {
        id: true,
        assessmentCode: true,
        assessmentName: true,
        status: true,
        productId: true,
        product: { select: { id: true, productName: true, status: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  },
};

function pickKeys(obj: object, keys: string[]) {
  return Object.fromEntries(keys.map((k) => [k, (obj as Record<string, unknown>)[k]]));
}
