import type { ProductTopic } from '@prisma/client';
import type { z } from 'zod';
import { prisma } from '../config/database';
import type { RequestContext } from '../types/auth';
import { AppError } from '../utils/errors';
import type { createTopicSchema, updateTopicSchema } from '../validators/product.validator';
import { auditService } from './audit.service';
import { scopeService } from './scope.service';

type CreateTopic = z.infer<typeof createTopicSchema>;
type UpdateTopic = z.infer<typeof updateTopicSchema>;

export interface TopicNode extends ProductTopic {
  questionCount: number;
  children: TopicNode[];
}

async function assertNameAvailable(productId: string, parentId: string | null, name: string, excludeId?: string) {
  const clash = await prisma.productTopic.findFirst({
    where: {
      productId,
      parentId,
      deletedAt: null,
      name: { equals: name, mode: 'insensitive' },
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
  });
  if (clash) throw AppError.conflict(`"${name}" already exists at this level.`, 'DUPLICATE_TOPIC');
}

export const topicService = {
  /** Topics of a product as a two-level tree (topic -> subtopics) with question counts. */
  async tree(ctx: RequestContext, productId: string, includeInactive = true): Promise<TopicNode[]> {
    scopeService.assertProductAccess(ctx.user, productId);
    const topics = await prisma.productTopic.findMany({
      where: { productId, deletedAt: null, ...(includeInactive ? {} : { status: 'ACTIVE' }) },
      orderBy: [{ sequence: 'asc' }, { name: 'asc' }],
    });
    const [byTopic, bySub] = await Promise.all([
      prisma.question.groupBy({ by: ['topicId'], where: { productId, deletedAt: null }, _count: true }),
      prisma.question.groupBy({ by: ['subTopicId'], where: { productId, deletedAt: null, subTopicId: { not: null } }, _count: true }),
    ]);
    const topicCounts = new Map(byTopic.map((r) => [r.topicId, r._count]));
    const subCounts = new Map(bySub.map((r) => [r.subTopicId!, r._count]));

    const nodes = new Map<string, TopicNode>(
      topics.map((t) => [t.id, { ...t, questionCount: t.parentId ? subCounts.get(t.id) ?? 0 : topicCounts.get(t.id) ?? 0, children: [] }]),
    );
    const roots: TopicNode[] = [];
    for (const node of nodes.values()) {
      if (node.parentId && nodes.has(node.parentId)) nodes.get(node.parentId)!.children.push(node);
      else if (!node.parentId) roots.push(node);
    }
    return roots;
  },

  async create(ctx: RequestContext, input: CreateTopic) {
    scopeService.assertProductAccess(ctx.user, input.productId);
    const product = await prisma.product.findFirst({ where: { id: input.productId, deletedAt: null } });
    if (!product) throw AppError.notFound('Product');
    const parentId = input.parentId ?? null;
    if (parentId) {
      const parent = await prisma.productTopic.findFirst({ where: { id: parentId, deletedAt: null } });
      if (!parent || parent.productId !== input.productId) throw AppError.badRequest('Parent topic not found in this product.', 'INVALID_PARENT');
      if (parent.parentId) throw AppError.badRequest('Only two levels are supported: topic and subtopic.', 'TOPIC_DEPTH');
    }
    await assertNameAvailable(input.productId, parentId, input.name);
    const sequence =
      input.sequence ??
      (await prisma.productTopic.count({ where: { productId: input.productId, parentId, deletedAt: null } })) + 1;
    const topic = await prisma.productTopic.create({
      data: { productId: input.productId, parentId, name: input.name, description: input.description ?? null, sequence },
    });
    await auditService.log(ctx, parentId ? 'SUBTOPIC_CREATED' : 'TOPIC_CREATED', 'ProductTopic', topic.id, undefined, topic);
    return topic;
  },

  async update(ctx: RequestContext, id: string, input: UpdateTopic) {
    const existing = await prisma.productTopic.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw AppError.notFound('Topic');
    scopeService.assertProductAccess(ctx.user, existing.productId);
    if (input.name && input.name !== existing.name) {
      await assertNameAvailable(existing.productId, existing.parentId, input.name, id);
    }
    const topic = await prisma.productTopic.update({ where: { id }, data: input });
    await auditService.log(ctx, 'TOPIC_UPDATED', 'ProductTopic', id, existing, topic);
    return topic;
  },

  async remove(ctx: RequestContext, id: string) {
    const existing = await prisma.productTopic.findFirst({ where: { id, deletedAt: null }, include: { children: { where: { deletedAt: null } } } });
    if (!existing) throw AppError.notFound('Topic');
    scopeService.assertProductAccess(ctx.user, existing.productId);
    const used = await prisma.question.count({
      where: { deletedAt: null, OR: [{ topicId: id }, { subTopicId: id }, ...existing.children.map((c) => ({ subTopicId: c.id }))] },
    });
    if (used) {
      throw AppError.conflict(
        `This topic is used by ${used} question(s). Deactivate it instead, or move the questions first.`,
        'TOPIC_IN_USE',
      );
    }
    const now = new Date();
    await prisma.productTopic.updateMany({ where: { OR: [{ id }, { parentId: id }] }, data: { deletedAt: now } });
    await auditService.log(ctx, 'TOPIC_DELETED', 'ProductTopic', id, existing, undefined);
  },
};
