import { prisma } from '../config/database';
import { ROLE_CODES } from '../config/permissions';
import type { AuthUser } from '../types/auth';
import { AppError } from '../utils/errors';

/**
 * Data-scope rules layered on top of permissions:
 * - PRODUCT_ADMIN: only products assigned to them (user_products).
 * - MANAGER: only users who report to them (directly or indirectly) for people data.
 * Every other role with the relevant permission sees everything.
 */
export const scopeService = {
  /** Product ids the user may access, or null for "all products". */
  productIds(user: AuthUser): string[] | null {
    return user.productScope;
  },

  assertProductAccess(user: AuthUser, productId: string) {
    if (user.productScope && !user.productScope.includes(productId)) {
      throw AppError.forbidden('You do not have access to this product.', 'PRODUCT_ACCESS_DENIED');
    }
  },

  /** Prisma filter fragment for tables with a `productId` column. */
  productFilter(user: AuthUser): { productId?: { in: string[] } } {
    return user.productScope ? { productId: { in: user.productScope } } : {};
  },

  isManagerScoped(user: AuthUser) {
    return user.roleCode === ROLE_CODES.MANAGER;
  },

  /**
   * User ids visible to the caller in people-centric reports, or null for "everyone".
   * Managers see their whole reporting tree.
   */
  async teamUserIds(user: AuthUser): Promise<string[] | null> {
    if (!this.isManagerScoped(user)) return null;
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      WITH RECURSIVE team AS (
        SELECT id FROM users WHERE manager_id = ${user.id}::uuid AND deleted_at IS NULL
        UNION
        SELECT u.id FROM users u JOIN team t ON u.manager_id = t.id WHERE u.deleted_at IS NULL
      )
      SELECT id::text AS id FROM team`;
    return rows.map((r) => r.id);
  },

  async assertUserAccess(user: AuthUser, targetUserId: string) {
    const ids = await this.teamUserIds(user);
    if (ids && !ids.includes(targetUserId) && targetUserId !== user.id) {
      throw AppError.forbidden('This user is not part of your team.', 'USER_ACCESS_DENIED');
    }
  },
};
