import { Router } from 'express';
import { PERMISSIONS as P } from '../config/permissions';
import { productController as c, topicController as t } from '../controllers/product.controller';
import { requirePermission } from '../middlewares/auth';
import { validate } from '../middlewares/validate';
import { asyncHandler as h } from '../utils/asyncHandler';
import { idParam } from '../validators/common';
import {
  createProductSchema,
  createTopicSchema,
  listProductsSchema,
  listTopicsSchema,
  productStatusSchema,
  updateProductSchema,
  updateTopicSchema,
} from '../validators/product.validator';

export const productRoutes = Router();

productRoutes.get('/', requirePermission(P.PRODUCT_READ), validate({ query: listProductsSchema }), h(c.list));
// Dropdown data is needed by several modules (questions, assessments, reports).
productRoutes.get('/options', requirePermission(P.PRODUCT_READ, P.QUESTION_READ, P.ASSESSMENT_READ, P.REPORT_READ), h(c.options));
productRoutes.get('/categories', requirePermission(P.PRODUCT_READ), h(c.categories));
productRoutes.get('/:id', requirePermission(P.PRODUCT_READ), validate({ params: idParam }), h(c.get));
productRoutes.post('/', requirePermission(P.PRODUCT_WRITE), validate({ body: createProductSchema }), h(c.create));
productRoutes.put('/:id', requirePermission(P.PRODUCT_WRITE), validate({ params: idParam, body: updateProductSchema }), h(c.update));
productRoutes.patch('/:id/status', requirePermission(P.PRODUCT_WRITE), validate({ params: idParam, body: productStatusSchema }), h(c.setStatus));

export const topicRoutes = Router();

topicRoutes.get(
  '/',
  requirePermission(P.PRODUCT_READ, P.QUESTION_READ, P.ASSESSMENT_READ, P.REPORT_READ),
  validate({ query: listTopicsSchema }),
  h(t.tree),
);
topicRoutes.post('/', requirePermission(P.PRODUCT_WRITE), validate({ body: createTopicSchema }), h(t.create));
topicRoutes.put('/:id', requirePermission(P.PRODUCT_WRITE), validate({ params: idParam, body: updateTopicSchema }), h(t.update));
topicRoutes.delete('/:id', requirePermission(P.PRODUCT_WRITE), validate({ params: idParam }), h(t.remove));
