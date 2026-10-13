import { Router } from 'express';
import { PERMISSIONS as P } from '../config/permissions';
import { questionController as c } from '../controllers/question.controller';
import { requirePermission } from '../middlewares/auth';
import { spreadsheetUpload } from '../middlewares/upload';
import { validate } from '../middlewares/validate';
import { asyncHandler as h } from '../utils/asyncHandler';
import { idParam } from '../validators/common';
import {
  attachmentParams,
  attachmentSchema,
  bulkQuestionConfirmSchema,
  createQuestionSchema,
  listQuestionsSchema,
  questionStatusSchema,
  updateQuestionSchema,
} from '../validators/question.validator';

const r = Router();

r.get('/', requirePermission(P.QUESTION_READ), validate({ query: listQuestionsSchema }), h(c.list));
r.get('/creators', requirePermission(P.QUESTION_READ), h(c.creators));
r.get('/bulk/template', requirePermission(P.QUESTION_WRITE), h(c.template));
r.post('/bulk/preview', requirePermission(P.QUESTION_WRITE), spreadsheetUpload, h(c.bulkPreview));
r.post('/bulk/confirm', requirePermission(P.QUESTION_WRITE), validate({ body: bulkQuestionConfirmSchema }), h(c.bulkConfirm));
r.get('/:id', requirePermission(P.QUESTION_READ), validate({ params: idParam }), h(c.get));
r.post('/', requirePermission(P.QUESTION_WRITE), validate({ body: createQuestionSchema }), h(c.create));
r.put('/:id', requirePermission(P.QUESTION_WRITE), validate({ params: idParam, body: updateQuestionSchema }), h(c.update));
r.patch('/:id/status', requirePermission(P.QUESTION_WRITE), validate({ params: idParam, body: questionStatusSchema }), h(c.setStatus));
r.delete('/:id', requirePermission(P.QUESTION_WRITE), validate({ params: idParam }), h(c.remove));

// Attachments (question_attachments)
r.get('/:id/attachments', requirePermission(P.QUESTION_READ), validate({ params: idParam }), h(c.listAttachments));
r.post('/:id/attachments', requirePermission(P.QUESTION_WRITE), validate({ params: idParam, body: attachmentSchema }), h(c.addAttachment));
r.put(
  '/:id/attachments/:attachmentId',
  requirePermission(P.QUESTION_WRITE),
  validate({ params: attachmentParams, body: attachmentSchema.partial() }),
  h(c.updateAttachment),
);
r.delete('/:id/attachments/:attachmentId', requirePermission(P.QUESTION_WRITE), validate({ params: attachmentParams }), h(c.removeAttachment));

export default r;
