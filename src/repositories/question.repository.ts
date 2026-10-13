import type { DifficultyLevel, Prisma, QuestionStatus, QuestionType } from '@prisma/client';
import { prisma } from '../config/database';
import { buildPagination, resolveSort, toSkipTake, type PageQuery } from '../utils/pagination';

export interface QuestionFilter extends PageQuery {
  productId?: string;
  topicId?: string;
  subTopicId?: string;
  difficultyLevel?: DifficultyLevel;
  status?: QuestionStatus;
  questionType?: QuestionType;
  createdById?: string;
  excludeIds?: string[];
  productScope?: string[] | null;
}

const SORT = ['createdAt', 'updatedAt', 'questionNo', 'difficultyLevel', 'marks', 'status'] as const;

export const questionInclude = {
  product: { select: { id: true, productCode: true, productName: true } },
  topic: { select: { id: true, name: true } },
  subTopic: { select: { id: true, name: true } },
  createdBy: { select: { id: true, firstName: true, lastName: true } },
  options: { orderBy: { sequence: 'asc' } },
  attachments: { orderBy: [{ sequence: 'asc' }, { createdAt: 'asc' }] },
} satisfies Prisma.QuestionInclude;

export function buildQuestionWhere(f: Omit<QuestionFilter, 'page' | 'pageSize' | 'sortOrder' | 'sortBy'>): Prisma.QuestionWhereInput {
  const search = f.search?.trim();
  const qNo = search && /^q?\d+$/i.test(search) ? Number(search.replace(/^q/i, '')) : undefined;
  return {
    deletedAt: null,
    ...(f.productScope ? { productId: { in: f.productScope } } : {}),
    ...(f.productId ? { productId: f.productId } : {}),
    ...(f.topicId ? { topicId: f.topicId } : {}),
    ...(f.subTopicId ? { subTopicId: f.subTopicId } : {}),
    ...(f.difficultyLevel ? { difficultyLevel: f.difficultyLevel } : {}),
    ...(f.status ? { status: f.status } : {}),
    ...(f.questionType ? { questionType: f.questionType } : {}),
    ...(f.createdById ? { createdById: f.createdById } : {}),
    ...(f.excludeIds?.length ? { id: { notIn: f.excludeIds } } : {}),
    ...(search
      ? {
          OR: [
            { questionText: { contains: search, mode: 'insensitive' } },
            { explanation: { contains: search, mode: 'insensitive' } },
            ...(qNo !== undefined && Number.isSafeInteger(qNo) && qNo < 2_147_483_647 ? [{ questionNo: qNo }] : []),
          ],
        }
      : {}),
  };
}

export const questionRepository = {
  async list(f: QuestionFilter) {
    const where = buildQuestionWhere(f);
    const sortBy = resolveSort(f.sortBy, SORT, 'createdAt');
    const [rows, total] = await Promise.all([
      prisma.question.findMany({ where, include: questionInclude, orderBy: { [sortBy]: f.sortOrder }, ...toSkipTake(f) }),
      prisma.question.count({ where }),
    ]);
    return { rows, pagination: buildPagination(f, total) };
  },

  findById(id: string) {
    return prisma.question.findFirst({ where: { id, deletedAt: null }, include: questionInclude });
  },

  /** Hashes of existing (non-deleted) questions for a product, used for duplicate detection. */
  async existingHashes(productIds: string[]) {
    const rows = await prisma.question.findMany({
      where: { productId: { in: productIds }, deletedAt: null },
      select: { id: true, questionNo: true, contentHash: true },
    });
    return new Map(rows.map((r) => [r.contentHash, r]));
  },
};
