import { Router } from 'express';
import { PERMISSIONS as P } from '../config/permissions';
import { assessmentController as c, assignmentController as a } from '../controllers/assessment.controller';
import { requirePermission } from '../middlewares/auth';
import { validate } from '../middlewares/validate';
import { asyncHandler as h } from '../utils/asyncHandler';
import { z } from 'zod';
import {
  assessmentStatusSchema,
  distributionSchema,
  createAssessmentSchema,
  listAssessmentsSchema,
  previewRulesSchema,
  updateAssessmentSchema,
} from '../validators/assessment.validator';
import { createAssignmentSchema, listAssignmentsSchema, updateAssignmentSchema } from '../validators/assignment.validator';
import { idParam, uuid } from '../validators/common';

/**
 * Admin assessment management. The user-facing "start" endpoint
 * (POST /api/assessments/:id/start) is mounted separately in attempt.routes.ts.
 */
export const assessmentRoutes = Router();

assessmentRoutes.get('/', requirePermission(P.ASSESSMENT_READ), validate({ query: listAssessmentsSchema }), h(c.list));
assessmentRoutes.get('/options', requirePermission(P.ASSESSMENT_READ, P.REPORT_READ, P.ASSIGNMENT_READ), h(c.options));
assessmentRoutes.post('/preview-rules', requirePermission(P.ASSESSMENT_WRITE), validate({ body: previewRulesSchema }), h(c.previewRules));
assessmentRoutes.get('/:id', requirePermission(P.ASSESSMENT_READ), validate({ params: idParam }), h(c.get));
assessmentRoutes.get('/:id/validate', requirePermission(P.ASSESSMENT_READ), validate({ params: idParam }), h(c.validate));
assessmentRoutes.post('/', requirePermission(P.ASSESSMENT_WRITE), validate({ body: createAssessmentSchema }), h(c.create));
assessmentRoutes.put('/:id', requirePermission(P.ASSESSMENT_WRITE), validate({ params: idParam, body: updateAssessmentSchema }), h(c.update));
assessmentRoutes.post('/:id/publish', requirePermission(P.ASSESSMENT_PUBLISH), validate({ params: idParam }), h(c.publish));
assessmentRoutes.patch('/:id/status', requirePermission(P.ASSESSMENT_PUBLISH), validate({ params: idParam, body: assessmentStatusSchema }), h(c.setStatus));
assessmentRoutes.post('/:id/clone', requirePermission(P.ASSESSMENT_WRITE), validate({ params: idParam }), h(c.clone));
assessmentRoutes.delete('/:id', requirePermission(P.ASSESSMENT_WRITE), validate({ params: idParam }), h(c.remove));

// Difficulty distribution (assessment_difficulty_distribution)
assessmentRoutes.get('/:id/difficulty-distribution', requirePermission(P.ASSESSMENT_READ), validate({ params: idParam }), h(c.getDistribution));
assessmentRoutes.put(
  '/:id/difficulty-distribution',
  requirePermission(P.ASSESSMENT_WRITE),
  validate({ params: idParam, body: z.object({ distribution: distributionSchema }) }),
  h(c.setDistribution),
);

// Published versions (assessment_versions)
assessmentRoutes.get('/:id/versions', requirePermission(P.ASSESSMENT_READ), validate({ params: idParam }), h(c.listVersions));
assessmentRoutes.get(
  '/:id/versions/:versionId',
  requirePermission(P.ASSESSMENT_READ),
  validate({ params: z.object({ id: uuid, versionId: uuid }) }),
  h(c.getVersion),
);

export const assignmentRoutes = Router();

assignmentRoutes.get('/', requirePermission(P.ASSIGNMENT_READ), validate({ query: listAssignmentsSchema }), h(a.list));
assignmentRoutes.post('/', requirePermission(P.ASSIGNMENT_WRITE), validate({ body: createAssignmentSchema }), h(a.create));
assignmentRoutes.patch('/:id', requirePermission(P.ASSIGNMENT_WRITE), validate({ params: idParam, body: updateAssignmentSchema }), h(a.update));
assignmentRoutes.delete('/:id', requirePermission(P.ASSIGNMENT_WRITE), validate({ params: idParam }), h(a.cancel));
