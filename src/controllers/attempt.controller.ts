import type { Request, Response } from 'express';
import { ctxOf } from '../middlewares/auth';
import { attemptService } from '../services/attempt.service';
import { certificateService } from '../services/certificate.service';
import { myAssessmentService } from '../services/myAssessment.service';
import { PERMISSIONS } from '../config/permissions';
import { created, ok, paginated } from '../utils/response';

export const attemptController = {
  async myAssessments(req: Request, res: Response) {
    return ok(res, await myAssessmentService.list(ctxOf(req)));
  },
  async myDashboard(req: Request, res: Response) {
    return ok(res, await myAssessmentService.dashboard(ctxOf(req)));
  },
  async instructions(req: Request, res: Response) {
    return ok(res, await myAssessmentService.instructions(ctxOf(req), req.params.assessmentId));
  },
  async start(req: Request, res: Response) {
    const result = await attemptService.start(ctxOf(req), req.params.assessmentId);
    return result.resumed ? ok(res, result, 'Resuming your attempt') : created(res, result, 'Assessment started successfully');
  },
  async questions(req: Request, res: Response) {
    return ok(res, await attemptService.getQuestions(ctxOf(req), req.params.attemptId));
  },
  async saveAnswer(req: Request, res: Response) {
    return ok(res, await attemptService.saveAnswer(ctxOf(req), req.params.attemptId, req.body), 'Answer saved');
  },
  async submit(req: Request, res: Response) {
    return ok(res, await attemptService.submit(ctxOf(req), req.params.attemptId), 'Assessment submitted successfully');
  },
  async result(req: Request, res: Response) {
    return ok(res, await attemptService.getResult(ctxOf(req), req.params.attemptId));
  },
  async snapshot(req: Request, res: Response) {
    return ok(res, await attemptService.snapshot(ctxOf(req), req.params.attemptId));
  },
  async history(req: Request, res: Response) {
    const { rows, pagination } = await attemptService.history(ctxOf(req), req.query as never);
    return paginated(res, rows, pagination);
  },
  async myCertificates(req: Request, res: Response) {
    return ok(res, await certificateService.listForUser(ctxOf(req).user.id));
  },
  async certificate(req: Request, res: Response) {
    const ctx = ctxOf(req);
    return ok(res, await certificateService.get(req.params.id, { id: ctx.user.id, canViewAll: ctx.user.permissions.has(PERMISSIONS.REPORT_READ) }));
  },
};
