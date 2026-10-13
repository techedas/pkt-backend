import crypto from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { z } from 'zod';
import { prisma } from '../config/database';
import { ROLE_CODES } from '../config/permissions';
import { toUserDto } from '../dtos/user.dto';
import { userInclude, userRepository, type UserFilter } from '../repositories/user.repository';
import type { RequestContext } from '../types/auth';
import { AppError } from '../utils/errors';
import type { SheetRow } from '../utils/spreadsheet';
import type { bulkUserRowSchema, createUserSchema, updateUserSchema } from '../validators/user.validator';
import { bulkUserRowSchema as rowSchema } from '../validators/user.validator';
import { auditService } from './audit.service';
import { assertPasswordPolicy } from './auth/passwordPolicy';
import { hashPassword } from './auth/providers';
import { scopeService } from './scope.service';

type CreateUserInput = z.infer<typeof createUserSchema>;
type UpdateUserInput = z.infer<typeof updateUserSchema>;
type BulkUserRow = z.infer<typeof bulkUserRowSchema>;

/** Temporary password that always satisfies the default password policy. */
function generateTempPassword() {
  const pick = (chars: string) => chars[crypto.randomInt(chars.length)];
  const base = crypto.randomBytes(6).toString('base64url').replace(/[^A-Za-z0-9]/g, 'x');
  return `${pick('ABCDEFGHJKLMNPQRSTUVWXYZ')}${pick('abcdefghijkmnpqrstuvwxyz')}${pick('23456789')}${base}!`;
}

async function assertManagerValid(userId: string | null, managerId: string | null | undefined) {
  if (!managerId) return;
  if (managerId === userId) throw AppError.badRequest('A user cannot be their own manager.', 'INVALID_MANAGER');
  const manager = await prisma.user.findFirst({ where: { id: managerId, deletedAt: null }, include: { role: true } });
  if (!manager) throw AppError.badRequest('Selected manager does not exist.', 'INVALID_MANAGER');
  if (manager.role.code !== ROLE_CODES.MANAGER) {
    throw AppError.badRequest('Selected manager must have the Manager role.', 'INVALID_MANAGER');
  }
  if (!userId) return;
  // Walk up the chain to prevent reporting cycles.
  let cursor: string | null = manager.managerId;
  for (let depth = 0; cursor && depth < 50; depth++) {
    if (cursor === userId) throw AppError.badRequest('This manager assignment would create a reporting cycle.', 'INVALID_MANAGER');
    const next: { managerId: string | null } | null = await prisma.user.findUnique({ where: { id: cursor }, select: { managerId: true } });
    cursor = next?.managerId ?? null;
  }
}

async function roleOrThrow(roleId: string) {
  const role = await prisma.role.findUnique({ where: { id: roleId } });
  if (!role) throw AppError.badRequest('Selected role does not exist.', 'INVALID_ROLE');
  return role;
}

async function assertUnique(employeeId: string | undefined, email: string | undefined, excludeId?: string) {
  if (!employeeId && !email) return;
  const existing = await prisma.user.findFirst({
    where: {
      ...(excludeId ? { id: { not: excludeId } } : {}),
      OR: [
        ...(employeeId ? [{ employeeId: { equals: employeeId, mode: 'insensitive' as const } }] : []),
        ...(email ? [{ email: { equals: email, mode: 'insensitive' as const } }] : []),
      ],
    },
  });
  if (existing) {
    const field = employeeId && existing.employeeId.toLowerCase() === employeeId.toLowerCase() ? 'Employee ID' : 'Email';
    throw AppError.conflict(`${field} is already in use.`, 'DUPLICATE_USER');
  }
}

