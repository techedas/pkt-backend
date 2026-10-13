import type { AssessmentAssignment, AssignmentType, Prisma, User } from '@prisma/client';
import { prisma } from '../config/database';

/**
 * Assignments are stored against a target (a user, team, department, role, ...)
 * and resolved to users at read time, so people who join a team later
 * automatically receive the team's assessments.
 */
export function usersWhereForTarget(type: AssignmentType, reference: string): Prisma.UserWhereInput {
  const base: Prisma.UserWhereInput = { deletedAt: null };
  switch (type) {
    case 'USER':
      return { ...base, id: reference };
    case 'TEAM':
      return { ...base, team: { equals: reference, mode: 'insensitive' } };
    case 'DEPARTMENT':
      return { ...base, department: { equals: reference, mode: 'insensitive' } };
    case 'ROLE':
      return { ...base, role: { code: reference } };
    case 'PRODUCT_GROUP':
      return { ...base, productGroup: { equals: reference, mode: 'insensitive' } };
    case 'LOCATION':
      return { ...base, location: { equals: reference, mode: 'insensitive' } };
  }
}

/** Prisma filter selecting the assignments that apply to a given user. */
export function assignmentsWhereForUser(
  user: Pick<User, 'id' | 'team' | 'department' | 'productGroup' | 'location'> & { roleCode: string },
): Prisma.AssessmentAssignmentWhereInput {
  return {
    status: 'ACTIVE',
    assignmentType: 'USER',
    assignmentReference: user.id,
  };
}

/** Resolve the set of active user ids covered by an assessment's active assignments. */
export async function assignedUserIds(assessmentId: string, restrictTo?: string[] | null): Promise<string[]> {
  const assignments = await prisma.assessmentAssignment.findMany({ where: { assessmentId, status: 'ACTIVE' } });
  if (!assignments.length) return [];
  const users = await prisma.user.findMany({
    where: {
      status: 'ACTIVE',
      OR: assignments.map((a) => usersWhereForTarget(a.assignmentType, a.assignmentReference)),
      ...(restrictTo ? { id: { in: restrictTo } } : {}),
    },
    select: { id: true },
  });
  return users.map((u) => u.id);
}

/** Due date that applies to a user: the latest due date among matching assignments, or none if any has none. */
export function effectiveDueDate(assignments: Pick<AssessmentAssignment, 'dueDate'>[]): Date | null {
  if (!assignments.length || assignments.some((a) => !a.dueDate)) return null;
  return new Date(Math.max(...assignments.map((a) => a.dueDate!.getTime())));
}

/** Load the full user context needed to match assignments. */
export async function loadAssignmentUser(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, include: { role: { select: { code: true } } } });
  return { ...user, roleCode: user.role.code };
}
