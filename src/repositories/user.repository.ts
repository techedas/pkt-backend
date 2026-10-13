import type { Prisma, UserStatus } from '@prisma/client';
import { prisma } from '../config/database';
import { buildPagination, resolveSort, toSkipTake, type PageQuery } from '../utils/pagination';

export interface UserFilter extends PageQuery {
  roleId?: string;
  roleCode?: string;
  department?: string;
  team?: string;
  location?: string;
  status?: UserStatus;
  managerId?: string;
  /** Restrict to these ids (manager scope). */
  ids?: string[] | null;
}

const USER_SORT = ['createdAt', 'firstName', 'lastName', 'employeeId', 'email', 'department', 'lastLogin'] as const;

export const userInclude = {
  role: { select: { id: true, code: true, name: true } },
  manager: { select: { id: true, firstName: true, lastName: true, email: true } },
} satisfies Prisma.UserInclude;

export function buildUserWhere(f: Omit<UserFilter, 'page' | 'pageSize' | 'sortOrder' | 'sortBy'>): Prisma.UserWhereInput {
  return {
    deletedAt: null,
    ...(f.ids ? { id: { in: f.ids } } : {}),
    ...(f.roleId ? { roleId: f.roleId } : {}),
    ...(f.roleCode ? { role: { code: f.roleCode } } : {}),
    ...(f.department ? { department: f.department } : {}),
    ...(f.team ? { team: f.team } : {}),
    ...(f.location ? { location: f.location } : {}),
    ...(f.status ? { status: f.status } : {}),
    ...(f.managerId ? { managerId: f.managerId } : {}),
    ...(f.search
      ? {
          OR: [
            { employeeId: { contains: f.search, mode: 'insensitive' } },
            { firstName: { contains: f.search, mode: 'insensitive' } },
            { lastName: { contains: f.search, mode: 'insensitive' } },
            { email: { contains: f.search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };
}

export const userRepository = {
  async list(f: UserFilter) {
    const where = buildUserWhere(f);
    const sortBy = resolveSort(f.sortBy, USER_SORT, 'createdAt');
    const [rows, total] = await Promise.all([
      prisma.user.findMany({ where, include: userInclude, orderBy: { [sortBy]: f.sortOrder }, ...toSkipTake(f) }),
      prisma.user.count({ where }),
    ]);
    return { rows, pagination: buildPagination(f, total) };
  },

  findById(id: string) {
    return prisma.user.findFirst({
      where: { id, deletedAt: null },
      include: { ...userInclude, managedProducts: { include: { product: { select: { id: true, productCode: true, productName: true } } } } },
    });
  },

  /** Distinct organisational values, used to populate filters and assignment targets. */
  async lookups() {
    const [departments, teams, locations, productGroups, designations] = await Promise.all(
      (['department', 'team', 'location', 'productGroup', 'designation'] as const).map((field) =>
        prisma.user
          .findMany({
            where: { deletedAt: null, [field]: { not: null } },
            distinct: [field],
            select: { [field]: true },
            orderBy: { [field]: 'asc' },
          })
          .then((rows) => rows.map((r) => (r as unknown as Record<string, string>)[field]).filter(Boolean)),
      ),
    );
    return { departments, teams, locations, productGroups, designations };
  },
};
