import { Router } from 'express';
import { PERMISSIONS as P } from '../config/permissions';
import { userController as c } from '../controllers/user.controller';
import { requirePermission } from '../middlewares/auth';
import { spreadsheetUpload } from '../middlewares/upload';
import { validate } from '../middlewares/validate';
import { asyncHandler as h } from '../utils/asyncHandler';
import { idParam } from '../validators/common';
import {
  adminResetPasswordSchema,
  bulkUserConfirmSchema,
  createUserSchema,
  listUsersSchema,
  updateUserSchema,
  userStatusSchema,
} from '../validators/user.validator';

const r = Router();

r.get('/', requirePermission(P.USER_READ), validate({ query: listUsersSchema }), h(c.list));
r.get('/lookups', requirePermission(P.USER_READ, P.ASSIGNMENT_WRITE), h(c.lookups));
r.get('/picker', requirePermission(P.USER_READ, P.ASSIGNMENT_WRITE), h(c.picker));
r.get('/bulk/template', requirePermission(P.USER_WRITE), h(c.bulkTemplate));
r.post('/bulk/preview', requirePermission(P.USER_WRITE), spreadsheetUpload, h(c.bulkPreview));
r.post('/bulk/confirm', requirePermission(P.USER_WRITE), validate({ body: bulkUserConfirmSchema }), h(c.bulkConfirm));
r.get('/:id', requirePermission(P.USER_READ), validate({ params: idParam }), h(c.get));
r.post('/', requirePermission(P.USER_WRITE), validate({ body: createUserSchema }), h(c.create));
r.put('/:id', requirePermission(P.USER_WRITE), validate({ params: idParam, body: updateUserSchema }), h(c.update));
r.patch('/:id/status', requirePermission(P.USER_WRITE), validate({ params: idParam, body: userStatusSchema }), h(c.setStatus));
r.post('/:id/reset-password', requirePermission(P.USER_WRITE), validate({ params: idParam, body: adminResetPasswordSchema }), h(c.resetPassword));
r.delete('/:id', requirePermission(P.USER_WRITE), validate({ params: idParam }), h(c.remove));

export default r;
