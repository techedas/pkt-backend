import type { AssignmentStatus, AssignmentType, Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { effectiveAssessmentStatus } from '../models/assessmentStatus';
import type { RequestContext } from '../types/auth';
import { AppError } from '../utils/errors';
import { fullName } from '../utils/helpers';
import { buildPagination, toSkipTake, type PageQuery } from '../utils/pagination';
import { usersWhereForTarget } from './assignmentResolver';
import { auditService } from './audit.service';
import { notificationService } from './notifications/notification.service';
import { scopeService } from './scope.service';

interface Target {
  assignmentType: AssignmentType;
  assignmentReference: string;
}

interface CreateInput {
  assessmentId: string;
  targets: Target[];
  dueDate?: Date | null;
  notify: boolean;
}

async function describeTargets(rows: Array<{ assignmentType: AssignmentType; assignmentReference: string }>) {
  const userIds = rows.filter((r) => r.assignmentType === 'USER').map((r) => r.assignmentReference);
  const users = userIds.length
    ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, employeeId: true, firstName: true, lastName: true } })
    : [];
  const byId = new Map(users.map((u) => [u.id, u]));
  return (r: Target) => {
    if (r.assignmentType !== 'USER') return r.assignmentReference;
    const u = byId.get(r.assignmentReference);
    return u ? `${fullName(u)} (${u.employeeId})` : 'Unknown user';
  };
}

