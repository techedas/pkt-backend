import type { Prisma, ProductStatus } from '@prisma/client';
import type { z } from 'zod';
import { prisma } from '../config/database';
import type { RequestContext } from '../types/auth';
import { AppError } from '../utils/errors';
import { buildPagination, resolveSort, toSkipTake, type PageQuery } from '../utils/pagination';
import type { createProductSchema, updateProductSchema } from '../validators/product.validator';
import { OPEN_ATTEMPT_STATUSES } from '../models/attemptRules';
import { auditService } from './audit.service';
import { attemptService, timeoutStatus } from './attempt.service';
import { scopeService } from './scope.service';

type CreateProduct = z.infer<typeof createProductSchema>;
type UpdateProduct = z.infer<typeof updateProductSchema>;

const SORT = ['createdAt', 'productCode', 'productName', 'category', 'status'] as const;

async function assertProductNotTesting(productId: string) {
  // Settle any overdue attempts first so stale attempts whose deadline expired are closed
  const overdue = await prisma.assessmentAttempt.findMany({
    where: {
      status: { in: OPEN_ATTEMPT_STATUSES },
      deadline: { lt: new Date() },
      assessment: { productId },
    },
    select: { id: true, version: { select: { autoSubmitOnTimeout: true } } },
  });
  for (const a of overdue) {
    try {
      await attemptService.finalize(a.id, timeoutStatus(a.version));
    } catch {
      /* ignore */
    }
  }

  const running = await prisma.assessmentAttempt.findFirst({
    where: {
      status: { in: OPEN_ATTEMPT_STATUSES },
      assessment: { productId },
    },
  });

  if (running) {
    throw AppError.conflict(
      "A product in ‘Test Started’ status cannot be made inactive.",
      'PRODUCT_TEST_IN_PROGRESS',
    );
  }
}

