import { Prisma, type AssessmentVersion, type AttemptStatus } from '@prisma/client';
import { prisma, type Tx } from '../config/database';
import { PERMISSIONS } from '../config/permissions';
import { effectiveAssessmentStatus } from '../models/assessmentStatus';
import {
  computeUserAssessmentState,
  isOpenAttempt,
  isPastDeadline,
  isResultVisible,
  OPEN_ATTEMPT_STATUSES,
  remainingSeconds,
  type AttemptConfig,
} from '../models/attemptRules';
import { scoreAttempt, topicBreakdown, type EvaluatableQuestion } from '../models/evaluation';
import { selectDynamicQuestions, SelectionError } from '../models/questionSelection';
import { activeQuestionWhere, assessmentRepository, distributionToObject, latestVersion } from '../repositories/assessment.repository';
import type { RequestContext } from '../types/auth';
import { AppError } from '../utils/errors';
import { percent, round2, shuffle } from '../utils/helpers';
import { logger } from '../utils/logger';
import { buildPagination, toSkipTake, type PageQuery } from '../utils/pagination';
import { assignmentsWhereForUser, effectiveDueDate, loadAssignmentUser } from './assignmentResolver';
import { certificateService } from './certificate.service';
import { notificationService } from './notifications/notification.service';
import { scopeService } from './scope.service';
import { classifyBand, settingsService } from './settings.service';

const LETTERS = 'ABCDEFGHIJ';

type FinalStatus = Extract<AttemptStatus, 'SUBMITTED' | 'AUTO_SUBMITTED' | 'EXPIRED'>;

/** The configuration an attempt runs under, read from its assessment_versions row. */
export function configFromVersion(v: AssessmentVersion): AttemptConfig {
  return {
    assessmentId: v.assessmentId,
    assessmentCode: v.assessmentCode,
    assessmentName: v.assessmentName,
    productId: v.productId,
    productCode: v.productCode,
    productName: v.productName,
    passingPercentage: v.passingPercentage,
    durationMinutes: v.durationMinutes,
    maxAttempts: v.maxAttempts,
    negativeMarkingEnabled: v.negativeMarkingEnabled,
    allowPreviousQuestion: v.allowPreviousQuestion,
    allowQuestionNavigation: v.allowQuestionNavigation,
    showResultImmediately: v.showResultImmediately,
    showCorrectAnswers: v.showCorrectAnswers,
    showExplanation: v.showExplanation,
    autoSubmitOnTimeout: v.autoSubmitOnTimeout,
    certificationEnabled: v.certificationEnabled,
    certificationValidityDays: v.certificationValidityDays,
    randomizeQuestions: v.randomizeQuestions,
    randomizeOptions: v.randomizeOptions,
  };
}

export const timeoutStatus = (v: Pick<AssessmentVersion, 'autoSubmitOnTimeout'>): FinalStatus => (v.autoSubmitOnTimeout ? 'AUTO_SUBMITTED' : 'EXPIRED');

const snapshotQuestionInclude = {
  options: { orderBy: { sequence: 'asc' } },
  topic: { select: { id: true, name: true } },
  subTopic: { select: { id: true, name: true } },
} satisfies Prisma.QuestionInclude;

type SnapshotSource = Prisma.QuestionGetPayload<{ include: typeof snapshotQuestionInclude }>;

interface SnapshotOptionInput {
  sourceOptionId: string | null;
  optionCode: string;
  optionText: string;
  isCorrect: boolean;
}

/** A question frozen for an attempt: its attempt_questions row plus its attempt_question_options rows. */
interface QuestionSnapshot {
  question: Omit<Prisma.AttemptQuestionUncheckedCreateInput, 'attemptId' | 'sequence' | 'options' | 'answer'>;
  options: SnapshotOptionInput[];
}

function buildSnapshot(q: SnapshotSource): QuestionSnapshot {
  return {
    question: {
      questionId: q.id,
      questionNo: q.questionNo,
      questionText: q.questionText,
      questionType: q.questionType,
      difficultyLevel: q.difficultyLevel,
      topicId: q.topic.id,
      topicName: q.topic.name,
      subTopicId: q.subTopic?.id ?? null,
      subTopicName: q.subTopic?.name ?? null,
      marks: q.marks,
      negativeMarks: q.negativeMarks,
      explanation: q.explanation,
    },
    options: q.options.map((o) => ({ sourceOptionId: o.id, optionCode: o.optionCode, optionText: o.optionText, isCorrect: o.isCorrect })),
  };
}

