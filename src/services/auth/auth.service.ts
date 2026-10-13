import jwt from 'jsonwebtoken';
import { prisma } from '../../config/database';
import { env } from '../../config/env';
import type { JwtAccessPayload } from '../../types/auth';
import { AppError } from '../../utils/errors';
import { parseDurationMs, randomToken, sha256 } from '../../utils/helpers';
import { logger } from '../../utils/logger';
import { auditService } from '../audit.service';
import { settingsService } from '../settings.service';
import { toUserDto } from '../../dtos/user.dto';
import { assertPasswordPolicy } from './passwordPolicy';
import { getAuthProvider, hashPassword, verifyPassword } from './providers';

interface ClientInfo {
  ipAddress?: string;
  userAgent?: string;
}

const RESET_TOKEN_TTL_MS = 30 * 60_000;

function signAccessToken(userId: string, role: string) {
  const payload: JwtAccessPayload = { sub: userId, role, type: 'access' };
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRY as jwt.SignOptions['expiresIn'] });
}

/**
 * Refresh tokens are JWTs signed with the refresh secret whose `jti` points at a
 * row in `refresh_tokens`. Only a hash of the token is stored. Every refresh
 * rotates the token; presenting an already rotated token revokes the whole
 * session family (token theft detection).
 */
async function issueRefreshToken(userId: string, client: ClientInfo) {
  const ttlMs = parseDurationMs(env.REFRESH_TOKEN_EXPIRY);
  const record = await prisma.refreshToken.create({
    data: {
      userId,
      tokenHash: sha256(randomToken()), // placeholder, replaced below once the JWT exists
      expiresAt: new Date(Date.now() + ttlMs),
      userAgent: client.userAgent ?? null,
      ipAddress: client.ipAddress ?? null,
    },
  });
  const token = jwt.sign({ sub: userId, jti: record.id, type: 'refresh' }, env.JWT_REFRESH_SECRET, {
    expiresIn: Math.floor(ttlMs / 1000),
  });
  await prisma.refreshToken.update({ where: { id: record.id }, data: { tokenHash: sha256(token) } });
  return { token, expiresAt: record.expiresAt };
}

async function buildSession(userId: string, client: ClientInfo) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    include: { role: { include: { permissions: { include: { permission: true } } } } },
  });
  const accessToken = signAccessToken(user.id, user.role.code);
  const refresh = await issueRefreshToken(user.id, client);
  return {
    accessToken,
    accessTokenExpiresIn: env.JWT_EXPIRY,
    refreshToken: refresh.token,
    refreshTokenExpiresAt: refresh.expiresAt,
    user: {
      ...toUserDto(user),
      permissions: user.role.permissions.map((rp) => rp.permission.code),
    },
  };
}