export const userService = {
  async list(ctx: RequestContext, filter: UserFilter) {
    const ids = await scopeService.teamUserIds(ctx.user);
    const { rows, pagination } = await userRepository.list({ ...filter, ids });
    return { rows: rows.map(toUserDto), pagination };
  },

  async get(ctx: RequestContext, id: string) {
    await scopeService.assertUserAccess(ctx.user, id);
    const user = await userRepository.findById(id);
    if (!user) throw AppError.notFound('User');
    return {
      ...toUserDto(user),
      products: user.managedProducts.map((mp) => mp.product),
    };
  },

  async create(ctx: RequestContext, input: CreateUserInput) {
    const role = await roleOrThrow(input.roleId);
    await assertUnique(input.employeeId, input.email);
    await assertManagerValid(null, input.managerId);

    const tempPassword = input.password ? undefined : generateTempPassword();
    const password = input.password ?? tempPassword!;
    await assertPasswordPolicy(password);

    const { productIds, password: _pw, ...data } = input;
    const user = await prisma.user.create({
      data: {
        ...data,
        passwordHash: await hashPassword(password),
        mustChangePassword: true,
        ...(role.code === ROLE_CODES.PRODUCT_ADMIN && productIds?.length
          ? { managedProducts: { create: productIds.map((productId) => ({ productId })) } }
          : {}),
      },
      include: userInclude,
    });
    await auditService.log(ctx, 'USER_CREATED', 'User', user.id, undefined, toUserDto(user));
    return { user: toUserDto(user), temporaryPassword: tempPassword };
  },

  async update(ctx: RequestContext, id: string, input: UpdateUserInput) {
    const existing = await prisma.user.findFirst({ where: { id, deletedAt: null }, include: userInclude });
    if (!existing) throw AppError.notFound('User');
    const role = input.roleId ? await roleOrThrow(input.roleId) : existing.role;
    await assertUnique(input.employeeId, input.email, id);
    if (input.managerId !== undefined) await assertManagerValid(id, input.managerId);

    const { productIds, ...data } = input;
    const user = await prisma.$transaction(async (tx) => {
      if (productIds !== undefined || role.code !== ROLE_CODES.PRODUCT_ADMIN) {
        await tx.userProduct.deleteMany({ where: { userId: id } });
        if (role.code === ROLE_CODES.PRODUCT_ADMIN && productIds?.length) {
          await tx.userProduct.createMany({ data: productIds.map((productId) => ({ userId: id, productId })) });
        }
      }
      return tx.user.update({ where: { id }, data, include: userInclude });
    });
    await auditService.log(ctx, 'USER_UPDATED', 'User', id, toUserDto(existing), toUserDto(user));
    return toUserDto(user);
  },

  async setStatus(ctx: RequestContext, id: string, status: 'ACTIVE' | 'INACTIVE') {
    if (id === ctx.user.id && status === 'INACTIVE') {
      throw AppError.badRequest('You cannot disable your own account.', 'SELF_DISABLE');
    }
    const existing = await prisma.user.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw AppError.notFound('User');
    const user = await prisma.user.update({ where: { id }, data: { status }, include: userInclude });
    if (status === 'INACTIVE') {
      await prisma.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    }
    await auditService.log(ctx, status === 'INACTIVE' ? 'USER_DISABLED' : 'USER_ENABLED', 'User', id, { status: existing.status }, { status });
    return toUserDto(user);
  },

  async remove(ctx: RequestContext, id: string) {
    if (id === ctx.user.id) throw AppError.badRequest('You cannot delete your own account.', 'SELF_DELETE');
    const existing = await prisma.user.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw AppError.notFound('User');
    // Soft delete keeps attempt history intact; unique fields are freed for reuse.
    const suffix = `.deleted.${Date.now()}`;
    await prisma.$transaction([
      prisma.user.update({
        where: { id },
        data: {
          deletedAt: new Date(),
          status: 'INACTIVE',
          email: `${existing.email}${suffix}`,
          employeeId: `${existing.employeeId}${suffix}`,
        },
      }),
      prisma.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    await auditService.log(ctx, 'USER_DELETED', 'User', id, toUserDto(existing as never), undefined);
  },

  async adminResetPassword(ctx: RequestContext, id: string, newPassword?: string) {
    const existing = await prisma.user.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw AppError.notFound('User');
    const password = newPassword ?? generateTempPassword();
    await assertPasswordPolicy(password);
    await prisma.$transaction([
      prisma.user.update({ where: { id }, data: { passwordHash: await hashPassword(password), mustChangePassword: true } }),
      prisma.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    await auditService.log(ctx, 'USER_PASSWORD_RESET', 'User', id);
    return { temporaryPassword: newPassword ? undefined : password };
  },

  lookups: () => userRepository.lookups(),

  // -------------------------------------------------------------------------
  // Bulk upload: preview (validate) then confirm (create)
  // -------------------------------------------------------------------------

  async bulkPreview(sheetRows: SheetRow[]) {
    const roles = await prisma.role.findMany();
    const roleCodes = new Set(roles.map((r) => r.code));
    const parsed = sheetRows.map((raw, index) => {
      const candidate = {
        employeeId: raw.employeeid,
        firstName: raw.firstname,
        lastName: raw.lastname,
        email: raw.email,
        mobile: raw.mobile,
        department: raw.department,
        designation: raw.designation,
        team: raw.team,
        productGroup: raw.productgroup,
        location: raw.location,
        roleCode: (raw.role || raw.rolecode || 'USER').toUpperCase(),
        managerEmployeeId: raw.manageremployeeid || raw.manager,
        password: raw.password || undefined,
      };
      const result = rowSchema.safeParse(candidate);
      const errors = result.success ? [] : result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
      if (result.success && !roleCodes.has(result.data.roleCode)) errors.push(`Unknown role: ${result.data.roleCode}`);
      return { rowNumber: index + 2, data: result.success ? result.data : (candidate as BulkUserRow), errors };
    });

    // Duplicates inside the file and against the database.
    const seenEmp = new Map<string, number>();
    const seenEmail = new Map<string, number>();
    for (const row of parsed) {
      const emp = row.data.employeeId?.toLowerCase();
      const email = row.data.email?.toLowerCase();
      if (emp) {
        if (seenEmp.has(emp)) row.errors.push(`Duplicate Employee ID in file (row ${seenEmp.get(emp)})`);
        else seenEmp.set(emp, row.rowNumber);
      }
      if (email) {
        if (seenEmail.has(email)) row.errors.push(`Duplicate email in file (row ${seenEmail.get(email)})`);
        else seenEmail.set(email, row.rowNumber);
      }
    }
    const existing = await prisma.user.findMany({
      where: {
        OR: [
          { employeeId: { in: [...seenEmp.keys()], mode: 'insensitive' } },
          { email: { in: [...seenEmail.keys()], mode: 'insensitive' } },
        ],
      },
      select: { employeeId: true, email: true },
    });
    const existingEmp = new Set(existing.map((u) => u.employeeId.toLowerCase()));
    const existingEmail = new Set(existing.map((u) => u.email.toLowerCase()));
    const managerIds = [...new Set(parsed.map((r) => r.data.managerEmployeeId).filter(Boolean) as string[])];
    const managers = await prisma.user.findMany({
      where: { employeeId: { in: managerIds, mode: 'insensitive' }, deletedAt: null },
      select: { employeeId: true },
    });
    const knownManagers = new Set([...managers.map((m) => m.employeeId.toLowerCase()), ...seenEmp.keys()]);

    for (const row of parsed) {
      if (row.data.employeeId && existingEmp.has(row.data.employeeId.toLowerCase())) row.errors.push('Employee ID already exists');
      if (row.data.email && existingEmail.has(row.data.email.toLowerCase())) row.errors.push('Email already exists');
      if (row.data.managerEmployeeId && !knownManagers.has(row.data.managerEmployeeId.toLowerCase())) {
        row.errors.push(`Manager ${row.data.managerEmployeeId} not found`);
      }
    }

    const valid = parsed.filter((r) => !r.errors.length).length;
    return { rows: parsed, summary: { total: parsed.length, valid, invalid: parsed.length - valid } };
  },

  async bulkConfirm(ctx: RequestContext, rows: BulkUserRow[]) {
    const preview = await this.bulkPreview(
      rows.map((r) => ({
        employeeid: r.employeeId,
        firstname: r.firstName,
        lastname: r.lastName,
        email: r.email,
        mobile: r.mobile ?? '',
        department: r.department ?? '',
        designation: r.designation ?? '',
        team: r.team ?? '',
        productgroup: r.productGroup ?? '',
        location: r.location ?? '',
        role: r.roleCode,
        manageremployeeid: r.managerEmployeeId ?? '',
        password: r.password ?? '',
      })),
    );
    const validRows = preview.rows.filter((r) => !r.errors.length);
    const roles = new Map((await prisma.role.findMany()).map((r) => [r.code, r.id]));
    const created: Array<{ employeeId: string; email: string; temporaryPassword?: string }> = [];
    const failed: Array<{ rowNumber: number; errors: string[] }> = preview.rows
      .filter((r) => r.errors.length)
      .map((r) => ({ rowNumber: r.rowNumber, errors: r.errors }));

    // Create users without managers first, then link managers (a manager may be in the same file).
    const idByEmp = new Map<string, string>();
    for (const row of validRows) {
      const d = row.data;
      const tempPassword = d.password ? undefined : generateTempPassword();
      try {
        await assertPasswordPolicy(d.password ?? tempPassword!);
        const user = await prisma.user.create({
          data: {
            employeeId: d.employeeId,
            firstName: d.firstName,
            lastName: d.lastName,
            email: d.email,
            mobile: d.mobile ?? null,
            department: d.department ?? null,
            designation: d.designation ?? null,
            team: d.team ?? null,
            productGroup: d.productGroup ?? null,
            location: d.location ?? null,
            roleId: roles.get(d.roleCode)!,
            passwordHash: await hashPassword(d.password ?? tempPassword!),
            mustChangePassword: true,
          },
        });
        idByEmp.set(d.employeeId.toLowerCase(), user.id);
        created.push({ employeeId: d.employeeId, email: d.email, temporaryPassword: tempPassword });
      } catch (err) {
        failed.push({ rowNumber: row.rowNumber, errors: [err instanceof AppError ? err.message : 'Could not create user'] });
      }
    }
    for (const row of validRows) {
      const mgr = row.data.managerEmployeeId?.toLowerCase();
      const userId = idByEmp.get(row.data.employeeId.toLowerCase());
      if (!mgr || !userId) continue;
      const managerId =
        idByEmp.get(mgr) ??
        (await prisma.user.findFirst({ where: { employeeId: { equals: mgr, mode: 'insensitive' } }, select: { id: true } }))?.id;
      if (managerId) await prisma.user.update({ where: { id: userId }, data: { managerId } });
    }

    await auditService.log(ctx, 'USERS_BULK_UPLOADED', 'User', null, undefined, { created: created.length, failed: failed.length });
    return { created, failed, summary: { created: created.length, failed: failed.length } };
  },

  /** Resolve people for assignment pickers, respecting manager scope. */
  async searchForPicker(ctx: RequestContext, search: string | undefined, limit = 20) {
    const ids = await scopeService.teamUserIds(ctx.user);
    const where: Prisma.UserWhereInput = {
      deletedAt: null,
      status: 'ACTIVE',
      ...(ids ? { id: { in: ids } } : {}),
      ...(search
        ? {
            OR: [
              { employeeId: { contains: search, mode: 'insensitive' } },
              { firstName: { contains: search, mode: 'insensitive' } },
              { lastName: { contains: search, mode: 'insensitive' } },
              { email: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const users = await prisma.user.findMany({ where, take: limit, orderBy: { firstName: 'asc' }, include: userInclude });
    return users.map(toUserDto);
  },
};
