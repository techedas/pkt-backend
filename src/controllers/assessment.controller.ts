import type { Request, Response } from 'express';
import { ctxOf } from '../middlewares/auth';
import { assessmentService } from '../services/assessment.service';
import { assignmentService } from '../services/assignment.service';
import { created, ok, paginated } from '../utils/response';

export const assessmentController = {
  async list(req: Request, res: Response) {
    const { rows, pagination } = await assessmentService.list(ctxOf(req), req.query as never);
    return paginated(res, rows, pagination);
  },
  async options(req: Request, res: Response) {
    return ok(res, await assessmentService.options(ctxOf(req)));
  },
  async get(req: Request, res: Response) {
    return ok(res, await assessmentService.get(ctxOf(req), req.params.id));
  },
  async create(req: Request, res: Response) {
    return created(res, await assessmentService.create(ctxOf(req), req.body), 'Assessment created successfully');
  },
  async update(req: Request, res: Response) {
    return ok(res, await assessmentService.update(ctxOf(req), req.params.id, req.body), 'Assessment updated successfully');
  },
  async previewRules(req: Request, res: Response) {
    const { productId, rules, difficultyDistribution } = req.body;
    return ok(res, await assessmentService.previewRules(ctxOf(req), productId, rules, difficultyDistribution));
  },
  async validate(req: Request, res: Response) {
    return ok(res, await assessmentService.checkReadiness(ctxOf(req), req.params.id));
  },
  async publish(req: Request, res: Response) {
    return ok(res, await assessmentService.publish(ctxOf(req), req.params.id), 'Assessment published successfully');
  },
  async setStatus(req: Request, res: Response) {
    const a = await assessmentService.setStatus(ctxOf(req), req.params.id, req.body.status);
    return ok(res, a, a.status === 'INACTIVE' ? 'Assessment deactivated' : 'Assessment reactivated');
  },
  async clone(req: Request, res: Response) {
    return created(res, await assessmentService.clone(ctxOf(req), req.params.id), 'Assessment cloned as a new draft');
  },
  async remove(req: Request, res: Response) {
    await assessmentService.remove(ctxOf(req), req.params.id);
    return ok(res, null, 'Assessment deleted');
  },
  async getDistribution(req: Request, res: Response) {
    return ok(res, await assessmentService.getDistribution(ctxOf(req), req.params.id));
  },
  async setDistribution(req: Request, res: Response) {
    return ok(res, await assessmentService.setDistribution(ctxOf(req), req.params.id, req.body.distribution ?? null), 'Difficulty distribution saved');
  },
  async listVersions(req: Request, res: Response) {
    return ok(res, await assessmentService.listVersions(ctxOf(req), req.params.id));
  },
  async getVersion(req: Request, res: Response) {
    return ok(res, await assessmentService.getVersion(ctxOf(req), req.params.id, req.params.versionId));
  },
};

export const assignmentController = {
  async list(req: Request, res: Response) {
    const { rows, pagination } = await assignmentService.list(ctxOf(req), req.query as never);
    return paginated(res, rows, pagination);
  },
  async create(req: Request, res: Response) {
    const result = await assignmentService.create(ctxOf(req), req.body);
    return created(res, result, `Assessment assigned to ${result.recipients} user(s)`);
  },
  async update(req: Request, res: Response) {
    return ok(res, await assignmentService.updateDueDate(ctxOf(req), req.params.id, req.body.dueDate), 'Assignment updated');
  },
  async cancel(req: Request, res: Response) {
    return ok(res, await assignmentService.cancel(ctxOf(req), req.params.id), 'Assignment cancelled');
  },
};
