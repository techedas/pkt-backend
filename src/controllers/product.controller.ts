import type { Request, Response } from 'express';
import { ctxOf } from '../middlewares/auth';
import { productService } from '../services/product.service';
import { topicService } from '../services/topic.service';
import { created, ok, paginated } from '../utils/response';

export const productController = {
  async list(req: Request, res: Response) {
    const { rows, pagination } = await productService.list(ctxOf(req), req.query as never);
    return paginated(res, rows, pagination);
  },
  async options(req: Request, res: Response) {
    return ok(res, await productService.options(ctxOf(req), req.query.includeInactive === 'true'));
  },
  async categories(_req: Request, res: Response) {
    return ok(res, await productService.categories());
  },
  async get(req: Request, res: Response) {
    return ok(res, await productService.get(ctxOf(req), req.params.id));
  },
  async create(req: Request, res: Response) {
    return created(res, await productService.create(ctxOf(req), req.body), 'Product created successfully');
  },
  async update(req: Request, res: Response) {
    return ok(res, await productService.update(ctxOf(req), req.params.id, req.body), 'Product updated successfully');
  },
  async setStatus(req: Request, res: Response) {
    const p = await productService.setStatus(ctxOf(req), req.params.id, req.body.status);
    return ok(res, p, p.status === 'ACTIVE' ? 'Product activated' : 'Product deactivated');
  },
};

export const topicController = {
  async tree(req: Request, res: Response) {
    const q = req.query as { productId: string; includeInactive?: string };
    return ok(res, await topicService.tree(ctxOf(req), q.productId, q.includeInactive !== 'false'));
  },
  async create(req: Request, res: Response) {
    return created(res, await topicService.create(ctxOf(req), req.body), 'Topic created successfully');
  },
  async update(req: Request, res: Response) {
    return ok(res, await topicService.update(ctxOf(req), req.params.id, req.body), 'Topic updated successfully');
  },
  async remove(req: Request, res: Response) {
    await topicService.remove(ctxOf(req), req.params.id);
    return ok(res, null, 'Topic deleted');
  },
};
