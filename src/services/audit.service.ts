import type { Prisma } from '@prisma/client';
import { prisma, type Tx } from '../config/database';
import type { RequestContext } from '../types/auth';
import { AppError } from '../utils/errors';
import { logger } from '../utils/logger';
import { buildPagination, resolveSort, toSkipTake, type PageQuery } from '../utils/pagination';

/** Fields that must never be written to the audit trail. */
const REDACTED = new Set(['passwordHash', 'password', 'newPassword', 'currentPassword', 'tokenHash', 'temporaryPassword']);
const MAX_CHANGES = 300;
const MAX_VALUE_LENGTH = 4000;

type Scalar = string | null;

/** Flatten a value into dotted paths: { a: { b: 1 }, list: [x] } -> { "a.b": "1", "list[0]": "x" }. */
export function flattenForAudit(value: unknown, prefix = '', out: Record<string, Scalar> = {}): Record<string, Scalar> {
  if (value === undefined) return out;
  if (value === null) {
    if (prefix) out[prefix] = null;
    return out;
  }
  if (value instanceof Date) {
    out[prefix || 'value'] = value.toISOString();
    return out;
  }
  if (Array.isArray(value)) {
    if (!value.length && prefix) out[prefix] = '[]';
    value.forEach((v, i) => flattenForAudit(v, `${prefix}[${i}]`, out));
    return out;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (!entries.length && prefix) out[prefix] = '{}';
    for (const [k, v] of entries) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (REDACTED.has(k)) out[path] = v === undefined ? null : '[REDACTED]';
      else flattenForAudit(v, path, out);
    }
    return out;
  }
  const text = String(value);
  out[prefix || 'value'] = text.length > MAX_VALUE_LENGTH ? `${text.slice(0, MAX_VALUE_LENGTH)}…` : text;
  return out;
}

/** Field-level differences between two values (only changed paths are kept). */
export function diffForAudit(oldValue: unknown, newValue: unknown) {
  const before = flattenForAudit(oldValue);
  const after = flattenForAudit(newValue);
  const paths = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return paths
    .filter((p) => before[p] !== after[p])
    .slice(0, MAX_CHANGES)
    .map((fieldPath) => ({ fieldPath: fieldPath.slice(0, 300), oldValue: before[fieldPath] ?? null, newValue: after[fieldPath] ?? null }));
}

export interface AuditListQuery extends PageQuery {
  action?: string;
  entityType?: string;
  entityId?: string;
  userId?: string;
  from?: Date;
  to?: Date;
}

const userSelect = { select: { id: true, employeeId: true, firstName: true, lastName: true, email: true } } as const;

export const auditService = {
  /**
   * Record an administrative action with its field-level changes. Failures are
   * logged but never break the business operation that triggered them.
   */
  async log(
    ctx: Pick<RequestContext, 'ipAddress' | 'userAgent'> & { user?: { id: string } | null },
    action: string,
    entityType: string,
    entityId: string | null,
    oldValue?: unknown,
    newValue?: unknown,
    tx: Tx = prisma,
  ) {
    try {
      const changes = diffForAudit(oldValue, newValue);
      await tx.auditLog.create({
        data: {
          userId: ctx.user?.id ?? null,
          action,
          entityType,
          entityId,
          ipAddress: ctx.ipAddress ?? null,
          userAgent: ctx.userAgent ?? null,
          ...(changes.length ? { changes: { create: changes } } : {}),
        },
      });
    } catch (err) {
      logger.error('Failed to write audit log', { action, entityType, entityId, err });
    }
  },

  async list(q: AuditListQuery) {
    const where: Prisma.AuditLogWhereInput = {
      ...(q.action ? { action: q.action } : {}),
      ...(q.entityType ? { entityType: q.entityType } : {}),
      ...(q.entityId ? { entityId: q.entityId } : {}),
      ...(q.userId ? { userId: q.userId } : {}),
      ...(q.from || q.to ? { createdAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
      ...(q.search
        ? {
            OR: [
              { action: { contains: q.search, mode: 'insensitive' } },
              { entityType: { contains: q.search, mode: 'insensitive' } },
              { entityId: { contains: q.search, mode: 'insensitive' } },
              { user: { email: { contains: q.search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    };
    const sortBy = resolveSort(q.sortBy, ['createdAt', 'action', 'entityType'] as const, 'createdAt');
    const [rows, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { [sortBy]: q.sortOrder },
        ...toSkipTake(q),
        include: { user: userSelect, _count: { select: { changes: true } } },
      }),
      prisma.auditLog.count({ where }),
    ]);
    return {
      rows: rows.map(({ _count, ...r }) => ({ ...r, changeCount: _count.changes })),
      pagination: buildPagination(q, total),
    };
  },

  /** One audit entry with all of its field changes. */
  async get(id: string) {
    const log = await prisma.auditLog.findUnique({
      where: { id },
      include: { user: userSelect, changes: { orderBy: { fieldPath: 'asc' } } },
    });
    if (!log) throw AppError.notFound('Audit log');
    return log;
  },

  async distinctActions() {
    const rows = await prisma.auditLog.findMany({ distinct: ['action'], select: { action: true }, orderBy: { action: 'asc' } });
    return rows.map((r) => r.action);
  },
};
