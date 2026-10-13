import bcrypt from 'bcryptjs';
import type { Role, User } from '@prisma/client';
import { prisma } from '../../config/database';

export type UserWithRole = User & { role: Role };

/**
 * Authentication provider abstraction. LOCAL (password) is implemented now;
 * SSO / LDAP / Azure AD providers can implement the same interface and be
 * selected per user through `User.authProvider`.
 */
export interface AuthProvider {
  readonly name: string;
  authenticate(identifier: string, secret: string): Promise<UserWithRole | null>;
}

// Pre-computed hash used to keep response time constant when the user does not exist.
const DUMMY_HASH = bcrypt.hashSync('pkt-timing-safe-dummy-password', 10);

export class LocalAuthProvider implements AuthProvider {
  readonly name = 'LOCAL';

  async authenticate(identifier: string, password: string) {
    const id = identifier.trim();
    const user = await prisma.user.findFirst({
      where: {
        deletedAt: null,
        OR: [{ email: { equals: id, mode: 'insensitive' } }, { employeeId: { equals: id, mode: 'insensitive' } }],
      },
      include: { role: true },
    });
    const valid = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
    return user && valid ? user : null;
  }
}

const providers: Record<string, AuthProvider> = { LOCAL: new LocalAuthProvider() };

export function getAuthProvider(name = 'LOCAL'): AuthProvider {
  return providers[name] ?? providers.LOCAL;
}

export const hashPassword = (password: string) => bcrypt.hash(password, 12);
export const verifyPassword = (password: string, hash: string) => bcrypt.compare(password, hash);
