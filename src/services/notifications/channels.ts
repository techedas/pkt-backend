import type { NotificationChannel, NotificationType } from '@prisma/client';
import { prisma } from '../../config/database';
import { logger } from '../../utils/logger';

export interface NotificationMessage {
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  link?: string;
  /** The record the notification is about, e.g. ("AssessmentAttempt", id). */
  entityType?: string;
  entityId?: string;
  dedupeKey?: string;
}

/**
 * A delivery channel. Add Email / SMS / WhatsApp by implementing this
 * interface and registering the channel in `notification.service.ts`.
 */
export interface NotificationChannelProvider {
  readonly channel: NotificationChannel;
  send(messages: NotificationMessage[]): Promise<void>;
}

export class InAppChannel implements NotificationChannelProvider {
  readonly channel = 'IN_APP' as const;

  async send(messages: NotificationMessage[]) {
    if (!messages.length) return;
    // skipDuplicates + the (userId, dedupeKey) unique index make repeated events idempotent.
    await prisma.notification.createMany({
      data: messages.map((m) => ({
        userId: m.userId,
        type: m.type,
        channel: this.channel,
        title: m.title,
        message: m.message,
        link: m.link ?? null,
        entityType: m.entityType ?? null,
        entityId: m.entityId ?? null,
        dedupeKey: m.dedupeKey ?? null,
      })),
      skipDuplicates: true,
    });
  }
}

/** Placeholder showing where an e-mail integration plugs in. Logs instead of sending. */
export class LogOnlyEmailChannel implements NotificationChannelProvider {
  readonly channel = 'EMAIL' as const;

  async send(messages: NotificationMessage[]) {
    for (const m of messages) logger.debug('EMAIL (not configured)', { to: m.userId, subject: m.title });
  }
}
