import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { prisma } from '../config/database';
import { ROLE_CODES } from '../config/permissions';
import type { AuthUser, JwtAccessPayload, RequestContext } from '../types/auth';
import { AppError } from '../utils/errors';

/** Load the caller's identity, role permissions and product scope. */
export async function loadAuthUser(userId: string): Promise<AuthUser | null> {
  const user = await prisma.user.findFirst({
    where: { id: userId, deletedAt: null, status: 'ACTIVE' },
    include: {
      role: { include: { permissions: { include: { permission: true } } } },
      managedProducts: { select: { productId: true } },
    },
  });
  if (!user) return null;
  return {
    id: user.id,
    employeeId: user.employeeId,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    roleCode: user.role.code,
    permissions: new Set(user.role.permissions.map((rp) => rp.permission.code)),
    managerId: user.managerId,
    productScope:
      user.role.code === ROLE_CODES.PRODUCT_ADMIN ? user.managedProducts.map((p) => p.productId) : null,
  };
}

/** Require a valid access token. Populates `req.user`. */
export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw AppError.unauthorized();
    const token = header.slice(7);

    let payload: JwtAccessPayload;
    try {
      payload = jwt.verify(token, env.JWT_SECRET) as JwtAccessPayload;
    } catch (err) {
      if (err instanceof jwt.TokenExpiredError) throw AppError.unauthorized('Session expired.', 'TOKEN_EXPIRED');
      throw AppError.unauthorized('Invalid token.', 'INVALID_TOKEN');
    }
    if (payload.type !== 'access') throw AppError.unauthorized('Invalid token.', 'INVALID_TOKEN');

    const user = await loadAuthUser(payload.sub);
    if (!user) throw AppError.unauthorized('Account is disabled or no longer exists.', 'ACCOUNT_DISABLED');
    req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

/** Require at least one of the given permissions. */
export const requirePermission =
  (...codes: string[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    const user = req.user;
    if (!user) return next(AppError.unauthorized());
    if (codes.some((c) => user.permissions.has(c))) return next();
    return next(AppError.forbidden());
  };

/** Build the service-level context from an authenticated request. */
export function ctxOf(req: Request): RequestContext {
  if (!req.user) throw AppError.unauthorized();
  return {
    user: req.user,
    ipAddress: req.ip,
    userAgent: req.get('user-agent')?.slice(0, 500),
  };
}
