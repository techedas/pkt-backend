import type { Role, User } from '@prisma/client';
import { fullName } from '../utils/helpers';

type UserLike = User & {
  role?: Pick<Role, 'id' | 'code' | 'name'> | null;
  manager?: Pick<User, 'id' | 'firstName' | 'lastName' | 'email'> | null;
};

/** Public representation of a user. Never includes the password hash. */
export function toUserDto(u: UserLike) {
  return {
    id: u.id,
    employeeId: u.employeeId,
    firstName: u.firstName,
    lastName: u.lastName,
    fullName: fullName(u),
    email: u.email,
    mobile: u.mobile,
    department: u.department,
    designation: u.designation,
    team: u.team,
    productGroup: u.productGroup,
    location: u.location,
    managerId: u.managerId,
    manager: u.manager ? { id: u.manager.id, fullName: fullName(u.manager), email: u.manager.email } : null,
    roleId: u.roleId,
    role: u.role ? { id: u.role.id, code: u.role.code, name: u.role.name } : null,
    status: u.status,
    mustChangePassword: u.mustChangePassword,
    lastLogin: u.lastLogin,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  };
}

export type UserDto = ReturnType<typeof toUserDto>;
