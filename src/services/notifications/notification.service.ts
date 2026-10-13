import type { NotificationType, Prisma } from '@prisma/client';
import { prisma } from '../../config/database';
import { logger } from '../../utils/logger';
import { buildPagination, toSkipTake, type PageQuery } from '../../utils/pagination';
import { AppError } from '../../utils/errors';
import { InAppChannel, type NotificationChannelProvider, type NotificationMessage } from './channels';

/** Event payloads. Keeping them typed means templates cannot drift from their callers. */
export interface NotificationEvents {
  ASSESSMENT_ASSIGNED: { assessmentId: string; assessmentName: string; dueDate?: Date | null };
  ASSESSMENT_DUE_SOON: { assessmentId: string; assessmentName: string; dueDate: Date };
  ASSESSMENT_EXPIRED: { assessmentId: string; assessmentName: string };
  ASSESSMENT_COMPLETED: { attemptId: string; assessmentName: string };
  ASSESSMENT_PASSED: { attemptId: string; assessmentName: string; percentage: number };
  ASSESSMENT_FAILED: { attemptId: string; assessmentName: string; percentage: number };
  REATTEMPT_AVAILABLE: { assessmentId: string; assessmentName: string; attemptsLeft: number };
  CERTIFICATION_EXPIRING: { certificateId: string; certificateNumber: string; expiryDate: Date };
}

type EventName = keyof NotificationEvents;

const fmtDate = (d: Date) => d.toISOString().slice(0, 10);

const templates: { [E in EventName]: (p: NotificationEvents[E]) => Pick<NotificationMessage, 'title' | 'message' | 'link'> } = {
  ASSESSMENT_ASSIGNED: (p) => ({
    title: 'New assessment assigned',
    message: `"${p.assessmentName}" has been assigned to you${p.dueDate ? `. Due on ${fmtDate(p.dueDate)}` : ''}.`,
    link: `/my/assessments/${p.assessmentId}/instructions`,
  }),
  ASSESSMENT_DUE_SOON: (p) => ({
    title: 'Assessment due soon',
    message: `"${p.assessmentName}" is due on ${fmtDate(p.dueDate)}. Please complete it before the due date.`,
    link: `/my/assessments/${p.assessmentId}/instructions`,
  }),
  ASSESSMENT_EXPIRED: (p) => ({
    title: 'Assessment expired',
    message: `"${p.assessmentName}" has expired.`,
    link: '/my/assessments',
  }),
  ASSESSMENT_COMPLETED: (p) => ({
    title: 'Assessment submitted',
    message: `Your answers for "${p.assessmentName}" have been submitted.`,
    link: `/my/attempts/${p.attemptId}/result`,
  }),
  ASSESSMENT_PASSED: (p) => ({
    title: 'Congratulations, you passed!',
    message: `You scored ${p.percentage}% in "${p.assessmentName}".`,
    link: `/my/attempts/${p.attemptId}/result`,
  }),
  ASSESSMENT_FAILED: (p) => ({
    title: 'Assessment result',
    message: `You scored ${p.percentage}% in "${p.assessmentName}", which is below the passing mark.`,
    link: `/my/attempts/${p.attemptId}/result`,
  }),
  REATTEMPT_AVAILABLE: (p) => ({
    title: 'Reattempt available',
    message: `You can reattempt "${p.assessmentName}". Attempts left: ${p.attemptsLeft}.`,
    link: `/my/assessments/${p.assessmentId}/instructions`,
  }),
  CERTIFICATION_EXPIRING: (p) => ({
    title: 'Certificate expiring',
    message: `Certificate ${p.certificateNumber} expires on ${fmtDate(p.expiryDate)}.`,
    link: '/my/certificates',
  }),
};

/** The record a notification refers to (stored in entity_type / entity_id). */
function entityOf(payload: object): { entityType?: string; entityId?: string } {
  const p = payload as { attemptId?: string; certificateId?: string; assessmentId?: string };
  if (p.attemptId) return { entityType: 'AssessmentAttempt', entityId: p.attemptId };
  if (p.certificateId) return { entityType: 'Certificate', entityId: p.certificateId };
  if (p.assessmentId) return { entityType: 'Assessment', entityId: p.assessmentId };
  return {};
}

// Register additional channels (email, SMS, WhatsApp) here.
const channels: NotificationChannelProvider[] = [new InAppChannel()];

export const notificationService = {
  /**
   * Publish an event to one or more users on every registered channel.
   * Notification failures are logged and never fail the calling business flow.
   */
  async notify<E extends EventName>(
    event: E,
    userIds: string[],
    payload: NotificationEvents[E],
    options: { dedupeKey?: string } = {},
  ) {
    if (!userIds.length) return;
    const content = templates[event](payload);
    const entity = entityOf(payload);
    const messages: NotificationMessage[] = [...new Set(userIds)].map((userId) => ({
      userId,
      type: event as NotificationType,
      ...content,
      ...entity,
      dedupeKey: options.dedupeKey,
    }));
    await Promise.all(
      channels.map((c) =>
        c.send(messages).catch((err) => logger.error('Notification channel failed', { channel: c.channel, event, err })),
      ),
    );
  },

  async listForUser(userId: string, q: PageQuery & { unreadOnly?: boolean }) {
    const where: Prisma.NotificationWhereInput = { userId, ...(q.unreadOnly ? { isRead: false } : {}) };
    const [rows, total, unread] = await Promise.all([
      prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, ...toSkipTake(q) }),
      prisma.notification.count({ where }),
      prisma.notification.count({ where: { userId, isRead: false } }),
    ]);
    return { rows, pagination: buildPagination(q, total), unread };
  },

  async unreadCount(userId: string) {
    return prisma.notification.count({ where: { userId, isRead: false } });
  },

  async markRead(userId: string, id: string) {
    const result = await prisma.notification.updateMany({
      where: { id, userId },
      data: { isRead: true, readAt: new Date() },
    });
    if (!result.count) throw AppError.notFound('Notification');
  },

  async markAllRead(userId: string) {
    const result = await prisma.notification.updateMany({
      where: { userId, isRead: false },
      data: { isRead: true, readAt: new Date() },
    });
    return result.count;
  },
};
