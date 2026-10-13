import type { RoleCode } from '../config/permissions';

export interface AuthUser {
  id: string;
  employeeId: string;
  email: string;
  firstName: string;
  lastName: string;
  roleCode: RoleCode | string;
  permissions: Set<string>;
  managerId: string | null;
  /** Product ids a PRODUCT_ADMIN may manage. `null` means unrestricted. */
  productScope: string[] | null;
}

/** Everything a service needs to know about the caller, independent of Express. */
export interface RequestContext {
  user: AuthUser;
  ipAddress?: string;
  userAgent?: string;
}

export interface JwtAccessPayload {
  sub: string;
  role: string;
  type: 'access';
}
