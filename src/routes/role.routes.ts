import { Router } from 'express';
import { z } from 'zod';
import { PERMISSIONS as P } from '../config/permissions';
import { ctxOf, requirePermission } from '../middlewares/auth';
import { validate } from '../middlewares/validate';
import { roleService } from '../services/role.service';
import { asyncHandler as h } from '../utils/asyncHandler';
import { ok } from '../utils/response';
import { idParam } from '../validators/common';

const r = Router();

// Role list is also needed by user management screens.
r.get('/', requirePermission(P.ROLE_READ, P.USER_READ), h(async (_req, res) => ok(res, await roleService.list())));
r.get('/permissions', requirePermission(P.ROLE_READ), h(async (_req, res) => ok(res, await roleService.listPermissions())));
r.put(
  '/:id/permissions',
  requirePermission(P.ROLE_WRITE),
  validate({ params: idParam, body: z.object({ permissions: z.array(z.string().max(100)).max(100) }) }),
  h(async (req, res) =>
    ok(res, await roleService.updatePermissions(ctxOf(req), req.params.id, req.body.permissions), 'Role permissions updated'),
  ),
);

export default r;
