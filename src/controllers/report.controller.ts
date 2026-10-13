import type { Request, Response } from 'express';
import { ctxOf } from '../middlewares/auth';
import { certificateService } from '../services/certificate.service';
import { reportService } from '../services/report.service';
import { scopeService } from '../services/scope.service';
import { AppError } from '../utils/errors';
import type { PageQuery } from '../utils/pagination';
import { ok, paginated } from '../utils/response';
import { sendExport, type ExportColumn } from '../utils/spreadsheet';

const fmtSeconds = (s: number | null | undefined) => (s == null ? '' : `${Math.floor(s / 60)}m ${s % 60}s`);

type ResultRow = Awaited<ReturnType<typeof reportService.results>>['rows'][number];
const resultColumns: ExportColumn<ResultRow>[] = [
  { header: 'Employee ID', value: (r) => r.employeeId },
  { header: 'Name', value: (r) => r.name },
  { header: 'Department', value: (r) => r.department },
  { header: 'Team', value: (r) => r.team },
  { header: 'Product', value: (r) => r.productName },
  { header: 'Assessment Code', value: (r) => r.assessmentCode },
  { header: 'Assessment', value: (r) => r.assessmentName },
  { header: 'Attempt', value: (r) => r.attemptNumber },
  { header: 'Score', value: (r) => `${r.marksObtained}/${r.totalMarks}` },
  { header: 'Percentage', value: (r) => r.percentage },
  { header: 'Result', value: (r) => r.result },
  { header: 'Correct', value: (r) => r.correctAnswers },
  { header: 'Incorrect', value: (r) => r.incorrectAnswers },
  { header: 'Unanswered', value: (r) => r.unansweredQuestions },
  { header: 'Time Taken', value: (r) => fmtSeconds(r.timeTakenSeconds) },
  { header: 'Status', value: (r) => r.status },
  { header: 'Completion Date', value: (r) => r.completionDate },
];

export const reportController = {
  async adminDashboard(req: Request, res: Response) {
    return ok(res, await reportService.adminDashboard(ctxOf(req), req.query as never));
  },
  async results(req: Request, res: Response) {
    const { rows, pagination } = await reportService.results(ctxOf(req), req.query as never);
    return paginated(res, rows, pagination);
  },
  async assessmentReport(req: Request, res: Response) {
    return ok(res, await reportService.assessmentReport(ctxOf(req), req.params.id));
  },
  async pending(req: Request, res: Response) {
    const { rows, pagination } = await reportService.pending(ctxOf(req), req.query as never);
    return paginated(res, rows, pagination);
  },
  async userPerformance(req: Request, res: Response) {
    return ok(res, await reportService.userPerformance(ctxOf(req), req.params.id));
  },
  async knowledgeGap(req: Request, res: Response) {
    return ok(res, await reportService.knowledgeGap(ctxOf(req), req.query as never));
  },
  async questionAnalytics(req: Request, res: Response) {
    const { rows, pagination, summary, thresholds } = await reportService.questionAnalytics(ctxOf(req), req.query as never);
    return res.json({ success: true, data: rows, pagination, meta: { summary, thresholds } });
  },
  async questionAnalyticsDetail(req: Request, res: Response) {
    return ok(res, await reportService.questionAnalyticsDetail(ctxOf(req), req.params.id));
  },
  async productSummary(req: Request, res: Response) {
    return ok(res, await reportService.productSummary(ctxOf(req), req.query as never));
  },
  async certificates(req: Request, res: Response) {
    const ctx = ctxOf(req);
    const { rows, pagination } = await certificateService.list({
      ...(req.query as unknown as PageQuery),
      productScope: ctx.user.productScope,
      userIds: await scopeService.teamUserIds(ctx.user),
    });
    return paginated(res, rows, pagination);
  },

  /** CSV exports. New formats plug into `exporters` in utils/spreadsheet.ts. */
  async export(req: Request, res: Response) {
    const ctx = ctxOf(req);
    const q = req.query as never as Record<string, unknown> & { format: string; page: number; pageSize: number; sortOrder: 'asc' | 'desc' };
    const stamp = new Date().toISOString().slice(0, 10);
    switch (req.params.type) {
      case 'user-results': {
        const { rows } = await reportService.results(ctx, q as never, true);
        return sendExport(res, q.format, `user-results-${stamp}`, resultColumns, rows);
      }
      case 'assessment-results': {
        if (!q.assessmentId) throw AppError.badRequest('assessmentId is required for this export.', 'VALIDATION_ERROR');
        const { rows } = await reportService.results(ctx, q as never, true);
        return sendExport(res, q.format, `assessment-results-${stamp}`, resultColumns, rows);
      }
      case 'product-report': {
        const rows = await reportService.productSummary(ctx, q as never);
        return sendExport(res, q.format, `product-report-${stamp}`, [
          { header: 'Product Code', value: (r) => r.productCode },
          { header: 'Product', value: (r) => r.productName },
          { header: 'Status', value: (r) => r.status },
          { header: 'Active Questions', value: (r) => r.activeQuestions },
          { header: 'Assessments', value: (r) => r.assessments },
          { header: 'Attempts', value: (r) => r.attempts },
          { header: 'Average Score %', value: (r) => r.averageScore },
          { header: 'Pass Rate %', value: (r) => r.passRate },
          { header: 'Certificates Issued', value: (r) => r.certificates },
        ], rows);
      }
      case 'knowledge-gap': {
        const { topics } = await reportService.knowledgeGap(ctx, q as never);
        const rows = topics.flatMap((t) => [
          { level: 'Topic', product: t.productName, topic: t.topicName, subtopic: '', questions: t.questionsServed, correct: t.correct, accuracy: t.accuracy, band: t.band.label, needTraining: t.usersNeedingTraining.length },
          ...t.subtopics.map((s) => ({ level: 'Subtopic', product: t.productName, topic: t.topicName, subtopic: s.subTopicName ?? '', questions: s.questions, correct: s.correct, accuracy: s.accuracy, band: s.band.label, needTraining: '' as number | '' })),
        ]);
        return sendExport(res, q.format, `knowledge-gap-${stamp}`, [
          { header: 'Level', value: (r) => r.level },
          { header: 'Product', value: (r) => r.product },
          { header: 'Topic', value: (r) => r.topic },
          { header: 'Subtopic', value: (r) => r.subtopic },
          { header: 'Questions Served', value: (r) => r.questions },
          { header: 'Correct', value: (r) => r.correct },
          { header: 'Accuracy %', value: (r) => r.accuracy },
          { header: 'Band', value: (r) => r.band },
          { header: 'Users Needing Training', value: (r) => r.needTraining },
        ], rows);
      }
      case 'pending-assessments': {
        const { rows } = await reportService.pending(ctx, q as never, true);
        return sendExport(res, q.format, `pending-assessments-${stamp}`, [
          { header: 'Employee ID', value: (r) => r.employeeId as string },
          { header: 'Name', value: (r) => r.name },
          { header: 'Email', value: (r) => r.email as string },
          { header: 'Department', value: (r) => r.department as string },
          { header: 'Team', value: (r) => r.team as string },
          { header: 'Manager', value: (r) => r.manager as string },
          { header: 'Assessment', value: (r) => r.assessmentName as string },
          { header: 'Product', value: (r) => r.productName as string },
          { header: 'Status', value: (r) => r.status as string },
          { header: 'Due Date', value: (r) => r.dueDate },
          { header: 'Overdue', value: (r) => (r.overdue ? 'Yes' : 'No') },
        ], rows);
      }
      default:
        throw AppError.badRequest('Unknown export type.', 'VALIDATION_ERROR');
    }
  },
};