export const authService = {
  async login(identifier: string, password: string, client: ClientInfo) {
    const user = await getAuthProvider('LOCAL').authenticate(identifier, password);
    if (!user) {
      await auditService.log({ ...client, user: null }, 'LOGIN_FAILED', 'User', null, undefined, { identifier });
      throw AppError.unauthorized('Invalid Employee ID / Email or password.', 'INVALID_CREDENTIALS');
    }
    if (user.status !== 'ACTIVE') {
      throw AppError.forbidden('Your account is disabled. Please contact your administrator.', 'ACCOUNT_DISABLED');
    }
    await prisma.user.update({ where: { id: user.id }, data: { lastLogin: new Date() } });
    await auditService.log({ ...client, user }, 'LOGIN', 'User', user.id);
    return buildSession(user.id, client);
  },

  async refresh(token: string | undefined, client: ClientInfo) {
    if (!token) throw AppError.unauthorized('Session expired. Please log in again.', 'SESSION_EXPIRED');
    let payload: { sub: string; jti: string; type: string };
    try {
      payload = jwt.verify(token, env.JWT_REFRESH_SECRET) as typeof payload;
    } catch {
      throw AppError.unauthorized('Session expired. Please log in again.', 'SESSION_EXPIRED');
    }
    if (payload.type !== 'refresh') throw AppError.unauthorized('Invalid session.', 'SESSION_EXPIRED');

    const record = await prisma.refreshToken.findUnique({ where: { id: payload.jti } });
    if (!record || record.tokenHash !== sha256(token) || record.userId !== payload.sub) {
      throw AppError.unauthorized('Invalid session.', 'SESSION_EXPIRED');
    }
    if (record.revokedAt) {
      // A rotated token was replayed: assume theft and end every session of this user.
      await prisma.refreshToken.updateMany({ where: { userId: record.userId, revokedAt: null }, data: { revokedAt: new Date() } });
      logger.warn('Refresh token reuse detected', { userId: record.userId });
      throw AppError.unauthorized('Session expired. Please log in again.', 'SESSION_EXPIRED');
    }
    const timeoutMin = await settingsService.get('sessionTimeoutMinutes');
    const idleMs = Date.now() - record.lastUsedAt.getTime();
    if (record.expiresAt < new Date() || idleMs > timeoutMin * 60_000) {
      await prisma.refreshToken.update({ where: { id: record.id }, data: { revokedAt: new Date() } });
      throw AppError.unauthorized('Session timed out due to inactivity. Please log in again.', 'SESSION_EXPIRED');
    }

    const user = await prisma.user.findFirst({ where: { id: record.userId, deletedAt: null, status: 'ACTIVE' } });
    if (!user) throw AppError.unauthorized('Account is disabled.', 'ACCOUNT_DISABLED');

    await prisma.refreshToken.update({ where: { id: record.id }, data: { revokedAt: new Date() } });
    return buildSession(user.id, client);
  },

  async logout(token: string | undefined) {
    if (!token) return;
    await prisma.refreshToken.updateMany({ where: { tokenHash: sha256(token), revokedAt: null }, data: { revokedAt: new Date() } });
  },

  async me(userId: string) {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: {
        role: { include: { permissions: { include: { permission: true } } } },
        manager: { select: { id: true, firstName: true, lastName: true, email: true } },
      },
    });
    return { ...toUserDto(user), permissions: user.role.permissions.map((rp) => rp.permission.code) };
  },

  /**
   * Starts the password reset flow. Always succeeds from the caller's point of view so
   * the endpoint cannot be used to discover which accounts exist.
   * No e-mail channel exists yet: the reset link is logged, and in non-production
   * environments it is also returned to make local testing possible.
   */
  async forgotPassword(identifier: string, client: ClientInfo) {
    const id = identifier.trim();
    const user = await prisma.user.findFirst({
      where: {
        deletedAt: null,
        status: 'ACTIVE',
        OR: [{ email: { equals: id, mode: 'insensitive' } }, { employeeId: { equals: id, mode: 'insensitive' } }],
      },
    });
    if (!user) return { devResetToken: undefined as string | undefined };

    const token = randomToken();
    await prisma.passwordResetToken.create({
      data: { userId: user.id, tokenHash: sha256(token), expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS) },
    });
    const link = `${env.corsOrigins[0] ?? ''}/reset-password?token=${token}`;
    logger.info('Password reset requested', { userId: user.id, ...(env.isProduction ? {} : { link }) });
    await auditService.log({ ...client, user }, 'PASSWORD_RESET_REQUESTED', 'User', user.id);
    return { devResetToken: env.isProduction ? undefined : token };
  },

  async resetPassword(token: string, newPassword: string, client: ClientInfo) {
    const record = await prisma.passwordResetToken.findUnique({ where: { tokenHash: sha256(token) } });
    if (!record || record.usedAt || record.expiresAt < new Date()) {
      throw AppError.badRequest('This reset link is invalid or has expired.', 'INVALID_RESET_TOKEN');
    }
    await assertPasswordPolicy(newPassword);
    const passwordHash = await hashPassword(newPassword);
    await prisma.$transaction([
      prisma.user.update({ where: { id: record.userId }, data: { passwordHash, mustChangePassword: false } }),
      prisma.passwordResetToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
      prisma.refreshToken.updateMany({ where: { userId: record.userId, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    await auditService.log({ ...client, user: { id: record.userId } }, 'PASSWORD_RESET', 'User', record.userId);
  },

  async changePassword(userId: string, currentPassword: string, newPassword: string, client: ClientInfo) {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!(await verifyPassword(currentPassword, user.passwordHash))) {
      throw AppError.badRequest('Current password is incorrect.', 'INVALID_PASSWORD');
    }
    if (currentPassword === newPassword) {
      throw AppError.badRequest('New password must be different from the current password.', 'PASSWORD_REUSED');
    }
    await assertPasswordPolicy(newPassword);
    await prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await hashPassword(newPassword), mustChangePassword: false },
    });
    await auditService.log({ ...client, user }, 'PASSWORD_CHANGED', 'User', userId);
  },
};
