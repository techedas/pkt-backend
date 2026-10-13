import { prisma } from '../config/database';
import { DEFAULT_ROLES, PERMISSION_DESCRIPTIONS, type PermissionCode, ROLE_CODES } from '../config/permissions';
import type { RequestContext } from '../types/auth';
import { AppError } from '../utils/errors';
import { logger } from '../utils/logger';
import { auditService } from './audit.service';

export const roleService = {
  async list() {
    const roles = await prisma.role.findMany({
      orderBy: { name: 'asc' },
      include: {
        permissions: { include: { permission: true } },
        _count: { select: { users: { where: { deletedAt: null } } } },
      },
    });
    return roles.map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      description: r.description,
      isSystem: r.isSystem,
      userCount: r._count.users,
      permissions: r.permissions.map((rp) => rp.permission.code).sort(),
      allowedPermissions: (DEFAULT_ROLES.find((dr) => dr.code === r.code)?.permissions ?? []) as string[],
    }));
  },

  listPermissions() {
    return prisma.permission.findMany({ orderBy: [{ module: 'asc' }, { code: 'asc' }] });
  },

  async updatePermissions(ctx: RequestContext, roleId: string, permissionCodes: string[]) {
    const role = await prisma.role.findUnique({ where: { id: roleId }, include: { permissions: { include: { permission: true } } } });
    if (!role) throw AppError.notFound('Role');
    if (role.code === ROLE_CODES.SUPER_ADMIN) {
      throw AppError.badRequest('Super Admin permissions cannot be reduced.', 'PROTECTED_ROLE');
    }
    const defaultRole = DEFAULT_ROLES.find((dr) => dr.code === role.code);
    if (defaultRole) {
      const disallowed = permissionCodes.filter((p) => !defaultRole.permissions.includes(p as PermissionCode));
      if (disallowed.length > 0) {
        throw AppError.badRequest(`Permissions [${disallowed.join(', ')}] are not applicable for role ${role.name}.`, 'DISALLOWED_PERMISSION');
      }
    }
    const permissions = await prisma.permission.findMany({ where: { code: { in: permissionCodes } } });
    if (permissions.length !== new Set(permissionCodes).size) {
      throw AppError.badRequest('One or more permissions are unknown.', 'UNKNOWN_PERMISSION');
    }
    await prisma.$transaction([
      prisma.rolePermission.deleteMany({ where: { roleId } }),
      prisma.rolePermission.createMany({ data: permissions.map((p) => ({ roleId, permissionId: p.id })) }),
    ]);
    await auditService.log(
      ctx,
      'ROLE_PERMISSIONS_UPDATED',
      'Role',
      roleId,
      { permissions: role.permissions.map((rp) => rp.permission.code) },
      { permissions: permissionCodes },
    );
    return (await this.list()).find((r) => r.id === roleId);
  },

  async syncDefaultRolePermissions() {
    for (const [code, description] of Object.entries(PERMISSION_DESCRIPTIONS)) {
      await prisma.permission.upsert({
        where: { code },
        create: { code, description, module: code.split(':')[0] },
        update: { description, module: code.split(':')[0] },
      });
    }
    const permissions = new Map((await prisma.permission.findMany()).map((p) => [p.code, p.id]));
    for (const roleDef of DEFAULT_ROLES) {
      const role = await prisma.role.upsert({
        where: { code: roleDef.code },
        create: { code: roleDef.code, name: roleDef.name, description: roleDef.description, isSystem: true },
        update: { name: roleDef.name, description: roleDef.description, isSystem: true },
      });
      await prisma.rolePermission.deleteMany({ where: { roleId: role.id } });
      const targetPermIds = roleDef.permissions
        .map((p) => permissions.get(p))
        .filter((id): id is string => Boolean(id));
      if (targetPermIds.length > 0) {
        await prisma.rolePermission.createMany({
          data: targetPermIds.map((permissionId) => ({ roleId: role.id, permissionId })),
          skipDuplicates: true,
        });
      }
    }
    logger.info('✔ Synced default role permissions to match specification matrix');
  },
};
