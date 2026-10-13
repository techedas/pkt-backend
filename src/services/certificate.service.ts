import type { Prisma } from '@prisma/client';
import { prisma, type Tx } from '../config/database';
import { AppError } from '../utils/errors';
import { buildPagination, toSkipTake, type PageQuery } from '../utils/pagination';
import { nextSequence } from './sequence.service';

const certificateInclude = {
  user: { select: { id: true, employeeId: true, firstName: true, lastName: true, email: true } },
  assessment: { select: { id: true, assessmentCode: true, assessmentName: true } },
  product: { select: { id: true, productCode: true, productName: true } },
} satisfies Prisma.CertificateInclude;

export const certificateService = {
  /**
   * Issue a certificate for a passed attempt. Number format: PKT-<PRODUCT>-<YEAR>-<000001>,
   * sequential per product and year. Runs inside the attempt finalisation transaction.
   */
  async issueForAttempt(
    tx: Tx,
    params: {
      attemptId: string;
      userId: string;
      assessmentId: string;
      productId: string;
      productCode: string;
      score: number;
      percentage: number;
      validityDays: number | null;
    },
  ) {
    const existing = await tx.certificate.findUnique({ where: { attemptId: params.attemptId } });
    if (existing) return existing;
    const now = new Date();
    const year = now.getFullYear();
    const seq = await nextSequence(`CERT-${params.productCode}-${year}`, tx);
    const certificateNumber = `PKT-${params.productCode}-${year}-${String(seq).padStart(6, '0')}`;
    return tx.certificate.create({
      data: {
        certificateNumber,
        attemptId: params.attemptId,
        userId: params.userId,
        assessmentId: params.assessmentId,
        productId: params.productId,
        score: params.score,
        percentage: params.percentage,
        issueDate: now,
        expiryDate: params.validityDays ? new Date(now.getTime() + params.validityDays * 86_400_000) : null,
      },
    });
  },

  async listForUser(userId: string) {
    const rows = await prisma.certificate.findMany({ where: { userId }, include: certificateInclude, orderBy: { issueDate: 'desc' } });
    return rows.map(withLiveStatus);
  },

  async get(id: string, viewer: { id: string; canViewAll: boolean }) {
    const cert = await prisma.certificate.findUnique({ where: { id }, include: certificateInclude });
    if (!cert || (!viewer.canViewAll && cert.userId !== viewer.id)) throw AppError.notFound('Certificate');
    return withLiveStatus(cert);
  },

  async list(q: PageQuery & { productId?: string; status?: 'ACTIVE' | 'EXPIRED' | 'REVOKED'; productScope?: string[] | null; userIds?: string[] | null }) {
    const where: Prisma.CertificateWhereInput = {
      ...(q.productScope ? { productId: { in: q.productScope } } : {}),
      ...(q.userIds ? { userId: { in: q.userIds } } : {}),
      ...(q.productId ? { productId: q.productId } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.search
        ? {
            OR: [
              { certificateNumber: { contains: q.search, mode: 'insensitive' } },
              { user: { firstName: { contains: q.search, mode: 'insensitive' } } },
              { user: { lastName: { contains: q.search, mode: 'insensitive' } } },
              { user: { employeeId: { contains: q.search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.certificate.findMany({ where, include: certificateInclude, orderBy: { issueDate: q.sortOrder }, ...toSkipTake(q) }),
      prisma.certificate.count({ where }),
    ]);
    return { rows: rows.map(withLiveStatus), pagination: buildPagination(q, total) };
  },

  /** Persist expiry (run by the scheduler). */
  async expireOverdue(now = new Date()) {
    const r = await prisma.certificate.updateMany({ where: { status: 'ACTIVE', expiryDate: { lt: now } }, data: { status: 'EXPIRED' } });
    return r.count;
  },
};

function withLiveStatus<T extends { status: string; expiryDate: Date | null }>(c: T) {
  return { ...c, status: c.status === 'ACTIVE' && c.expiryDate && c.expiryDate < new Date() ? 'EXPIRED' : c.status };
}