export const assignmentService = {
  async list(ctx: RequestContext, q: PageQuery & { assessmentId?: string; assignmentType?: AssignmentType; status?: AssignmentStatus }) {
    const teamIds = await scopeService.teamUserIds(ctx.user);
    const where: Prisma.AssessmentAssignmentWhereInput = {
      assessment: { deletedAt: null, ...scopeService.productFilter(ctx.user) },
      ...(q.assessmentId ? { assessmentId: q.assessmentId } : {}),
      ...(q.assignmentType ? { assignmentType: q.assignmentType } : {}),
      ...(q.status ? { status: q.status } : {}),
      // Managers only see assignments they made or that target their team members.
      ...(teamIds
        ? { OR: [{ assignedById: ctx.user.id }, { assignmentType: 'USER', assignmentReference: { in: teamIds } }] }
        : {}),
      ...(q.search
        ? {
            AND: [
              {
                OR: [
                  { assignmentReference: { contains: q.search, mode: 'insensitive' } },
                  { assessment: { assessmentName: { contains: q.search, mode: 'insensitive' } } },
                  { assessment: { assessmentCode: { contains: q.search, mode: 'insensitive' } } },
                ],
              },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      prisma.assessmentAssignment.findMany({
        where,
        orderBy: { assignedAt: q.sortOrder },
        ...toSkipTake(q),
        include: {
          assessment: { select: { id: true, assessmentCode: true, assessmentName: true, product: { select: { productCode: true, productName: true } } } },
          assignedBy: { select: { id: true, firstName: true, lastName: true } },
        },
      }),
      prisma.assessmentAssignment.count({ where }),
    ]);
    const label = await describeTargets(rows);
    const withCounts = await Promise.all(
      rows.map(async (r) => ({
        ...r,
        targetLabel: label(r),
        userCount:
          r.status === 'ACTIVE' ? await prisma.user.count({ where: { ...usersWhereForTarget(r.assignmentType, r.assignmentReference), status: 'ACTIVE' } }) : 0,
      })),
    );
    return { rows: withCounts, pagination: buildPagination(q, total) };
  },

  async create(ctx: RequestContext, input: CreateInput) {
    const assessment = await prisma.assessment.findFirst({
      where: { id: input.assessmentId, deletedAt: null },
      include: { product: { select: { id: true, status: true, productName: true } } },
    });
    if (!assessment) throw AppError.notFound('Assessment');
    if (assessment.product.status === 'INACTIVE') {
      throw AppError.badRequest(`Cannot assign assessment "${assessment.assessmentName}" because its product "${assessment.product.productName}" is inactive.`, 'PRODUCT_INACTIVE');
    }
    scopeService.assertProductAccess(ctx.user, assessment.productId);
    const status = effectiveAssessmentStatus(assessment);
    if (status !== 'ACTIVE' && status !== 'PUBLISHED') {
      throw AppError.conflict(`Only published assessments can be assigned (current status: ${status}).`, 'ASSESSMENT_NOT_ASSIGNABLE');
    }
    if (input.dueDate && input.dueDate < new Date()) throw AppError.badRequest('Due date cannot be in the past.', 'INVALID_DUE_DATE');
    if (input.dueDate && assessment.endDate && input.dueDate > assessment.endDate) {
      throw AppError.badRequest('Due date cannot be after the assessment end date.', 'INVALID_DUE_DATE');
    }

    // Managers may only assign to members of their own team.
    const teamIds = await scopeService.teamUserIds(ctx.user);
    if (teamIds) {
      const outside = input.targets.filter((t) => t.assignmentType !== 'USER' || !teamIds.includes(t.assignmentReference));
      if (outside.length) {
        throw AppError.forbidden('Managers can assign assessments only to members of their own team.', 'ASSIGNMENT_SCOPE');
      }
    }

    // Validate every target resolves to at least one active user.
    const targets = input.targets.filter(
      (t, i, arr) => arr.findIndex((o) => o.assignmentType === t.assignmentType && o.assignmentReference.toLowerCase() === t.assignmentReference.toLowerCase()) === i,
    );
    const invalid: string[] = [];
    const recipients = new Set<string>();
    for (const t of targets) {
      if (t.assignmentType === 'ROLE' && !(await prisma.role.findUnique({ where: { code: t.assignmentReference } }))) {
        invalid.push(`Unknown role ${t.assignmentReference}`);
        continue;
      }
      const users = await prisma.user.findMany({
        where: { ...usersWhereForTarget(t.assignmentType, t.assignmentReference), status: 'ACTIVE' },
        select: { id: true },
      });
      if (!users.length) invalid.push(`${t.assignmentType} "${t.assignmentReference}" has no active users`);
      users.forEach((u) => recipients.add(u.id));
    }
    if (invalid.length) throw AppError.badRequest('Some assignment targets are invalid.', 'INVALID_ASSIGNMENT_TARGET', invalid);

    const results = await prisma.$transaction(async (tx) => {
      const out = [];
      for (const t of targets) {
        const existing = await tx.assessmentAssignment.findFirst({
          where: {
            assessmentId: input.assessmentId,
            assignmentType: t.assignmentType,
            assignmentReference: { equals: t.assignmentReference, mode: 'insensitive' },
            status: 'ACTIVE',
          },
        });
        out.push(
          existing
            ? await tx.assessmentAssignment.update({ where: { id: existing.id }, data: { dueDate: input.dueDate ?? null, assignedById: ctx.user.id } })
            : await tx.assessmentAssignment.create({
                data: {
                  assessmentId: input.assessmentId,
                  assignmentType: t.assignmentType,
                  assignmentReference: t.assignmentReference,
                  dueDate: input.dueDate ?? null,
                  assignedById: ctx.user.id,
                },
              }),
        );
      }
      return out;
    });

    if (input.notify) {
      await notificationService.notify(
        'ASSESSMENT_ASSIGNED',
        [...recipients],
        { assessmentId: assessment.id, assessmentName: assessment.assessmentName, dueDate: input.dueDate ?? null },
        { dedupeKey: `assigned:${assessment.id}:${results.map((r) => r.id).sort().join(',').slice(0, 120)}` },
      );
    }
    await auditService.log(ctx, 'ASSESSMENT_ASSIGNED', 'Assessment', assessment.id, undefined, {
      targets,
      dueDate: input.dueDate ?? null,
      recipients: recipients.size,
    });
    return { assignments: results, recipients: recipients.size };
  },

  async updateDueDate(ctx: RequestContext, id: string, dueDate: Date | null | undefined) {
    const a = await prisma.assessmentAssignment.findUnique({ where: { id }, include: { assessment: true } });
    if (!a) throw AppError.notFound('Assignment');
    scopeService.assertProductAccess(ctx.user, a.assessment.productId);
    await this.assertCanManage(ctx, a);
    if (dueDate && a.assessment.endDate && dueDate > a.assessment.endDate) {
      throw AppError.badRequest('Due date cannot be after the assessment end date.', 'INVALID_DUE_DATE');
    }
    const updated = await prisma.assessmentAssignment.update({ where: { id }, data: { dueDate: dueDate ?? null } });
    await auditService.log(ctx, 'ASSIGNMENT_UPDATED', 'AssessmentAssignment', id, { dueDate: a.dueDate }, { dueDate: updated.dueDate });
    return updated;
  },

  async cancel(ctx: RequestContext, id: string) {
    const a = await prisma.assessmentAssignment.findUnique({ where: { id }, include: { assessment: true } });
    if (!a) throw AppError.notFound('Assignment');
    scopeService.assertProductAccess(ctx.user, a.assessment.productId);
    await this.assertCanManage(ctx, a);
    if (a.status === 'CANCELLED') return a;
    const updated = await prisma.assessmentAssignment.update({ where: { id }, data: { status: 'CANCELLED' } });
    await auditService.log(ctx, 'ASSIGNMENT_CANCELLED', 'AssessmentAssignment', id, { status: a.status }, { status: 'CANCELLED' });
    return updated;
  },

  async assertCanManage(ctx: RequestContext, a: { assignedById: string | null; assignmentType: AssignmentType; assignmentReference: string }) {
    const teamIds = await scopeService.teamUserIds(ctx.user);
    if (!teamIds) return;
    if (a.assignedById === ctx.user.id) return;
    if (a.assignmentType === 'USER' && teamIds.includes(a.assignmentReference)) return;
    throw AppError.forbidden('You can only manage assignments for your team.', 'ASSIGNMENT_SCOPE');
  },
};
