import { prisma } from '../config/database';
import { assessmentService } from '../services/assessment.service';
import { assignedUserIds } from '../services/assignmentResolver';
import { attemptService } from '../services/attempt.service';
import { certificateService } from '../services/certificate.service';
import { notificationService } from '../services/notifications/notification.service';
import { settingsService } from '../services/settings.service';
import { logger } from '../utils/logger';

/**
 * In-process scheduler. Every job is idempotent, so running several API
 * instances concurrently is safe (duplicates are prevented by conditional
 * updates and notification dedupe keys). Move to a dedicated worker/queue if
 * the platform grows.
 */

async function autoSubmitJob() {
  const count = await attemptService.finalizeOverdue();
  if (count) logger.info('Auto-submitted overdue attempts', { count });
}

async function assessmentStatusJob() {
  const before = await prisma.assessment.findMany({ where: { deletedAt: null, status: { in: ['PUBLISHED', 'ACTIVE'] }, endDate: { lt: new Date() } }, select: { id: true, assessmentName: true } });
  const result = await assessmentService.syncStatuses();
  if (result.expired || result.activated) logger.info('Assessment statuses updated', result);
  // Tell assigned users who never completed an assessment that it has expired.
  for (const a of before) {
    const userIds = await assignedUserIds(a.id);
    const completed = new Set(
      (await prisma.assessmentAttempt.findMany({ where: { assessmentId: a.id, userId: { in: userIds }, status: { in: ['SUBMITTED', 'AUTO_SUBMITTED', 'EXPIRED'] } }, select: { userId: true } })).map((r) => r.userId),
    );
    const pending = userIds.filter((u) => !completed.has(u));
    for (const userId of pending) {
      await notificationService.notify('ASSESSMENT_EXPIRED', [userId], { assessmentId: a.id, assessmentName: a.assessmentName }, { dedupeKey: `expired:${a.id}` });
    }
  }
}

async function dueSoonJob() {
  const hours = await settingsService.get('notificationDueSoonHours');
  const now = new Date();
  const horizon = new Date(now.getTime() + hours * 3_600_000);
  const assignments = await prisma.assessmentAssignment.findMany({
    where: { status: 'ACTIVE', dueDate: { gt: now, lte: horizon }, assessment: { deletedAt: null, status: { in: ['ACTIVE', 'PUBLISHED'] } } },
    include: { assessment: { select: { id: true, assessmentName: true } } },
  });
  for (const asg of assignments) {
    const userIds = await assignedUserIds(asg.assessmentId);
    const done = new Set(
      (await prisma.assessmentAttempt.findMany({ where: { assessmentId: asg.assessmentId, userId: { in: userIds }, status: { in: ['SUBMITTED', 'AUTO_SUBMITTED'] } }, select: { userId: true } })).map((r) => r.userId),
    );
    const pending = userIds.filter((u) => !done.has(u));
    for (const userId of pending) {
      await notificationService.notify(
        'ASSESSMENT_DUE_SOON',
        [userId],
        { assessmentId: asg.assessmentId, assessmentName: asg.assessment.assessmentName, dueDate: asg.dueDate! },
        { dedupeKey: `due-soon:${asg.id}:${asg.dueDate!.toISOString()}` },
      );
    }
  }
}

async function certificateJob() {
  const expired = await certificateService.expireOverdue();
  if (expired) logger.info('Certificates expired', { expired });
  const days = await settingsService.get('certificationExpiryReminderDays');
  const soon = await prisma.certificate.findMany({
    where: { status: 'ACTIVE', expiryDate: { gt: new Date(), lte: new Date(Date.now() + days * 86_400_000) } },
  });
  for (const c of soon) {
    await notificationService.notify(
      'CERTIFICATION_EXPIRING',
      [c.userId],
      { certificateId: c.id, certificateNumber: c.certificateNumber, expiryDate: c.expiryDate! },
      { dedupeKey: `cert-expiring:${c.id}` },
    );
  }
}

const jobs: Array<{ name: string; everyMs: number; run: () => Promise<void> }> = [
  { name: 'auto-submit', everyMs: 15_000, run: autoSubmitJob },
  { name: 'assessment-status', everyMs: 60_000, run: assessmentStatusJob },
  { name: 'due-soon', everyMs: 15 * 60_000, run: dueSoonJob },
  { name: 'certificates', everyMs: 60 * 60_000, run: certificateJob },
];

const timers: NodeJS.Timeout[] = [];

export function startScheduler() {
  for (const job of jobs) {
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        await job.run();
      } catch (err) {
        logger.error(`Job ${job.name} failed`, { err });
      } finally {
        running = false;
      }
    };
    timers.push(setInterval(tick, job.everyMs));
    setTimeout(tick, 2_000);
  }
  logger.info('Scheduler started', { jobs: jobs.map((j) => j.name) });
}

export function stopScheduler() {
  timers.splice(0).forEach(clearInterval);
}