export const productService = {
  async list(ctx: RequestContext, q: PageQuery & { status?: ProductStatus; category?: string }) {
    const where: Prisma.ProductWhereInput = {
      deletedAt: null,
      ...(ctx.user.productScope ? { id: { in: ctx.user.productScope } } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.category ? { category: q.category } : {}),
      ...(q.search
        ? {
            OR: [
              { productCode: { contains: q.search, mode: 'insensitive' } },
              { productName: { contains: q.search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const sortBy = resolveSort(q.sortBy, SORT, 'createdAt');
    const [rows, total] = await Promise.all([
      prisma.product.findMany({
        where,
        orderBy: { [sortBy]: q.sortOrder },
        ...toSkipTake(q),
        include: {
          createdBy: { select: { id: true, firstName: true, lastName: true } },
          assessments: {
            where: {
              deletedAt: null,
              assignments: { some: { status: 'ACTIVE' } },
            },
            select: { id: true, assessmentName: true },
          },
          _count: {
            select: {
              topics: { where: { deletedAt: null, parentId: null } },
              questions: { where: { deletedAt: null } },
              assessments: { where: { deletedAt: null } },
            },
          },
        },
      }),
      prisma.product.count({ where }),
    ]);
    return {
      rows: rows.map(({ _count, assessments, ...p }) => ({
        ...p,
        topicCount: _count.topics,
        questionCount: _count.questions,
        assessmentCount: _count.assessments,
        assignedAssessments: assessments.map((a) => a.assessmentName),
      })),
      pagination: buildPagination(q, total),
    };
  },

  /** Lightweight list for dropdowns. */
  async options(ctx: RequestContext, includeInactive = false) {
    return prisma.product.findMany({
      where: {
        deletedAt: null,
        ...(includeInactive ? {} : { status: 'ACTIVE' }),
        ...(ctx.user.productScope ? { id: { in: ctx.user.productScope } } : {}),
      },
      select: { id: true, productCode: true, productName: true, status: true },
      orderBy: { productName: 'asc' },
    });
  },

  async categories() {
    const rows = await prisma.product.findMany({
      where: { deletedAt: null, category: { not: null } },
      distinct: ['category'],
      select: { category: true },
      orderBy: { category: 'asc' },
    });
    return rows.map((r) => r.category!);
  },

  async get(ctx: RequestContext, id: string) {
    scopeService.assertProductAccess(ctx.user, id);
    const product = await prisma.product.findFirst({
      where: { id, deletedAt: null },
      include: {
        createdBy: { select: { id: true, firstName: true, lastName: true } },
        admins: { include: { user: { select: { id: true, firstName: true, lastName: true, email: true } } } },
      },
    });
    if (!product) throw AppError.notFound('Product');
    const [questionStats, assessmentCount, assignedAssessments] = await Promise.all([
      prisma.question.groupBy({ by: ['status'], where: { productId: id, deletedAt: null }, _count: true }),
      prisma.assessment.count({ where: { productId: id, deletedAt: null } }),
      prisma.assessment.findMany({
        where: { productId: id, deletedAt: null, assignments: { some: { status: 'ACTIVE' } } },
        select: { assessmentName: true },
      }),
    ]);
    return {
      ...product,
      admins: product.admins.map((a) => a.user),
      stats: {
        questions: Object.fromEntries(questionStats.map((s) => [s.status, s._count])),
        totalQuestions: questionStats.reduce((sum, s) => sum + s._count, 0),
        assessments: assessmentCount,
      },
      assignedAssessments: assignedAssessments.map((a) => a.assessmentName),
    };
  },

  async create(ctx: RequestContext, input: CreateProduct) {
    if (ctx.user.productScope) {
      throw AppError.forbidden('Only a Super Admin can create new products.', 'PRODUCT_CREATE_DENIED');
    }
    const exists = await prisma.product.findFirst({ where: { productCode: { equals: input.productCode, mode: 'insensitive' } } });
    if (exists) throw AppError.conflict(`Product code ${input.productCode} already exists.`, 'DUPLICATE_PRODUCT');
    const product = await prisma.product.create({ data: { ...input, createdById: ctx.user.id } });
    await auditService.log(ctx, 'PRODUCT_CREATED', 'Product', product.id, undefined, product);
    return product;
  },

  async update(ctx: RequestContext, id: string, input: UpdateProduct) {
    scopeService.assertProductAccess(ctx.user, id);
    const existing = await prisma.product.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw AppError.notFound('Product');
    if (input.status === 'INACTIVE' && existing.status !== 'INACTIVE') {
      await assertProductNotTesting(id);
    }
    if (input.productCode && input.productCode !== existing.productCode) {
      const clash = await prisma.product.findFirst({
        where: { productCode: { equals: input.productCode, mode: 'insensitive' }, id: { not: id } },
      });
      if (clash) throw AppError.conflict(`Product code ${input.productCode} already exists.`, 'DUPLICATE_PRODUCT');
    }
    const product = await prisma.product.update({ where: { id }, data: input });
    await auditService.log(ctx, 'PRODUCT_UPDATED', 'Product', id, existing, product);

    if (input.status && input.status !== existing.status) {
      if (input.status === 'INACTIVE') {
        await prisma.$executeRawUnsafe(
          `UPDATE assessment_assignments 
           SET status = 'INACTIVE' 
           WHERE status = 'ACTIVE' 
             AND assessment_id IN (
               SELECT id FROM assessments WHERE product_id = $1::uuid AND deleted_at IS NULL
             )`,
          id,
        );
      } else if (input.status === 'ACTIVE') {
        await prisma.$executeRawUnsafe(
          `UPDATE assessment_assignments 
           SET status = 'ACTIVE' 
           WHERE status = 'INACTIVE' 
             AND assessment_id IN (
               SELECT id FROM assessments WHERE product_id = $1::uuid AND deleted_at IS NULL
             )`,
          id,
        );
      }
    }

    return product;
  },

  async setStatus(ctx: RequestContext, id: string, status: ProductStatus) {
    scopeService.assertProductAccess(ctx.user, id);
    const existing = await prisma.product.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw AppError.notFound('Product');
    if (status === 'INACTIVE') {
      await assertProductNotTesting(id);
    }
    const product = await prisma.product.update({ where: { id }, data: { status } });
    await auditService.log(
      ctx,
      status === 'ACTIVE' ? 'PRODUCT_ACTIVATED' : 'PRODUCT_DEACTIVATED',
      'Product',
      id,
      { status: existing.status },
      { status },
    );

    if (status === 'INACTIVE') {
      await prisma.$executeRawUnsafe(
        `UPDATE assessment_assignments 
         SET status = 'INACTIVE' 
         WHERE status = 'ACTIVE' 
           AND assessment_id IN (
             SELECT id FROM assessments WHERE product_id = $1::uuid AND deleted_at IS NULL
           )`,
        id,
      );
    } else if (status === 'ACTIVE') {
      await prisma.$executeRawUnsafe(
        `UPDATE assessment_assignments 
         SET status = 'ACTIVE' 
         WHERE status = 'INACTIVE' 
           AND assessment_id IN (
             SELECT id FROM assessments WHERE product_id = $1::uuid AND deleted_at IS NULL
           )`,
        id,
      );
    }

    return product;
  },
};
