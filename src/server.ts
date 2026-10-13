import { createApp } from './app';
import { prisma } from './config/database';
import { env } from './config/env';
import { startScheduler, stopScheduler } from './jobs/scheduler';
import { roleService } from './services/role.service';
import { logger } from './utils/logger';

async function main() {
  await prisma.$connect();
  try {
    await roleService.syncDefaultRolePermissions();
  } catch (syncErr) {
    logger.error('Failed to sync default role permissions', { err: syncErr });
  }
  try {
    await prisma.$executeRawUnsafe(`ALTER TYPE "AssignmentStatus" ADD VALUE IF NOT EXISTS 'INACTIVE'`);
  } catch (enumErr) {
    logger.warn('Failed to add INACTIVE to AssignmentStatus enum', { err: enumErr });
  }
  try {
    await prisma.$executeRawUnsafe(`
      UPDATE assessment_assignments 
      SET status = 'INACTIVE' 
      WHERE status = 'ACTIVE' 
        AND assessment_id IN (
          SELECT a.id FROM assessments a 
          JOIN products p ON a.product_id = p.id 
          WHERE p.status = 'INACTIVE' AND a.deleted_at IS NULL
        )
    `);
    logger.info('✔ Synced assignments for inactive products to INACTIVE status');
  } catch (syncAssignErr) {
    logger.error('Failed to sync assignments for inactive products', { err: syncAssignErr });
  }
  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info(`PKT API listening on http://localhost:${env.PORT} (docs: /api/docs)`, { env: env.NODE_ENV });
  });
  if (!env.DISABLE_JOBS) startScheduler();

  const shutdown = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down`);
    stopScheduler();
    server.close(async () => {
      await prisma.$disconnect();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch(async (err) => {
  logger.error('Failed to start server', { err });
  await prisma.$disconnect();
  process.exit(1);
});
