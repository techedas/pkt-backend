import { Router } from 'express';
import { authController } from '../controllers/auth.controller';
import { authenticate } from '../middlewares/auth';
import { authLimiter } from '../middlewares/rateLimit';
import { validate } from '../middlewares/validate';
import { asyncHandler } from '../utils/asyncHandler';
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  refreshSchema,
  resetPasswordSchema,
} from '../validators/auth.validator';

const r = Router();

r.post('/login', authLimiter, validate({ body: loginSchema }), asyncHandler(authController.login));
r.post('/refresh', validate({ body: refreshSchema }), asyncHandler(authController.refresh));
r.post('/logout', asyncHandler(authController.logout));
r.post('/forgot-password', authLimiter, validate({ body: forgotPasswordSchema }), asyncHandler(authController.forgotPassword));
r.post('/reset-password', authLimiter, validate({ body: resetPasswordSchema }), asyncHandler(authController.resetPassword));
r.get('/me', authenticate, asyncHandler(authController.me));
r.post('/change-password', authenticate, validate({ body: changePasswordSchema }), asyncHandler(authController.changePassword));

export default r;
