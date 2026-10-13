import rateLimit from 'express-rate-limit';
import { env } from '../config/env';

const handler = (_req: unknown, res: import('express').Response) =>
  res.status(429).json({
    success: false,
    error: { code: 'RATE_LIMITED', message: 'Too many requests. Please slow down and try again shortly.' },
  });

/** General API limiter (per IP). */
export const apiLimiter = rateLimit({
  windowMs: 60_000,
  limit: env.isTest ? 10_000 : 600,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler,
});

/** Strict limiter for credential endpoints to slow down brute force attempts. */
export const authLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: env.isTest ? 10_000 : 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler,
});
