import { Router } from 'express';
import { attemptController as c } from '../controllers/attempt.controller';
import { PERMISSIONS } from '../config/permissions';
import { requirePermission } from '../middlewares/auth';
import { validate } from '../middlewares/validate';
import { asyncHandler as h } from '../utils/asyncHandler';
import { assessmentIdParam, attemptIdParam, historyQuerySchema, saveAnswerSchema } from '../validators/attempt.validator';
import { idParam } from '../validators/common';

/**
 * Learner endpoints. Only authentication is required: access is enforced by
 * assignment (start) and ownership (attempt endpoints) inside the services.
 */

// GET /api/user/...
export const userRoutes = Router();
userRoutes.get('/assessments', h(c.myAssessments));
userRoutes.get('/dashboard', h(c.myDashboard));
userRoutes.get('/assessments/:assessmentId/instructions', validate({ params: assessmentIdParam }), h(c.instructions));
userRoutes.get('/attempts', validate({ query: historyQuerySchema }), h(c.history));
userRoutes.get('/certificates', h(c.myCertificates));
userRoutes.get('/certificates/:id', validate({ params: idParam }), h(c.certificate));

// POST /api/assessments/:assessmentId/start
export const assessmentStartRoutes = Router();
assessmentStartRoutes.post('/:assessmentId/start', validate({ params: assessmentIdParam }), h(c.start));

// /api/attempts/...
export const attemptRoutes = Router();
attemptRoutes.get('/:attemptId/questions', validate({ params: attemptIdParam }), h(c.questions));
attemptRoutes.post('/:attemptId/answers', validate({ params: attemptIdParam, body: saveAnswerSchema }), h(c.saveAnswer));
attemptRoutes.post('/:attemptId/submit', validate({ params: attemptIdParam }), h(c.submit));
attemptRoutes.get('/:attemptId/result', validate({ params: attemptIdParam }), h(c.result));

// /api/results/:attemptId (alias used by reviewers)
export const resultRoutes = Router();
resultRoutes.get('/:attemptId', validate({ params: attemptIdParam }), h(c.result));
// Exact option snapshot of an attempt (attempt_questions + attempt_question_options + answers) for reviewers.
resultRoutes.get('/:attemptId/snapshot', requirePermission(PERMISSIONS.REPORT_READ), validate({ params: attemptIdParam }), h(c.snapshot));
