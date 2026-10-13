import type { AttemptResult, Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { effectiveAssessmentStatus } from '../models/assessmentStatus';
import { isOpenAttempt, isPastDeadline } from '../models/attemptRules';
import { reportRepository, type ReportFilter, type ReportScope } from '../repositories/report.repository';
import type { RequestContext } from '../types/auth';
import { AppError } from '../utils/errors';
import { fullName, percent, round2 } from '../utils/helpers';
import { buildPagination, resolveSort, toSkipTake, type PageQuery } from '../utils/pagination';
import { assignedUserIds, usersWhereForTarget } from './assignmentResolver';
import { myAssessmentService } from './myAssessment.service';
import { scopeService } from './scope.service';
import { classifyBand, settingsService } from './settings.service';

const CLOSED = ['SUBMITTED', 'AUTO_SUBMITTED', 'EXPIRED'] as const;

async function scopeOf(ctx: RequestContext): Promise<ReportScope> {
  return { productIds: ctx.user.productScope, userIds: await scopeService.teamUserIds(ctx.user) };
}

/** Prisma equivalent of `attemptConditions` for ORM queries. */
function attemptWhere(scope: ReportScope, f: ReportFilter & { result?: AttemptResult; search?: string }): Prisma.AssessmentAttemptWhereInput {
  return {
    status: { in: [...CLOSED] },
    ...(scope.userIds ? { userId: { in: scope.userIds } } : {}),
    ...(f.userId ? { userId: f.userId } : {}),
    ...(f.assessmentId ? { assessmentId: f.assessmentId } : {}),
    ...(f.result ? { result: f.result } : {}),
    ...(f.from || f.to ? { submitTime: { ...(f.from ? { gte: f.from } : {}), ...(f.to ? { lte: f.to } : {}) } } : {}),
    assessment: {
      ...(scope.productIds ? { productId: { in: scope.productIds } } : {}),
      ...(f.productId ? { productId: f.productId } : {}),
    },
    user: {
      ...(f.department ? { department: f.department } : {}),
      ...(f.team ? { team: f.team } : {}),
      ...(f.search
        ? {
            OR: [
              { employeeId: { contains: f.search, mode: 'insensitive' } },
              { firstName: { contains: f.search, mode: 'insensitive' } },
              { lastName: { contains: f.search, mode: 'insensitive' } },
              { email: { contains: f.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    },
  };
}

/** Assigned (assessment, user) pairs and how many have been completed. */
async function assignmentCoverage(scope: ReportScope, f: ReportFilter) {
  const assessments = await prisma.assessment.findMany({
    where: {
      deletedAt: null,
      status: { not: 'DRAFT' },
      ...(scope.productIds ? { productId: { in: scope.productIds } } : {}),
      ...(f.productId ? { productId: f.productId } : {}),
      ...(f.assessmentId ? { id: f.assessmentId } : {}),
    },
    select: { id: true },
  });
  let assigned = 0;
  let completed = 0;
  let inProgress = 0;
  for (const a of assessments) {
    let userIds = await assignedUserIds(a.id, scope.userIds);
    if (f.department || f.team) {
      const filtered = await prisma.user.findMany({
        where: { id: { in: userIds }, ...(f.department ? { department: f.department } : {}), ...(f.team ? { team: f.team } : {}) },
        select: { id: true },
      });
      userIds = filtered.map((u) => u.id);
    }
    if (!userIds.length) continue;
    assigned += userIds.length;
    const attempts = await prisma.assessmentAttempt.groupBy({
      by: ['userId', 'status'],
      where: { assessmentId: a.id, userId: { in: userIds } },
    });
    const done = new Set(attempts.filter((t) => (CLOSED as readonly string[]).includes(t.status)).map((t) => t.userId));
    const open = new Set(attempts.filter((t) => !done.has(t.userId) && isOpenAttempt(t.status)).map((t) => t.userId));
    completed += done.size;
    inProgress += open.size;
  }
  return { assigned, completed, inProgress, pending: assigned - completed };
}

export const reportService = {
  // -------------------------------------------------------------------------
  // Admin / manager dashboard
  // -------------------------------------------------------------------------
  async adminDashboard(ctx: RequestContext, f: ReportFilter) {
    const scope = await scopeOf(ctx);
    const productWhere = { deletedAt: null, ...(scope.productIds ? { id: { in: scope.productIds } } : {}) };
    const [totalUsers, activeProducts, assessments, totals, coverage, productScores, trend, departments, distribution, topics] = await Promise.all([
      prisma.user.count({ where: { deletedAt: null, status: 'ACTIVE', ...(scope.userIds ? { id: { in: scope.userIds } } : {}) } }),
      prisma.product.count({ where: { ...productWhere, status: 'ACTIVE' } }),
      prisma.assessment.findMany({
        where: { deletedAt: null, ...(scope.productIds ? { productId: { in: scope.productIds } } : {}), ...(f.productId ? { productId: f.productId } : {}) },
        select: { status: true, startDate: true, endDate: true },
      }),
      reportRepository.attemptTotals(scope, f),
      assignmentCoverage(scope, f),
      reportRepository.productScores(scope, f),
      reportRepository.monthlyTrend(scope, f),
      reportRepository.departmentPerformance(scope, f),
      reportRepository.scoreDistribution(scope, f),
      reportRepository.topicPerformance(scope, f),
    ]);
    const bands = await settingsService.get('knowledgeGapThresholds');
    const buckets = Array.from({ length: 10 }, (_, i) => ({
      range: `${i * 10}-${i === 9 ? 100 : i * 10 + 9}`,
      attempts: distribution.find((d) => d.bucket === i)?.attempts ?? 0,
    }));
    return {
      cards: {
        totalUsers,
        activeProducts,
        activeAssessments: assessments.filter((a) => effectiveAssessmentStatus(a) === 'ACTIVE').length,
        testsAssigned: coverage.assigned,
        testsCompleted: coverage.completed,
        testsPending: coverage.pending,
        testsInProgress: coverage.inProgress,
        totalAttempts: totals.attempts,
        passPercentage: percent(totals.passed, totals.attempts),
        failPercentage: percent(totals.failed, totals.attempts),
        averageScore: round2(totals.avg_pct ?? 0),
      },
      charts: {
        passVsFail: [
          { name: 'Pass', value: totals.passed },
          { name: 'Fail', value: totals.failed },
        ],
        productScores: productScores.map((p) => ({
          productId: p.product_id,
          productCode: p.product_code,
          productName: p.product_name,
          attempts: p.attempts,
          averageScore: round2(p.avg_pct),
          passRate: percent(p.passed, p.attempts),
        })),
        monthlyTrend: trend.map((t) => ({ month: t.month, attempts: t.attempts, passed: t.passed, failed: t.failed, averageScore: round2(t.avg_pct) })),
        departmentPerformance: departments.map((d) => ({
          department: d.department,
          attempts: d.attempts,
          users: d.users,
          averageScore: round2(d.avg_pct),
          passRate: percent(d.passed, d.attempts),
        })),
        scoreDistribution: buckets,
        topicPerformance: topics.map((t) => {
          const pct = percent(t.correct, t.questions);
          return { productCode: t.product_code, topicId: t.topic_id, topicName: t.topic_name, questions: t.questions, accuracy: pct, band: classifyBand(bands, pct) };
        }),
      },
    };
  },

  // -------------------------------------------------------------------------
  // Results (all completed attempts): server-side search, filter, sort, pagination
  // -------------------------------------------------------------------------
  async results(ctx: RequestContext, q: PageQuery & ReportFilter & { result?: AttemptResult }, unpaged = false) {
    const scope = await scopeOf(ctx);
    const where = attemptWhere(scope, q);
    const sortBy = resolveSort(q.sortBy, ['submitTime', 'percentage', 'marksObtained', 'attemptNumber', 'durationUsed'] as const, 'submitTime');
    const [rows, total] = await Promise.all([
      prisma.assessmentAttempt.findMany({
        where,
        orderBy: { [sortBy]: q.sortOrder },
        ...(unpaged ? { skip: 0, take: 50_000 } : toSkipTake(q)),
        include: {
          user: { select: { id: true, employeeId: true, firstName: true, lastName: true, department: true, team: true, location: true } },
          assessment: { select: { id: true, assessmentCode: true, assessmentName: true, product: { select: { productCode: true, productName: true } } } },
        },
      }),
      prisma.assessmentAttempt.count({ where }),
    ]);
    return {
      rows: rows.map((a) => ({
        attemptId: a.id,
        userId: a.userId,
        employeeId: a.user.employeeId,
        name: fullName(a.user),
        department: a.user.department,
        team: a.user.team,
        location: a.user.location,
        assessmentId: a.assessmentId,
        assessmentCode: a.assessment.assessmentCode,
        assessmentName: a.assessment.assessmentName,
        productCode: a.assessment.product.productCode,
        productName: a.assessment.product.productName,
        attemptNumber: a.attemptNumber,
        status: a.status,
        marksObtained: a.marksObtained,
        totalMarks: a.totalMarks,
        percentage: a.percentage,
        result: a.result,
        correctAnswers: a.correctAnswers,
        incorrectAnswers: a.incorrectAnswers,
        unansweredQuestions: a.unansweredQuestions,
        timeTakenSeconds: a.durationUsed,
        startTime: a.startTime,
        completionDate: a.submitTime,
      })),
      pagination: buildPagination(q, total),
    };
  },

  // -------------------------------------------------------------------------
  // Assessment report
  // -------------------------------------------------------------------------
  async assessmentReport(ctx: RequestContext, assessmentId: string) {
    const scope = await scopeOf(ctx);
    const assessment = await prisma.assessment.findFirst({
      where: { id: assessmentId, deletedAt: null },
      include: { product: { select: { id: true, productCode: true, productName: true } } },
    });
    if (!assessment) throw AppError.notFound('Assessment');
    scopeService.assertProductAccess(ctx.user, assessment.productId);

    const assigned = new Set(await assignedUserIds(assessmentId, scope.userIds));
    const attempts = await prisma.assessmentAttempt.findMany({
      where: { assessmentId, ...(scope.userIds ? { userId: { in: scope.userIds } } : {}) },
      select: { userId: true, status: true, result: true, percentage: true, durationUsed: true, deadline: true },
    });
    const population = new Set([...assigned, ...attempts.map((a) => a.userId)]);
    const perUser = new Map<string, typeof attempts>();
    for (const a of attempts) perUser.set(a.userId, [...(perUser.get(a.userId) ?? []), a]);

    let notStarted = 0;
    let inProgress = 0;
    let completed = 0;
    let passed = 0;
    let failed = 0;
    const best: number[] = [];
    for (const userId of population) {
      const list = perUser.get(userId) ?? [];
      const closed = list.filter((a) => !isOpenAttempt(a.status));
      const open = list.some((a) => isOpenAttempt(a.status) && !isPastDeadline(a.deadline));
      if (closed.length) {
        completed++;
        if (closed.some((a) => a.result === 'PASS')) passed++;
        else failed++;
        best.push(Math.max(...closed.map((a) => a.percentage)));
      } else if (open) {
        inProgress++;
      } else {
        notStarted++;
      }
    }
    const closedAll = attempts.filter((a) => !isOpenAttempt(a.status));
    const durations = closedAll.map((a) => a.durationUsed ?? 0);
    const bands = await settingsService.get('knowledgeGapThresholds');
    const topics = await reportRepository.topicPerformance(scope, { assessmentId });

    return {
      assessment: {
        id: assessment.id,
        assessmentCode: assessment.assessmentCode,
        assessmentName: assessment.assessmentName,
        product: assessment.product,
        passingPercentage: assessment.passingPercentage,
        totalQuestions: assessment.totalQuestions,
        durationMinutes: assessment.durationMinutes,
        status: effectiveAssessmentStatus(assessment),
      },
      summary: {
        totalAssigned: population.size,
        notStarted,
        inProgress,
        completed,
        passed,
        failed,
        totalAttempts: closedAll.length,
        averageScore: best.length ? round2(best.reduce((s, v) => s + v, 0) / best.length) : 0,
        highestScore: best.length ? round2(Math.max(...best)) : 0,
        lowestScore: best.length ? round2(Math.min(...best)) : 0,
        averageCompletionSeconds: durations.length ? Math.round(durations.reduce((s, v) => s + v, 0) / durations.length) : 0,
        passRate: percent(passed, completed),
      },
      topicPerformance: topics.map((t) => {
        const pct = percent(t.correct, t.questions);
        return { topicId: t.topic_id, topicName: t.topic_name, questions: t.questions, correct: t.correct, accuracy: pct, band: classifyBand(bands, pct) };
      }),
    };
  },

  // -------------------------------------------------------------------------
  // Pending assessments (assigned but not completed)
  // -------------------------------------------------------------------------
  async pending(ctx: RequestContext, q: PageQuery & ReportFilter & { overdueOnly?: boolean }, unpaged = false) {
    const scope = await scopeOf(ctx);
    const assessments = await prisma.assessment.findMany({
      where: {
        deletedAt: null,
        status: { in: ['PUBLISHED', 'ACTIVE'] },
        ...(scope.productIds ? { productId: { in: scope.productIds } } : {}),
        ...(q.productId ? { productId: q.productId } : {}),
        ...(q.assessmentId ? { id: q.assessmentId } : {}),
      },
      include: { product: { select: { productCode: true, productName: true } }, assignments: { where: { status: 'ACTIVE' } } },
    });
    const now = new Date();
    const rows: Array<Record<string, unknown> & { dueDate: Date | null; name: string }> = [];
    for (const a of assessments) {
      const userIds = await assignedUserIds(a.id, scope.userIds);
      if (!userIds.length) continue;
      const [users, attempts] = await Promise.all([
        prisma.user.findMany({
          where: {
            id: { in: userIds },
            ...(q.department ? { department: q.department } : {}),
            ...(q.team ? { team: q.team } : {}),
            ...(q.search
              ? {
                  OR: [
                    { employeeId: { contains: q.search, mode: 'insensitive' } },
                    { firstName: { contains: q.search, mode: 'insensitive' } },
                    { lastName: { contains: q.search, mode: 'insensitive' } },
                  ],
                }
              : {}),
          },
          include: { role: { select: { code: true } }, manager: { select: { firstName: true, lastName: true } } },
        }),
        prisma.assessmentAttempt.findMany({ where: { assessmentId: a.id, userId: { in: userIds } }, select: { userId: true, status: true } }),
      ]);
      for (const u of users) {
        const own = attempts.filter((t) => t.userId === u.id);
        if (own.some((t) => !isOpenAttempt(t.status))) continue;
        // The due date that applies to this user: latest among assignments that target them.
        const matching = a.assignments.filter((asg) => matchesUser(asg, u));
        const dueDate = matching.length && matching.every((m) => m.dueDate) ? new Date(Math.max(...matching.map((m) => m.dueDate!.getTime()))) : null;
        const overdue = !!dueDate && dueDate < now;
        if (q.overdueOnly && !overdue) continue;
        rows.push({
          userId: u.id,
          employeeId: u.employeeId,
          name: fullName(u),
          email: u.email,
          department: u.department,
          team: u.team,
          manager: u.manager ? fullName(u.manager) : null,
          assessmentId: a.id,
          assessmentCode: a.assessmentCode,
          assessmentName: a.assessmentName,
          productName: a.product.productName,
          status: own.some((t) => isOpenAttempt(t.status)) ? 'IN_PROGRESS' : 'NOT_STARTED',
          dueDate,
          overdue,
          endDate: a.endDate,
        });
      }
    }
    rows.sort((x, y) => (x.dueDate?.getTime() ?? Infinity) - (y.dueDate?.getTime() ?? Infinity) || x.name.localeCompare(y.name));
    const total = rows.length;
    return {
      rows: unpaged ? rows : rows.slice((q.page - 1) * q.pageSize, q.page * q.pageSize),
      pagination: buildPagination(q, total),
    };
  },

  // -------------------------------------------------------------------------
  // User performance
  // -------------------------------------------------------------------------
  async userPerformance(ctx: RequestContext, userId: string) {
    await scopeService.assertUserAccess(ctx.user, userId);
    const scope = await scopeOf(ctx);
    const user = await prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      include: { role: { select: { code: true, name: true } }, manager: { select: { id: true, firstName: true, lastName: true } } },
    });
    if (!user) throw AppError.notFound('User');

    const assigned = (await myAssessmentService.listForUser(userId)).filter(
      (a) => !scope.productIds || scope.productIds.includes(a.product.id),
    );
    const f: ReportFilter = { userId };
    const [totals, products, topics, history] = await Promise.all([
      reportRepository.attemptTotals(scope, f),
      reportRepository.productScores(scope, f),
      reportRepository.topicPerformance(scope, f),
      prisma.assessmentAttempt.findMany({
        where: { userId, ...(scope.productIds ? { assessment: { productId: { in: scope.productIds } } } : {}) },
        orderBy: { startTime: 'desc' },
        include: { assessment: { select: { assessmentCode: true, assessmentName: true, product: { select: { productName: true } } } } },
      }),
    ]);
    const bands = await settingsService.get('knowledgeGapThresholds');
    const completedAssessments = assigned.filter((a) => ['COMPLETED', 'PASSED', 'FAILED'].includes(a.status));
    const passedAssessments = assigned.filter((a) => a.status === 'PASSED');
    return {
      user: {
        id: user.id,
        employeeId: user.employeeId,
        name: fullName(user),
        email: user.email,
        department: user.department,
        designation: user.designation,
        team: user.team,
        location: user.location,
        role: user.role,
        manager: user.manager ? { id: user.manager.id, name: fullName(user.manager) } : null,
      },
      summary: {
        assessmentsAssigned: assigned.length,
        assessmentsCompleted: completedAssessments.length,
        assessmentsPassed: passedAssessments.length,
        assessmentsPending: assigned.filter((a) => a.status === 'NOT_STARTED' || a.status === 'IN_PROGRESS').length,
        passRate: percent(passedAssessments.length, completedAssessments.length),
        totalAttempts: totals.attempts,
        averageScore: round2(totals.avg_pct ?? 0),
      },
      productPerformance: products.map((p) => ({
        productId: p.product_id,
        productName: p.product_name,
        attempts: p.attempts,
        averageScore: round2(p.avg_pct),
        passRate: percent(p.passed, p.attempts),
      })),
      topicPerformance: topics.map((t) => {
        const pct = percent(t.correct, t.questions);
        return { productCode: t.product_code, topicId: t.topic_id, topicName: t.topic_name, questions: t.questions, correct: t.correct, accuracy: pct, band: classifyBand(bands, pct) };
      }),
      assessments: assigned,
      attemptHistory: history.map((a) => ({
        attemptId: a.id,
        assessmentCode: a.assessment.assessmentCode,
        assessmentName: a.assessment.assessmentName,
        productName: a.assessment.product.productName,
        attemptNumber: a.attemptNumber,
        status: a.status,
        startTime: a.startTime,
        submitTime: a.submitTime,
        percentage: isOpenAttempt(a.status) ? null : a.percentage,
        marksObtained: isOpenAttempt(a.status) ? null : a.marksObtained,
        totalMarks: a.totalMarks,
        result: a.result,
        timeTakenSeconds: a.durationUsed,
      })),
    };
  },

  // -------------------------------------------------------------------------
  // Knowledge gap analysis
  // -------------------------------------------------------------------------
  async knowledgeGap(ctx: RequestContext, f: ReportFilter) {
    const scope = await scopeOf(ctx);
    const [bands, topics, subtopics, userTopic] = await Promise.all([
      settingsService.get('knowledgeGapThresholds'),
      reportRepository.topicPerformance(scope, f),
      reportRepository.topicPerformance(scope, f, true),
      reportRepository.userTopicAccuracy(scope, f),
    ]);
    const sortedBands = [...bands].sort((a, b) => b.min - a.min);

    const result = topics.map((t) => {
      const accuracy = percent(t.correct, t.questions);
      const learners = userTopic.filter((u) => u.topic_id === t.topic_id && u.product_id === t.product_id);
      const userBands = sortedBands.map((b) => ({
        label: b.label,
        color: b.color,
        users: learners.filter((u) => classifyBand(bands, percent(u.correct, u.questions)).label === b.label).length,
      }));
      const lowestBand = sortedBands[sortedBands.length - 1];
      return {
        productId: t.product_id,
        productCode: t.product_code,
        productName: t.product_name,
        topicId: t.topic_id,
        topicName: t.topic_name,
        questionsServed: t.questions,
        answered: t.answered,
        correct: t.correct,
        learners: t.users,
        accuracy,
        band: classifyBand(bands, accuracy),
        userBands,
        usersNeedingTraining: learners
          .map((u) => ({ userId: u.user_id, employeeId: u.employee_id, name: `${u.first_name} ${u.last_name}`, department: u.department, accuracy: percent(u.correct, u.questions), questions: u.questions }))
          .filter((u) => classifyBand(bands, u.accuracy).label === lowestBand.label)
          .sort((a, b) => a.accuracy - b.accuracy),
        subtopics: subtopics
          .filter((s) => s.topic_id === t.topic_id && s.product_id === t.product_id && s.sub_topic_id)
          .map((s) => {
            const pct = percent(s.correct, s.questions);
            return { subTopicId: s.sub_topic_id, subTopicName: s.sub_topic_name, questions: s.questions, correct: s.correct, accuracy: pct, band: classifyBand(bands, pct) };
          }),
      };
    });
    result.sort((a, b) => a.accuracy - b.accuracy);
    return {
      thresholds: bands,
      summary: sortedBands.map((b) => ({ label: b.label, color: b.color, topics: result.filter((r) => r.band.label === b.label).length })),
      topics: result,
    };
  },

  // -------------------------------------------------------------------------
  // Question analytics
  // -------------------------------------------------------------------------
  async questionAnalytics(ctx: RequestContext, q: PageQuery & ReportFilter & { flag?: 'VERY_EASY' | 'DIFFICULT' | 'AMBIGUOUS' | 'FLAGGED' }) {
    const scope = await scopeOf(ctx);
    const cfg = await settingsService.get('questionAnalytics');
    const stats = await reportRepository.questionStats(scope, q);
    const ids = stats.map((s) => s.question_id);
    const [questions, picks] = await Promise.all([
      prisma.question.findMany({
        where: { id: { in: ids } },
        include: {
          product: { select: { productCode: true } },
          topic: { select: { name: true } },
          options: { orderBy: { sequence: 'asc' } },
        },
      }),
      reportRepository.optionDistribution(scope, q, ids),
    ]);
    const qById = new Map(questions.map((x) => [x.id, x]));
    const search = q.search?.toLowerCase();

    let rows = stats
      .map((s) => {
        const question = qById.get(s.question_id);
        // Correctness as recorded in the attempt snapshots, not the (possibly edited) live question.
        const distractors = picks.filter((p) => p.question_id === s.question_id && !p.is_correct);
        const topDistractor = distractors.sort((a, b) => b.picks - a.picks)[0];
        const incorrect = s.answered - s.correct;
        const correctRate = percent(s.correct, s.answered);
        const topDistractorShare = topDistractor ? percent(topDistractor.picks, s.answered) : 0;
        const flags: string[] = [];
        if (s.answered >= cfg.minAttempts) {
          if (correctRate > cfg.veryEasyAbove) flags.push('VERY_EASY');
          if (correctRate < cfg.difficultBelow) flags.push('DIFFICULT');
          // A single wrong option attracting a large share of answers suggests unclear wording or a wrong key.
          if (topDistractor && topDistractorShare >= cfg.ambiguousDistractorShare) flags.push('AMBIGUOUS');
        }
        return {
          questionId: s.question_id,
          questionNo: question?.questionNo ?? null,
          questionCode: question ? `Q${question.questionNo}` : '—',
          questionText: question?.questionText ?? '(deleted question)',
          productCode: question?.product.productCode ?? null,
          topicName: question?.topic.name ?? null,
          difficultyLevel: question?.difficultyLevel ?? null,
          status: question ? (question.deletedAt ? 'DELETED' : question.status) : 'DELETED',
          timesServed: s.served,
          attempted: s.answered,
          skipped: s.served - s.answered,
          correct: s.correct,
          incorrect,
          correctRate,
          incorrectRate: percent(incorrect, s.answered),
          topDistractor: topDistractor
            ? { optionId: topDistractor.option_id, optionText: topDistractor.option_text, share: topDistractorShare }
            : null,
          flags,
          lowSample: s.answered < cfg.minAttempts,
        };
      })
      .filter((r) => !search || r.questionText.toLowerCase().includes(search) || r.questionCode.toLowerCase() === search);

    if (q.flag === 'FLAGGED') rows = rows.filter((r) => r.flags.length);
    else if (q.flag) rows = rows.filter((r) => r.flags.includes(q.flag!));

    const sortKey = resolveSort(q.sortBy, ['correctRate', 'attempted', 'questionNo', 'incorrectRate'] as const, 'attempted');
    rows.sort((a, b) => ((a[sortKey] ?? 0) - (b[sortKey] ?? 0)) * (q.sortOrder === 'asc' ? 1 : -1));
    const total = rows.length;
    return {
      thresholds: cfg,
      summary: {
        questionsAnalysed: total,
        veryEasy: rows.filter((r) => r.flags.includes('VERY_EASY')).length,
        difficult: rows.filter((r) => r.flags.includes('DIFFICULT')).length,
        ambiguous: rows.filter((r) => r.flags.includes('AMBIGUOUS')).length,
      },
      rows: rows.slice((q.page - 1) * q.pageSize, q.page * q.pageSize),
      pagination: buildPagination(q, total),
    };
  },

  async questionAnalyticsDetail(ctx: RequestContext, questionId: string) {
    const scope = await scopeOf(ctx);
    const question = await prisma.question.findUnique({
      where: { id: questionId },
      include: { options: { orderBy: { sequence: 'asc' } }, product: { select: { productCode: true, productName: true } }, topic: { select: { name: true } } },
    });
    if (!question) throw AppError.notFound('Question');
    scopeService.assertProductAccess(ctx.user, question.productId);
    const [stats] = (await reportRepository.questionStats(scope, {})).filter((s) => s.question_id === questionId);
    const picks = await reportRepository.optionDistribution(scope, {}, [questionId]);
    const answered = stats?.answered ?? 0;
    return {
      questionId,
      questionCode: `Q${question.questionNo}`,
      questionText: question.questionText,
      product: question.product,
      topicName: question.topic.name,
      difficultyLevel: question.difficultyLevel,
      timesServed: stats?.served ?? 0,
      attempted: answered,
      correct: stats?.correct ?? 0,
      correctRate: percent(stats?.correct ?? 0, answered),
      options: question.options.map((o) => {
        const n = picks.find((p) => p.option_id === o.id)?.picks ?? 0;
        return { optionId: o.id, optionCode: o.optionCode, optionText: o.optionText, isCorrect: o.isCorrect, picks: n, share: percent(n, answered) };
      }),
    };
  },

  // -------------------------------------------------------------------------
  // Product summary
  // -------------------------------------------------------------------------
  async productSummary(ctx: RequestContext, f: ReportFilter) {
    const scope = await scopeOf(ctx);
    const [scores, products] = await Promise.all([
      reportRepository.productScores(scope, f),
      prisma.product.findMany({
        where: { deletedAt: null, ...(scope.productIds ? { id: { in: scope.productIds } } : {}), ...(f.productId ? { id: f.productId } : {}) },
        include: {
          _count: {
            select: {
              questions: { where: { deletedAt: null, status: 'ACTIVE' } },
              assessments: { where: { deletedAt: null, status: { not: 'DRAFT' } } },
              certificates: true,
            },
          },
        },
        orderBy: { productName: 'asc' },
      }),
    ]);
    return products.map((p) => {
      const s = scores.find((x) => x.product_id === p.id);
      return {
        productId: p.id,
        productCode: p.productCode,
        productName: p.productName,
        status: p.status,
        activeQuestions: p._count.questions,
        assessments: p._count.assessments,
        certificates: p._count.certificates,
        attempts: s?.attempts ?? 0,
        averageScore: round2(s?.avg_pct ?? 0),
        passRate: percent(s?.passed ?? 0, s?.attempts ?? 0),
      };
    });
  },
};

function matchesUser(
  asg: { assignmentType: Parameters<typeof usersWhereForTarget>[0]; assignmentReference: string },
  u: { id: string; team: string | null; department: string | null; productGroup: string | null; location: string | null; role: { code: string } },
) {
  const eq = (a: string | null) => !!a && a.toLowerCase() === asg.assignmentReference.toLowerCase();
  switch (asg.assignmentType) {
    case 'USER':
      return asg.assignmentReference === u.id;
    case 'ROLE':
      return asg.assignmentReference === u.role.code;
    case 'TEAM':
      return eq(u.team);
    case 'DEPARTMENT':
      return eq(u.department);
    case 'PRODUCT_GROUP':
      return eq(u.productGroup);
    case 'LOCATION':
      return eq(u.location);
  }
}
