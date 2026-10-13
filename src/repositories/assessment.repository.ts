import type { DifficultyLevel, Prisma } from '@prisma/client';
import { prisma, type Tx } from '../config/database';
import type { DifficultyDistribution, PoolQuestion } from '../models/questionSelection';

export const assessmentDetailInclude = {
  product: { select: { id: true, productCode: true, productName: true, status: true } },
  createdBy: { select: { id: true, firstName: true, lastName: true } },
  questions: {
    orderBy: { sequence: 'asc' },
    include: {
      question: {
        select: {
          id: true, questionNo: true, questionText: true, difficultyLevel: true, marks: true, negativeMarks: true,
          status: true, deletedAt: true, topic: { select: { id: true, name: true } }, subTopic: { select: { id: true, name: true } },
        },
      },
    },
  },
  rules: {
    orderBy: { sequence: 'asc' },
    include: { topic: { select: { id: true, name: true } }, subTopic: { select: { id: true, name: true } } },
  },
  difficultyDistribution: true,
  _count: { select: { assignments: { where: { status: 'ACTIVE' } }, attempts: true, versions: true } },
} satisfies Prisma.AssessmentInclude;

export type AssessmentDetail = Prisma.AssessmentGetPayload<{ include: typeof assessmentDetailInclude }>;

export const versionDetailInclude = {
  questions: {
    orderBy: { sequence: 'asc' },
    include: { question: { select: { id: true, questionNo: true, questionText: true, difficultyLevel: true, marks: true } } },
  },
  rules: {
    orderBy: { sequence: 'asc' },
    include: { topic: { select: { id: true, name: true } }, subTopic: { select: { id: true, name: true } } },
  },
  distribution: true,
} satisfies Prisma.AssessmentVersionInclude;

/** {EASY: 10, ...} <-> distribution rows. */
export function distributionToObject(rows: Array<{ difficultyLevel: DifficultyLevel; questionCount: number }>): DifficultyDistribution | null {
  if (!rows.length) return null;
  return Object.fromEntries(rows.map((r) => [r.difficultyLevel, r.questionCount])) as DifficultyDistribution;
}

export function distributionToRows(d: DifficultyDistribution | null | undefined) {
  return Object.entries(d ?? {})
    .filter(([, n]) => typeof n === 'number' && n > 0)
    .map(([difficultyLevel, questionCount]) => ({ difficultyLevel: difficultyLevel as DifficultyLevel, questionCount: questionCount as number }));
}

/** The version new attempts run under (highest version number). */
export function latestVersion(assessmentId: string, tx: Tx = prisma) {
  return tx.assessmentVersion.findFirst({ where: { assessmentId }, orderBy: { versionNumber: 'desc' } });
}

/** Questions that may be served: ACTIVE, not deleted, and under an active topic/subtopic. */
export const activeQuestionWhere = (productId: string): Prisma.QuestionWhereInput => ({
  productId,
  deletedAt: null,
  status: 'ACTIVE',
  topic: { deletedAt: null, status: 'ACTIVE' },
  OR: [{ subTopicId: null }, { subTopic: { deletedAt: null, status: 'ACTIVE' } }],
});

export const assessmentRepository = {
  findDetail(id: string, tx: Tx = prisma) {
    return tx.assessment.findFirst({ where: { id, deletedAt: null }, include: assessmentDetailInclude });
  },

  async loadPool(productId: string, tx: Tx = prisma): Promise<Array<PoolQuestion & { marks: number }>> {
    return tx.question.findMany({
      where: activeQuestionWhere(productId),
      select: { id: true, topicId: true, subTopicId: true, difficultyLevel: true, marks: true },
    });
  },
};