const attemptQuestionWithOptions = {
  options: { orderBy: { displayOrder: 'asc' } },
} satisfies Prisma.AttemptQuestionInclude;

type AttemptQuestionWithOptions = Prisma.AttemptQuestionGetPayload<{ include: typeof attemptQuestionWithOptions }>;

function toEvaluatable(q: AttemptQuestionWithOptions): EvaluatableQuestion {
  return {
    questionId: q.questionId,
    questionType: q.questionType,
    marks: q.marks,
    negativeMarks: q.negativeMarks,
    correctOptionIds: q.options.filter((o) => o.isCorrect).map((o) => o.id),
    topicId: q.topicId,
    topicName: q.topicName,
    difficultyLevel: q.difficultyLevel,
  };
}

function attemptSummary(a: {
  id: string;
  assessmentId: string;
  attemptNumber: number;
  status: AttemptStatus;
  startTime: Date;
  deadline: Date;
  totalQuestions: number;
  version: AssessmentVersion;
}) {
  const now = new Date();
  return {
    attemptId: a.id,
    assessmentId: a.assessmentId,
    assessmentName: a.version.assessmentName,
    productName: a.version.productName,
    attemptNumber: a.attemptNumber,
    status: a.status,
    startTime: a.startTime,
    deadline: a.deadline,
    serverTime: now,
    remainingSeconds: remainingSeconds(a.deadline, now),
    totalQuestions: a.totalQuestions,
  };
}

/** Insert the questions and their option snapshots for a new attempt. */
async function writeSnapshots(tx: Tx, attemptId: string, snapshots: QuestionSnapshot[], randomizeOptions: boolean) {
  for (const [i, s] of snapshots.entries()) {
    const options = randomizeOptions ? shuffle(s.options) : s.options;
    await tx.attemptQuestion.create({
      data: {
        ...s.question,
        attemptId,
        sequence: i + 1,
        options: { create: options.map((o, displayOrder) => ({ ...o, displayOrder })) },
      },
    });
  }
}

