import { z } from 'zod';

export const loginSchema = z.object({
  identifier: z.string().trim().min(1, 'Employee ID or Email is required').max(255),
  password: z.string().min(1, 'Password is required').max(128),
});

export const refreshSchema = z.object({ refreshToken: z.string().optional() }).default({});

export const forgotPasswordSchema = z.object({
  identifier: z.string().trim().min(1).max(255),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(10).max(200),
  newPassword: z.string().min(1).max(128),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(1).max(128),
});
