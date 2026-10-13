import { z } from 'zod';
import { pageQuerySchema } from '../utils/pagination';
import { optionalTrimmed, trimmed, uuid } from './common';

const userBase = {
  employeeId: trimmed(50),
  firstName: trimmed(100),
  lastName: trimmed(100),
  email: z.string().trim().toLowerCase().email().max(255),
  mobile: z
    .string()
    .trim()
    .regex(/^\d{5,20}$/, 'Mobile must contain only numbers (5-20 digits)')
    .nullable()
    .optional()
    .or(z.literal('')),
  department: optionalTrimmed(100),
  designation: optionalTrimmed(100),
  team: optionalTrimmed(100),
  productGroup: optionalTrimmed(100),
  location: optionalTrimmed(100),
  managerId: uuid.nullable().optional(),
  roleId: uuid,
  productIds: z.array(uuid).max(100).optional(),
};

export const createUserSchema = z.object({
  ...userBase,
  // Optional: when omitted a temporary password is generated and returned once.
  password: z.string().min(1).max(128).optional(),
});

export const updateUserSchema = z.object(userBase).partial();

export const userStatusSchema = z.object({ status: z.enum(['ACTIVE', 'INACTIVE']) });

export const adminResetPasswordSchema = z.object({ newPassword: z.string().min(1).max(128).optional() }).default({});

export const listUsersSchema = pageQuerySchema.extend({
  roleId: uuid.optional(),
  roleCode: z.string().max(50).optional(),
  department: z.string().max(100).optional(),
  team: z.string().max(100).optional(),
  location: z.string().max(100).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  managerId: uuid.optional(),
});

export const bulkUserRowSchema = z.object({
  employeeId: trimmed(50),
  firstName: trimmed(100),
  lastName: trimmed(100),
  email: z.string().trim().toLowerCase().email().max(255),
  mobile: optionalTrimmed(20),
  department: optionalTrimmed(100),
  designation: optionalTrimmed(100),
  team: optionalTrimmed(100),
  productGroup: optionalTrimmed(100),
  location: optionalTrimmed(100),
  roleCode: trimmed(50),
  managerEmployeeId: optionalTrimmed(50),
  password: z.string().max(128).optional().nullable(),
});

export const bulkUserConfirmSchema = z.object({
  rows: z.array(bulkUserRowSchema).min(1).max(5000),
});