export const attemptService = {
  /**
   * Start (or resume) an attempt. Enforces assignment, availability window,
   * due date, maximum attempts and reattempt policy, then freezes the
   * question set for the attempt under the latest published version.
   */
  async start(ctx: RequestContext, assessmentId: string) {
    const userId = ctx.user.id;
    const assessment = await prisma.assessment.findFirst({
      where: { id: assessmentId, deletedAt: null },
      include: { product: { select: { id: true, status: true, productName: true } } },
    });
    if (!assessment) throw AppError.notFound('Assessment', 'ASSESSMENT_NOT_FOUND');
    if (assessment.product.status === 'INACTIVE') {
      throw AppError.forbidden(`Product "${assessment.product.productName}" is inactive. Tests cannot be started or continued for inactive products.`, 'PRODUCT_INACTIVE');
    }

    const user = await loadAssignmentUser(userId);
    const assignments = await prisma.assessmentAssignment.findMany({
      where: { assessmentId, status: 'ACTIVE', ...assignmentsWhereForUser(user) },
    });
    if (!assignments.length) throw AppError.forbidden('This assessment is not assigned to you or the assignment is inactive.', 'NOT_ASSIGNED');

    // Close any attempt whose time ran out before deciding what to do next.
    const listAttempts = () =>
      prisma.assessmentAttempt.findMany({ where: { assessmentId, userId }, orderBy: { attemptNumber: 'asc' }, include: { version: true } });
    let attempts = await listAttempts();
    for (const t of attempts.filter((x) => isOpenAttempt(x.status) && isPastDeadline(x.deadline))) {
      await this.finalize(t.id, timeoutStatus(t.version));
    }
    attempts = await listAttempts();

    const open = attempts.find((t) => isOpenAttempt(t.status));
    if (open) return { ...attemptSummary(open), resumed: true };

    const now = new Date();
    const state = computeUserAssessmentState(
      { ...assessment, effectiveStatus: effectiveAssessmentStatus(assessment, now), productStatus: assessment.product.status },
      attempts,
      effectiveDueDate(assignments),
      now,
    );
    if (!state.canStart) {
      const code = state.blockedCode ?? 'CANNOT_START';
      throw new AppError(code, state.blockedReason ?? 'This assessment cannot be started.', code === 'MAX_ATTEMPTS_REACHED' || code === 'ALREADY_PASSED' ? 409 : 400);
    }

    const version = await latestVersion(assessmentId);
    if (!version) throw AppError.badRequest('This assessment has not been published.', 'ASSESSMENT_NOT_AVAILABLE');

    const snapshots = await this.buildQuestionSet(version, attempts[0]?.id ?? null);
    const ordered = version.randomizeQuestions ? shuffle(snapshots) : snapshots;
    const totalMarks = round2(ordered.reduce((s, q) => s + q.question.marks, 0));

    // The timer never runs past the assessment end date.
    const byDuration = now.getTime() + version.durationMinutes * 60_000;
    const deadline = new Date(assessment.endDate ? Math.min(byDuration, assessment.endDate.getTime()) : byDuration);

    try {
      const attempt = await prisma.$transaction(
        async (tx) => {
          const created = await tx.assessmentAttempt.create({
            data: {
              assessmentId,
              userId,
              assessmentVersionId: version.id,
              attemptNumber: attempts.length + 1,
              startTime: now,
              deadline,
              totalQuestions: ordered.length,
              unansweredQuestions: ordered.length,
              totalMarks,
              status: 'STARTED',
            },
            include: { version: true },
          });
          await writeSnapshots(tx, created.id, ordered, version.randomizeOptions);
          return created;
        },
        { timeout: 30_000 },
      );
      return { ...attemptSummary(attempt), resumed: false };
    } catch (err) {
      // Two concurrent "start" requests: the unique (assessment, user, attemptNumber) key lets only one win.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const existing = await prisma.assessmentAttempt.findFirst({
          where: { assessmentId, userId, status: { in: OPEN_ATTEMPT_STATUSES } },
          include: { version: true },
        });
        if (existing) return { ...attemptSummary(existing), resumed: true };
      }
      throw err;
    }
  },

  /** Choose and snapshot the questions for a new attempt from the published version. */
  async buildQuestionSet(version: AssessmentVersion, firstAttemptId: string | null): Promise<QuestionSnapshot[]> {
    // Reattempt with the same questions: reuse the frozen snapshot of the first attempt.
    if (version.reattemptSameQuestions && firstAttemptId) {
      const previous = await prisma.attemptQuestion.findMany({
        where: { attemptId: firstAttemptId },
        orderBy: { sequence: 'asc' },
        include: attemptQuestionWithOptions,
      });
      return previous.map(({ id: _id, attemptId: _a, sequence: _s, options, ...question }) => ({
        question,
        options: options.map((o) => ({ sourceOptionId: o.sourceOptionId, optionCode: o.optionCode, optionText: o.optionText, isCorrect: o.isCorrect })),
      }));
    }

    const [versionQuestions, rules, distribution] = await Promise.all([
      prisma.assessmentVersionQuestion.findMany({ where: { versionId: version.id }, orderBy: { sequence: 'asc' } }),
      prisma.assessmentVersionRule.findMany({ where: { versionId: version.id }, orderBy: { sequence: 'asc' } }),
      prisma.assessmentVersionDistribution.findMany({ where: { versionId: version.id } }),
    ]);

    let questionIds: string[];
    if (version.selectionMode === 'MANUAL') {
      questionIds = versionQuestions.map((q) => q.questionId);
    } else {
      const pool = await assessmentRepository.loadPool(version.productId);
      try {
        questionIds = selectDynamicQuestions(pool, rules, distributionToObject(distribution));
      } catch (err) {
        if (err instanceof SelectionError) {
          logger.error('Dynamic selection failed at attempt start', { assessmentId: version.assessmentId, err: err.message, details: err.details });
          throw AppError.conflict(
            'This assessment cannot be started right now because the question bank has changed. Please contact your administrator.',
            'INSUFFICIENT_QUESTIONS',
          );
        }
        throw err;
      }
    }

    const questions = await prisma.question.findMany({
      where: { id: { in: questionIds }, ...activeQuestionWhere(version.productId) },
      include: snapshotQuestionInclude,
    });
    if (questions.length !== questionIds.length) {
      throw AppError.conflict('Some questions in this assessment are no longer active. Please contact your administrator.', 'ASSESSMENT_CONFIG_ERROR');
    }
    const byId = new Map(questions.map((q) => [q.id, q]));
    return questionIds.map((id) => buildSnapshot(byId.get(id)!));
  },

  async loadOwnAttempt(ctx: RequestContext, attemptId: string) {
    const attempt = await prisma.assessmentAttempt.findUnique({
      where: { id: attemptId },
      include: {
        version: true,
        assessment: { include: { product: { select: { id: true, status: true, productName: true } } } },
      },
    });
    if (!attempt || attempt.userId !== ctx.user.id) throw AppError.notFound('Attempt', 'ATTEMPT_NOT_FOUND');
    if (attempt.assessment.product.status === 'INACTIVE') {
      throw AppError.forbidden(`Product "${attempt.assessment.product.productName}" is inactive. You cannot take or continue tests for inactive products.`, 'PRODUCT_INACTIVE');
    }
    return attempt;
  },

  /** If time is up, close the attempt and tell the client to move to the result screen. */
  async guardDeadline(attempt: { id: string; status: AttemptStatus; deadline: Date; version: AssessmentVersion }) {
    if (!isOpenAttempt(attempt.status)) {
      throw new AppError('ATTEMPT_ALREADY_SUBMITTED', 'This attempt has already been submitted.', 409, { attemptId: attempt.id, status: attempt.status });
    }
    if (isPastDeadline(attempt.deadline)) {
      const status = timeoutStatus(attempt.version);
      await this.finalize(attempt.id, status);
      throw new AppError('ATTEMPT_TIME_OVER', 'Time is up. Your answers have been submitted automatically.', 409, { attemptId: attempt.id, status });
    }
  },

  /** Questions for the exam screen. Correct answers and explanations are never included. */
  async getQuestions(ctx: RequestContext, attemptId: string) {
    const attempt = await this.loadOwnAttempt(ctx, attemptId);
    await this.guardDeadline(attempt);
    const cfg = configFromVersion(attempt.version);
    const [questions, answers] = await Promise.all([
      prisma.attemptQuestion.findMany({
        where: { attemptId },
        orderBy: { sequence: 'asc' },
        select: {
          questionId: true,
          sequence: true,
          questionText: true,
          questionType: true,
          marks: true,
          negativeMarks: true,
          options: { orderBy: { displayOrder: 'asc' }, select: { id: true, optionText: true } },
        },
      }),
      prisma.attemptAnswer.findMany({ where: { attemptId }, select: { questionId: true, selectedOptionId: true, markedForReview: true, updatedAt: true } }),
    ]);
    return {
      attempt: {
        ...attemptSummary(attempt),
        productCode: cfg.productCode,
        durationMinutes: cfg.durationMinutes,
        allowPreviousQuestion: cfg.allowPreviousQuestion,
        allowQuestionNavigation: cfg.allowQuestionNavigation,
        negativeMarkingEnabled: cfg.negativeMarkingEnabled,
      },
      questions: questions.map((q) => ({
        questionId: q.questionId,
        sequence: q.sequence,
        questionText: q.questionText,
        questionType: q.questionType,
        marks: q.marks,
        negativeMarks: cfg.negativeMarkingEnabled ? q.negativeMarks : 0,
        options: q.options.map((o, i) => ({ id: o.id, label: LETTERS[i], optionText: o.optionText })),
      })),
      answers,
    };
  },

  /**
   * Persist a single answer immediately. The attempt row is locked for the
   * duration so an answer can never slip in after the attempt was finalised.
   */
  async saveAnswer(
    ctx: RequestContext,
    attemptId: string,
    input: { questionId: string; selectedOptionId?: string | null; markedForReview?: boolean },
  ) {
    const attempt = await this.loadOwnAttempt(ctx, attemptId);
    await this.guardDeadline(attempt);
    const cfg = configFromVersion(attempt.version);

    const aq = await prisma.attemptQuestion.findUnique({
      where: { attemptId_questionId: { attemptId, questionId: input.questionId } },
      include: { options: { select: { id: true } } },
    });
    if (!aq) throw AppError.badRequest('This question is not part of your attempt.', 'QUESTION_NOT_IN_ATTEMPT');
    if (input.selectedOptionId && !aq.options.some((o) => o.id === input.selectedOptionId)) {
      throw AppError.badRequest('The selected option does not belong to this question.', 'INVALID_OPTION');
    }

    const saved = await prisma
      .$transaction(async (tx) => {
        const [locked] = await tx.$queryRaw<Array<{ status: AttemptStatus; deadline: Date }>>`
          SELECT status, deadline FROM assessment_attempts WHERE id = ${attemptId}::uuid FOR UPDATE`;
        if (!locked || !isOpenAttempt(locked.status)) {
          throw new AppError('ATTEMPT_ALREADY_SUBMITTED', 'This attempt has already been submitted.', 409, { attemptId });
        }
        if (isPastDeadline(locked.deadline)) {
          throw new AppError('ATTEMPT_TIME_OVER', 'Time is up. Your answers have been submitted automatically.', 409, { attemptId });
        }
        if (!cfg.allowPreviousQuestion) {
          const furthest = await tx.attemptAnswer.findFirst({
            where: { attemptId },
            orderBy: { attemptQuestion: { sequence: 'desc' } },
            select: { attemptQuestion: { select: { sequence: true } } },
          });
          if (furthest && aq.sequence < furthest.attemptQuestion.sequence) {
            throw AppError.badRequest('Going back to previous questions is not allowed in this assessment.', 'PREVIOUS_QUESTION_LOCKED');
          }
        }
        const now = new Date();
        const answer = await tx.attemptAnswer.upsert({
          where: { attemptId_questionId: { attemptId, questionId: input.questionId } },
          create: {
            attemptId,
            attemptQuestionId: aq.id,
            questionId: input.questionId,
            selectedOptionId: input.selectedOptionId ?? null,
            markedForReview: input.markedForReview ?? false,
            answeredAt: input.selectedOptionId ? now : null,
          },
          update: {
            ...(input.selectedOptionId !== undefined ? { selectedOptionId: input.selectedOptionId, answeredAt: input.selectedOptionId ? now : null } : {}),
            ...(input.markedForReview !== undefined ? { markedForReview: input.markedForReview } : {}),
          },
        });
        await tx.assessmentAttempt.update({ where: { id: attemptId }, data: { status: 'IN_PROGRESS', lastActivityAt: now } });
        return answer;
      })
      .catch(async (err) => {
        // The deadline passed while we waited for the lock: finalise, then report time-over.
        if (err instanceof AppError && err.code === 'ATTEMPT_TIME_OVER') await this.guardDeadline(attempt);
        throw err;
      });

    return {
      questionId: saved.questionId,
      selectedOptionId: saved.selectedOptionId,
      markedForReview: saved.markedForReview,
      savedAt: saved.updatedAt,
      remainingSeconds: remainingSeconds(attempt.deadline),
    };
  },

  async submit(ctx: RequestContext, attemptId: string) {
    const attempt = await this.loadOwnAttempt(ctx, attemptId);
    if (!isOpenAttempt(attempt.status)) {
      throw new AppError('ATTEMPT_ALREADY_SUBMITTED', 'This attempt has already been submitted.', 409, { attemptId });
    }
    const status: FinalStatus = isPastDeadline(attempt.deadline) ? timeoutStatus(attempt.version) : 'SUBMITTED';
    const finalized = await this.finalize(attemptId, status);
    if (!finalized) throw new AppError('ATTEMPT_ALREADY_SUBMITTED', 'This attempt has already been submitted.', 409, { attemptId });
    return { attemptId, status: finalized.status, submitTime: finalized.submitTime };
  },

  /**
   * Close and evaluate an attempt exactly once. The conditional status update
   * both claims the attempt (so double submission is impossible) and takes the
   * row lock that answer saving waits on. Returns null if already finalised.
   */
  async finalize(attemptId: string, status: FinalStatus) {
    const outcome = await prisma.$transaction(
      async (tx) => {
        const now = new Date();
        const claimed = await tx.assessmentAttempt.updateMany({
          where: { id: attemptId, status: { in: OPEN_ATTEMPT_STATUSES } },
          data: { status, submitTime: now },
        });
        if (!claimed.count) return null;

        const attempt = await tx.assessmentAttempt.findUniqueOrThrow({
          where: { id: attemptId },
          include: {
            version: true,
            questions: { include: attemptQuestionWithOptions },
            answers: { include: { selections: { select: { optionId: true } } } },
          },
        });
        const cfg = configFromVersion(attempt.version);
        const questions = attempt.questions.map(toEvaluatable);
        const answers = new Map(
          attempt.answers.map((a) => [
            a.questionId,
            { selectedOptionId: a.selectedOptionId, selectedOptionIds: a.selections.map((s) => s.optionId), answerText: a.answerText },
          ]),
        );
        const score = scoreAttempt(questions, answers, {
          negativeMarking: cfg.negativeMarkingEnabled,
          passingPercentage: cfg.passingPercentage,
        });

        const outcomeById = new Map(score.outcomes.map((o) => [o.questionId, o]));
        await Promise.all(
          attempt.answers.map((a) => {
            const o = outcomeById.get(a.questionId)!;
            return tx.attemptAnswer.update({
              where: { id: a.id },
              data: { isCorrect: o.isCorrect, marksAwarded: round2(o.marksAwarded - o.penalty) },
            });
          }),
        );

        const endedAt = Math.min(now.getTime(), attempt.deadline.getTime());
        const updated = await tx.assessmentAttempt.update({
          where: { id: attemptId },
          data: {
            durationUsed: Math.max(0, Math.round((endedAt - attempt.startTime.getTime()) / 1000)),
            totalQuestions: score.totalQuestions,
            attemptedQuestions: score.attemptedQuestions,
            correctAnswers: score.correctAnswers,
            incorrectAnswers: score.incorrectAnswers,
            unansweredQuestions: score.unansweredQuestions,
            marksObtained: score.marksObtained,
            negativeMarks: score.negativeMarks,
            totalMarks: score.totalMarks,
            percentage: score.percentage,
            result: score.result,
          },
        });

        if (score.result === 'PASS' && cfg.certificationEnabled) {
          await certificateService.issueForAttempt(tx as Tx, {
            attemptId,
            userId: attempt.userId,
            assessmentId: attempt.assessmentId,
            productId: cfg.productId,
            productCode: cfg.productCode,
            score: score.marksObtained,
            percentage: score.percentage,
            validityDays: cfg.certificationValidityDays,
          });
        }
        return { attempt: updated, cfg };
      },
      { timeout: 30_000 },
    );
    if (!outcome) return null;

    const { attempt, cfg } = outcome;
    try {
      const ref = { attemptId, assessmentName: cfg.assessmentName };
      if (cfg.showResultImmediately) {
        await notificationService.notify(
          attempt.result === 'PASS' ? 'ASSESSMENT_PASSED' : 'ASSESSMENT_FAILED',
          [attempt.userId],
          { ...ref, percentage: attempt.percentage },
          { dedupeKey: `result:${attemptId}` },
        );
        const attemptsLeft = cfg.maxAttempts - attempt.attemptNumber;
        if (attempt.result === 'FAIL' && attemptsLeft > 0) {
          await notificationService.notify(
            'REATTEMPT_AVAILABLE',
            [attempt.userId],
            { assessmentId: attempt.assessmentId, assessmentName: cfg.assessmentName, attemptsLeft },
            { dedupeKey: `reattempt:${attemptId}` },
          );
        }
      } else {
        await notificationService.notify('ASSESSMENT_COMPLETED', [attempt.userId], ref, { dedupeKey: `completed:${attemptId}` });
      }
    } catch (err) {
      logger.error('Post-submission notification failed', { attemptId, err });
    }
    return attempt;
  },

  /** Auto-submit every attempt whose deadline has passed (scheduler). */
  async finalizeOverdue() {
    const overdue = await prisma.assessmentAttempt.findMany({
      where: { status: { in: OPEN_ATTEMPT_STATUSES }, deadline: { lt: new Date(Date.now() - 5_000) } },
      select: { id: true, version: { select: { autoSubmitOnTimeout: true } } },
      take: 500,
    });
    let count = 0;
    for (const a of overdue) {
      try {
        if (await this.finalize(a.id, timeoutStatus(a.version))) count++;
      } catch (err) {
        logger.error('Auto-submit failed', { attemptId: a.id, err });
      }
    }
    return count;
  },

  /**
   * Result of an attempt. Learners see it subject to the assessment's result
   * visibility; reviewers with report access always see the full review.
   */
  async getResult(ctx: RequestContext, attemptId: string) {
    // Settle a timed-out attempt first so the result below is final.
    const head = await prisma.assessmentAttempt.findUnique({
      where: { id: attemptId },
      select: { status: true, deadline: true, version: { select: { autoSubmitOnTimeout: true } } },
    });
    if (head && isOpenAttempt(head.status) && isPastDeadline(head.deadline)) await this.finalize(attemptId, timeoutStatus(head.version));

    const attempt = await prisma.assessmentAttempt.findUnique({
      where: { id: attemptId },
      include: {
        version: true,
        questions: { orderBy: { sequence: 'asc' }, include: attemptQuestionWithOptions },
        answers: true,
        assessment: { select: { id: true, status: true, startDate: true, endDate: true, maxAttempts: true, reattemptPolicy: true, showResultImmediately: true, productId: true } },
        user: { select: { id: true, employeeId: true, firstName: true, lastName: true, department: true } },
        certificate: true,
      },
    });
    if (!attempt) throw AppError.notFound('Attempt', 'ATTEMPT_NOT_FOUND');
    const isOwner = attempt.userId === ctx.user.id;
    const isReviewer = ctx.user.permissions.has(PERMISSIONS.REPORT_READ);
    if (!isOwner) {
      if (!isReviewer) throw AppError.notFound('Attempt', 'ATTEMPT_NOT_FOUND');
      scopeService.assertProductAccess(ctx.user, attempt.assessment.productId);
      await scopeService.assertUserAccess(ctx.user, attempt.userId);
    }
    if (isOpenAttempt(attempt.status)) {
      throw new AppError('ATTEMPT_IN_PROGRESS', 'This attempt is still in progress.', 409, { attemptId });
    }

    const cfg = configFromVersion(attempt.version);
    const effectiveStatus = effectiveAssessmentStatus(attempt.assessment);
    const asReviewer = !isOwner;
    const visible = asReviewer || isResultVisible(cfg, { endDate: attempt.assessment.endDate, effectiveStatus });

    const base = {
      attemptId: attempt.id,
      assessmentId: attempt.assessmentId,
      assessmentVersionId: attempt.assessmentVersionId,
      versionNumber: attempt.version.versionNumber,
      assessmentName: cfg.assessmentName,
      assessmentCode: cfg.assessmentCode,
      productName: cfg.productName,
      productCode: cfg.productCode,
      attemptNumber: attempt.attemptNumber,
      status: attempt.status,
      startTime: attempt.startTime,
      submitTime: attempt.submitTime,
      timeTakenSeconds: attempt.durationUsed,
      user: asReviewer ? attempt.user : undefined,
    };
    if (!visible) {
      return { ...base, resultPending: true, message: 'Your answers have been submitted. Results will be available after the assessment closes.' };
    }

    const questions = attempt.questions.map(toEvaluatable);
    const answersById = new Map(attempt.answers.map((a) => [a.questionId, a]));
    const outcomes = attempt.questions.map((q) => {
      const a = answersById.get(q.questionId);
      return {
        questionId: q.questionId,
        answered: !!a?.selectedOptionId,
        isCorrect: a?.isCorrect ?? null,
        marksAwarded: Math.max(0, a?.marksAwarded ?? 0),
        penalty: Math.max(0, -(a?.marksAwarded ?? 0)),
      };
    });
    const bands = await settingsService.get('knowledgeGapThresholds');
    const topics = topicBreakdown(questions, outcomes).map((t) => ({ ...t, band: classifyBand(bands, t.percentage) }));
    const difficulty = (['EASY', 'MEDIUM', 'HARD'] as const)
      .map((d) => {
        const qs = attempt.questions.filter((q) => q.difficultyLevel === d);
        const correct = qs.filter((q) => answersById.get(q.questionId)?.isCorrect).length;
        return { difficulty: d, total: qs.length, correct, percentage: percent(correct, qs.length) };
      })
      .filter((d) => d.total > 0);

    // Reattempt eligibility for the learner.
    let reattempt: { allowed: boolean; attemptsUsed: number; attemptsLeft: number; reason: string | null } | undefined;
    if (isOwner) {
      const [all, user] = await Promise.all([
        prisma.assessmentAttempt.findMany({ where: { assessmentId: attempt.assessmentId, userId: attempt.userId } }),
        loadAssignmentUser(attempt.userId),
      ]);
      const assignments = await prisma.assessmentAssignment.findMany({ where: { assessmentId: attempt.assessmentId, ...assignmentsWhereForUser(user) } });
      const state = computeUserAssessmentState({ ...attempt.assessment, effectiveStatus }, all, effectiveDueDate(assignments));
      reattempt = {
        allowed: assignments.length > 0 && state.canStart,
        attemptsUsed: state.attemptsUsed,
        attemptsLeft: state.attemptsLeft,
        reason: assignments.length ? state.blockedReason : 'This assessment is no longer assigned to you.',
      };
    }

    const showAnswers = asReviewer || cfg.showCorrectAnswers;
    const showExplanation = asReviewer || cfg.showExplanation;
    const review = showAnswers
      ? attempt.questions.map((q) => {
          const a = answersById.get(q.questionId);
          return {
            sequence: q.sequence,
            questionId: q.questionId,
            questionNo: q.questionNo,
            questionText: q.questionText,
            topicName: q.topicName,
            subTopicName: q.subTopicName,
            difficultyLevel: q.difficultyLevel,
            marks: q.marks,
            options: q.options.map((o, i) => ({ id: o.id, label: LETTERS[i], optionText: o.optionText, isCorrect: o.isCorrect })),
            selectedOptionId: a?.selectedOptionId ?? null,
            correctOptionIds: q.options.filter((o) => o.isCorrect).map((o) => o.id),
            isCorrect: a?.isCorrect ?? null,
            marksAwarded: a?.marksAwarded ?? 0,
            markedForReview: a?.markedForReview ?? false,
            explanation: showExplanation ? q.explanation : undefined,
          };
        })
      : undefined;

    return {
      ...base,
      resultPending: false,
      totalQuestions: attempt.totalQuestions,
      attemptedQuestions: attempt.attemptedQuestions,
      correctAnswers: attempt.correctAnswers,
      incorrectAnswers: attempt.incorrectAnswers,
      unansweredQuestions: attempt.unansweredQuestions,
      marksObtained: attempt.marksObtained,
      negativeMarks: attempt.negativeMarks,
      totalMarks: attempt.totalMarks,
      percentage: attempt.percentage,
      passingPercentage: cfg.passingPercentage,
      result: attempt.result,
      negativeMarkingEnabled: cfg.negativeMarkingEnabled,
      topicBreakdown: topics,
      difficultyBreakdown: difficulty,
      certificate: attempt.certificate
        ? { id: attempt.certificate.id, certificateNumber: attempt.certificate.certificateNumber, expiryDate: attempt.certificate.expiryDate }
        : null,
      reattempt,
      showCorrectAnswers: showAnswers,
      showExplanation,
      review,
    };
  },

  /** The learner's own attempt history. */
  async history(ctx: RequestContext, q: PageQuery & { assessmentId?: string }) {
    const where: Prisma.AssessmentAttemptWhereInput = {
      userId: ctx.user.id,
      ...(q.assessmentId ? { assessmentId: q.assessmentId } : {}),
      ...(q.search ? { assessment: { assessmentName: { contains: q.search, mode: 'insensitive' } } } : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.assessmentAttempt.findMany({
        where,
        orderBy: { startTime: 'desc' },
        ...toSkipTake(q),
        include: { version: true, assessment: { select: { status: true, startDate: true, endDate: true } } },
      }),
      prisma.assessmentAttempt.count({ where }),
    ]);
    return {
      rows: rows.map((a) => {
        const cfg = configFromVersion(a.version);
        const visible = !isOpenAttempt(a.status) && isResultVisible(cfg, { endDate: a.assessment.endDate, effectiveStatus: effectiveAssessmentStatus(a.assessment) });
        return {
          attemptId: a.id,
          assessmentId: a.assessmentId,
          assessmentName: cfg.assessmentName,
          productName: cfg.productName,
          attemptNumber: a.attemptNumber,
          status: a.status,
          startTime: a.startTime,
          submitTime: a.submitTime,
          timeTakenSeconds: a.durationUsed,
          totalQuestions: a.totalQuestions,
          resultVisible: visible,
          marksObtained: visible ? a.marksObtained : null,
          totalMarks: a.totalMarks,
          percentage: visible ? a.percentage : null,
          result: visible ? a.result : null,
        };
      }),
      pagination: buildPagination(q, total),
    };
  },

  /** Option snapshot of an attempt (reviewer tool): what exactly was shown, and what was chosen. */
  async snapshot(ctx: RequestContext, attemptId: string) {
    const attempt = await prisma.assessmentAttempt.findUnique({
      where: { id: attemptId },
      include: {
        version: true,
        questions: { orderBy: { sequence: 'asc' }, include: { ...attemptQuestionWithOptions, answer: { include: { selections: true } } } },
      },
    });
    if (!attempt) throw AppError.notFound('Attempt', 'ATTEMPT_NOT_FOUND');
    scopeService.assertProductAccess(ctx.user, attempt.version.productId);
    await scopeService.assertUserAccess(ctx.user, attempt.userId);
    return {
      attemptId,
      assessmentVersionId: attempt.assessmentVersionId,
      versionNumber: attempt.version.versionNumber,
      config: configFromVersion(attempt.version),
      questions: attempt.questions.map((q) => ({
        attemptQuestionId: q.id,
        questionId: q.questionId,
        questionNo: q.questionNo,
        sequence: q.sequence,
        questionText: q.questionText,
        topicName: q.topicName,
        subTopicName: q.subTopicName,
        difficultyLevel: q.difficultyLevel,
        marks: q.marks,
        negativeMarks: q.negativeMarks,
        options: q.options.map((o) => ({
          id: o.id,
          sourceOptionId: o.sourceOptionId,
          optionCode: o.optionCode,
          optionText: o.optionText,
          isCorrect: o.isCorrect,
          displayOrder: o.displayOrder,
        })),
        answer: q.answer
          ? {
              selectedOptionId: q.answer.selectedOptionId,
              selectedOptionIds: q.answer.selections.map((s) => s.optionId),
              isCorrect: q.answer.isCorrect,
              marksAwarded: q.answer.marksAwarded,
              markedForReview: q.answer.markedForReview,
              answeredAt: q.answer.answeredAt,
            }
          : null,
      })),
    };
  },
};
