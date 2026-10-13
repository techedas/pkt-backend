import { Router } from 'express';
import { PERMISSIONS as P } from '../config/permissions';
import { reportController as c } from '../controllers/report.controller';
import { requirePermission } from '../middlewares/auth';
import { validate } from '../middlewares/validate';
import { asyncHandler as h } from '../utils/asyncHandler';
import { pageQuerySchema } from '../utils/pagination';
import { idParam } from '../validators/common';
import {
  exportQuerySchema,
  exportTypeParam,
  pendingQuerySchema,
  questionAnalyticsQuerySchema,
  reportFilterSchema,
  resultsQuerySchema,
} from '../validators/report.validator';

export const reportRoutes = Router();
reportRoutes.use(requirePermission(P.REPORT_READ));

reportRoutes.get('/results', validate({ query: resultsQuerySchema }), h(c.results));
reportRoutes.get('/assessments/:id', validate({ params: idParam }), h(c.assessmentReport));
reportRoutes.get('/pending', validate({ query: pendingQuerySchema }), h(c.pending));
reportRoutes.get('/users/:id', validate({ params: idParam }), h(c.userPerformance));
reportRoutes.get('/knowledge-gap', validate({ query: reportFilterSchema }), h(c.knowledgeGap));
reportRoutes.get('/question-analytics', validate({ query: questionAnalyticsQuerySchema }), h(c.questionAnalytics));
reportRoutes.get('/question-analytics/:id', validate({ params: idParam }), h(c.questionAnalyticsDetail));
reportRoutes.get('/products', validate({ query: reportFilterSchema }), h(c.productSummary));
reportRoutes.get('/certificates', validate({ query: pageQuerySchema }), h(c.certificates));
reportRoutes.get(
  '/export/:type',
  requirePermission(P.REPORT_EXPORT),
  validate({ params: exportTypeParam, query: exportQuerySchema }),
  h(c.export),
);

export const dashboardRoutes = Router();
dashboardRoutes.get('/admin', requirePermission(P.DASHBOARD_VIEW), validate({ query: reportFilterSchema }), h(c.adminDashboard));
