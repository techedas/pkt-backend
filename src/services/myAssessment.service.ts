import { prisma } from '../config/database';
import { effectiveAssessmentStatus } from '../models/assessmentStatus';
import { computeUserAssessmentState, isPastDeadline } from '../models/attemptRules';
import type { RequestContext } from '../types/auth';
import { AppError } from '../utils/errors';
import { assignmentsWhereForUser, effectiveDueDate, loadAssignmentUser } from './assignmentResolver';
import { attemptService, timeoutStatus } from './attempt.service';

/** Close attempts of this user whose timer ran out, so every screen shows final state. */
async function settleOverdue(userId: string) {
  const overdue = await prisma.assessmentAttempt.findMany({
    where: { userId, status: { in: ['STARTED', 'IN_PROGRESS'] }, deadline: { lt: new Date() } },
    select: { id: true, deadline: true, version: { select: { autoSubmitOnTimeout: true } } },
  });
  for (const a of overdue.filter((x) => isPastDeadline(x.deadline))) {
    await attemptService.finalize(a.id, timeoutStatus(a.version));
  }
}

export const myAssessmentService = {
  list(ctx: RequestContext) {
    return this.listForUser(ctx.user.id);
  },

  /** Assigned assessments of any user with their derived state (also used by reports). */
  async listForUser(userId: string) {
    await settleOverdue(userId);
    const user = await loadAssignmentUser(userId);
    const assignments = await prisma.assessmentAssignment.findMany({
      where: {
        ...assignmentsWhereForUser(user),
        status: 'ACTIVE',
        assessment: {
          deletedAt: null,
          status: { not: 'DRAFT' },
          product: { status: 'ACTIVE', deletedAt: null },
        },
      },
      include: {
        assessment: {
          include: {
            product: { select: { id: true, productCode: true, productName: true, status: true } },
          },
        },
      },
    });
    const byAssessment = new Map<string, typeof assignments>();
    for (const a of assignments) byAssessment.set(a.assessmentId, [...(byAssessment.get(a.assessmentId) ?? []), a]);

    const attempts = await prisma.assessmentAttempt.findMany({
      where: { userId, assessmentId: { in: [...byAssessment.keys()] } },
      orderBy: { attemptNumber: 'asc' },
    });
    const now = new Date();

    const rows = [...byAssessment.values()].map((group) => {
      const a = group[0].assessment;
      const dueDate = effectiveDueDate(group);
      const own = attempts.filter((t) => t.assessmentId === a.id);
      const effectiveStatus = effectiveAssessmentStatus(a, now);
      const state = computeUserAssessmentState({ ...a, effectiveStatus, productStatus: a.product.status }, own, dueDate, now);
      return {
        assessmentId: a.id,
        assessmentCode: a.assessmentCode,
        assessmentName: a.assessmentName,
        product: a.product,
        totalQuestions: a.totalQuestions,
        totalMarks: a.totalMarks,
        durationMinutes: a.durationMinutes,
        passingPercentage: a.passingPercentage,
        startDate: a.startDate,
        endDate: a.endDate,
        dueDate,
        assignedAt: group.reduce((min, g) => (g.assignedAt < min ? g.assignedAt : min), group[0].assignedAt),
        maxAttempts: a.maxAttempts,
        certificationEnabled: a.certificationEnabled,
        assessmentStatus: effectiveStatus,
        ...state,
      };
    });

    const order = { IN_PROGRESS: 0, NOT_STARTED: 1, FAILED: 2, COMPLETED: 3, PASSED: 4, EXPIRED: 5 } as const;
    rows.sort((x, y) => order[x.status] - order[y.status] || (x.dueDate?.getTime() ?? Infinity) - (y.dueDate?.getTime() ?? Infinity));
    return rows;
  },

  async dashboard(ctx: RequestContext) {
    const rows = await this.list(ctx);
    const certifications = await prisma.certificate.count({
      where: { userId: ctx.user.id, status: 'ACTIVE', OR: [{ expiryDate: null }, { expiryDate: { gt: new Date() } }] },
    });
    return {
      summary: {
        totalAssigned: rows.length,
        pending: rows.filter((r) => r.status === 'NOT_STARTED' || r.status === 'IN_PROGRESS').length,
        completed: rows.filter((r) => ['COMPLETED', 'PASSED', 'FAILED'].includes(r.status)).length,
        passed: rows.filter((r) => r.status === 'PASSED').length,
        failed: rows.filter((r) => r.status === 'FAILED').length,
        expired: rows.filter((r) => r.status === 'EXPIRED').length,
        certifications,
      },
      assessments: rows,
    };
  },

  /** Everything the instructions screen needs, before the timer starts. */
  async instructions(ctx: RequestContext, assessmentId: string) {
    const a = await prisma.assessment.findUnique({
      where: { id: assessmentId, deletedAt: null },
      include: { product: { select: { id: true, status: true, productName: true } } },
    });
    if (!a) throw AppError.notFound('Assessment', 'ASSESSMENT_NOT_FOUND');
    if (a.product.status === 'INACTIVE') {
      throw AppError.forbidden(`Product "${a.product.productName}" is inactive. You cannot take assessments for inactive products.`, 'PRODUCT_INACTIVE');
    }
    const row = (await this.list(ctx)).find((r) => r.assessmentId === assessmentId);
    if (!row) throw AppError.forbidden('This assessment is not assigned to you or is not currently active.', 'NOT_ASSIGNED');
    const rules = [
      `The test has ${a.totalQuestions} questions and must be completed within ${a.durationMinutes} minutes.`,
      'The timer starts when you click START TEST and keeps running even if you close the browser.',
      'Every answer is saved as soon as you select it. You can safely refresh the page.',
      a.autoSubmitOnTimeout
        ? 'When the time runs out, your test is submitted automatically.'
        : 'When the time runs out, the attempt closes and your saved answers are evaluated.',
      a.negativeMarkingEnabled
        ? 'Negative marking applies: marks are deducted for wrong answers. Unanswered questions carry no penalty.'
        : 'There is no negative marking.',
      a.allowPreviousQuestion ? 'You can go back and change earlier answers.' : 'You cannot return to earlier questions once you move on.',
      a.allowQuestionNavigation ? 'You can jump to any question using the question palette.' : 'Questions must be answered in order.',
      `You need ${a.passingPercentage}% to pass. Allowed attempts: ${a.maxAttempts}.`,
      'Once submitted, answers cannot be changed.',
    ];
    return {
      ...row,
      description: a.description,
      instructions: a.instructions,
      negativeMarkingEnabled: a.negativeMarkingEnabled,
      allowPreviousQuestion: a.allowPreviousQuestion,
      allowQuestionNavigation: a.allowQuestionNavigation,
      showResultImmediately: a.showResultImmediately,
      rules,
    };
  },
};
