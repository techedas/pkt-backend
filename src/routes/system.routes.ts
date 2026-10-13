import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { PERMISSIONS as P } from '../config/permissions';
import { ctxOf, requirePermission } from '../middlewares/auth';
import { validate } from '../middlewares/validate';
import { auditService } from '../services/audit.service';
import { notificationService } from '../services/notifications/notification.service';
import { settingsService } from '../services/settings.service';
import { asyncHandler as h } from '../utils/asyncHandler';
import { pageQuerySchema } from '../utils/pagination';
import { ok, paginated } from '../utils/response';
import { idParam, uuid } from '../validators/common';

// ---------------------------------------------------------------------------
// Notifications (current user)
// ---------------------------------------------------------------------------
export const notificationRoutes = Router();

const notificationController = {
  async list(req: Request, res: Response) {
    const q = req.query as unknown as z.infer<typeof listNotificationsSchema>;
    const { rows, pagination, unread } = await notificationService.listForUser(ctxOf(req).user.id, q);
    return res.json({ success: true, data: rows, pagination, meta: { unread } });
  },
  async unreadCount(req: Request, res: Response) {
    return ok(res, { unread: await notificationService.unreadCount(ctxOf(req).user.id) });
  },
  async markRead(req: Request, res: Response) {
    await notificationService.markRead(ctxOf(req).user.id, req.params.id);
    return ok(res, null, 'Notification marked as read');
  },
  async markAllRead(req: Request, res: Response) {
    const count = await notificationService.markAllRead(ctxOf(req).user.id);
    return ok(res, { updated: count }, 'All notifications marked as read');
  },
};

const listNotificationsSchema = pageQuerySchema.extend({
  unreadOnly: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

notificationRoutes.get('/', validate({ query: listNotificationsSchema }), h(notificationController.list));
notificationRoutes.get('/unread-count', h(notificationController.unreadCount));
notificationRoutes.patch('/read-all', h(notificationController.markAllRead));
notificationRoutes.patch('/:id/read', validate({ params: idParam }), h(notificationController.markRead));

// ---------------------------------------------------------------------------
// Application settings
// ---------------------------------------------------------------------------
export const settingsRoutes = Router();

settingsRoutes.get('/', requirePermission(P.SETTINGS_READ), h(async (_req, res) => ok(res, await settingsService.list())));
// Public-safe subset every signed-in user may read (e.g. password policy, knowledge-gap bands).
settingsRoutes.get(
  '/public',
  h(async (_req, res) => {
    const s = await settingsService.getAll();
    return ok(res, { passwordPolicy: s.passwordPolicy, knowledgeGapThresholds: s.knowledgeGapThresholds, sessionTimeoutMinutes: s.sessionTimeoutMinutes });
  }),
);
settingsRoutes.put(
  '/',
  requirePermission(P.SETTINGS_WRITE),
  validate({ body: z.record(z.string(), z.unknown()) }),
  h(async (req, res) => ok(res, await settingsService.update(ctxOf(req), req.body), 'Settings saved')),
);

// Individual setting rows (application_settings), e.g. "passwordPolicy.minLength".
settingsRoutes.get('/entries', requirePermission(P.SETTINGS_READ), h(async (_req, res) => ok(res, await settingsService.listEntries())));
const settingKeyParam = z.object({ key: z.string().regex(/^[A-Za-z]+(\.[A-Za-z]+)?$/, 'Invalid setting key') });
settingsRoutes.get(
  '/entries/:key',
  requirePermission(P.SETTINGS_READ),
  validate({ params: settingKeyParam }),
  h(async (req, res) => ok(res, await settingsService.getEntry(req.params.key))),
);
settingsRoutes.put(
  '/entries/:key',
  requirePermission(P.SETTINGS_WRITE),
  validate({ params: settingKeyParam, body: z.object({ value: z.union([z.number(), z.boolean(), z.string().max(500)]) }) }),
  h(async (req, res) => ok(res, await settingsService.setEntry(ctxOf(req), req.params.key, req.body.value), 'Setting saved')),
);

// Knowledge-gap bands (knowledge_gap_bands).
const bandSchema = z.object({
  label: z.string().trim().min(1).max(50),
  min: z.coerce.number().min(0).max(100),
  max: z.coerce.number().min(0).max(100),
  color: z.string().trim().regex(/^#[0-9a-fA-F]{3,8}$/, 'Use a hex colour such as #0ca30c').optional(),
});
settingsRoutes.get('/knowledge-gap-bands', h(async (_req, res) => ok(res, await settingsService.listBands())));
settingsRoutes.post(
  '/knowledge-gap-bands',
  requirePermission(P.SETTINGS_WRITE),
  validate({ body: bandSchema.refine((b) => b.min <= b.max, { message: 'min must be <= max', path: ['min'] }) }),
  h(async (req, res) => res.status(201).json({ success: true, data: await settingsService.createBand(ctxOf(req), req.body), message: 'Band created' })),
);
settingsRoutes.put(
  '/knowledge-gap-bands/:id',
  requirePermission(P.SETTINGS_WRITE),
  validate({ params: idParam, body: bandSchema.partial().extend({ sequence: z.coerce.number().int().min(0).max(100).optional() }) }),
  h(async (req, res) => ok(res, await settingsService.updateBand(ctxOf(req), req.params.id, req.body), 'Band updated')),
);
settingsRoutes.delete(
  '/knowledge-gap-bands/:id',
  requirePermission(P.SETTINGS_WRITE),
  validate({ params: idParam }),
  h(async (req, res) => {
    await settingsService.deleteBand(ctxOf(req), req.params.id);
    return ok(res, null, 'Band deleted');
  }),
);

// ---------------------------------------------------------------------------
// Audit logs
// ---------------------------------------------------------------------------
export const auditRoutes = Router();

const auditQuerySchema = pageQuerySchema.extend({
  action: z.string().max(100).optional(),
  entityType: z.string().max(50).optional(),
  entityId: z.string().max(100).optional(),
  userId: uuid.optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

auditRoutes.get(
  '/',
  requirePermission(P.AUDIT_READ),
  validate({ query: auditQuerySchema }),
  h(async (req, res) => {
    const { rows, pagination } = await auditService.list(req.query as never);
    return paginated(res, rows, pagination);
  }),
);
auditRoutes.get('/actions', requirePermission(P.AUDIT_READ), h(async (_req, res) => ok(res, await auditService.distinctActions())));
// One entry with its field-level changes (audit_log_changes).
auditRoutes.get('/:id', requirePermission(P.AUDIT_READ), validate({ params: idParam }), h(async (req, res) => ok(res, await auditService.get(req.params.id))));
