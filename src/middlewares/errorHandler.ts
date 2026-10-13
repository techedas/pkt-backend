import type { NextFunction, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import { MulterError } from 'multer';
import { AppError } from '../utils/errors';
import { logger } from '../utils/logger';

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({
    success: false,
    error: { code: 'ROUTE_NOT_FOUND', message: `Route ${req.method} ${req.path} not found.` },
  });
}

/**
 * Converts every error into the standard error envelope.
 * Internal details (stack traces, SQL, Prisma messages) are never sent to clients.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  let status = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'Something went wrong. Please try again later.';
  let details: unknown;

  if (err instanceof AppError) {
    status = err.statusCode;
    code = err.code;
    message = err.message;
    details = err.details;
  } else if (err instanceof ZodError) {
    status = 400;
    code = 'VALIDATION_ERROR';
    message = err.issues[0] ? `${err.issues[0].path.join('.') || 'input'}: ${err.issues[0].message}` : 'Invalid input.';
    details = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
  } else if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      status = 409;
      code = 'DUPLICATE_RECORD';
      const target = (err.meta?.target as string[] | undefined)?.join(', ');
      message = target ? `A record with the same ${target} already exists.` : 'Duplicate record.';
    } else if (err.code === 'P2025') {
      status = 404;
      code = 'NOT_FOUND';
      message = 'Record not found.';
    } else if (err.code === 'P2003') {
      status = 409;
      code = 'REFERENCE_CONSTRAINT';
      message = 'The record is referenced by other data and cannot be changed this way.';
    }
  } else if (err instanceof MulterError) {
    status = 400;
    code = 'UPLOAD_ERROR';
    message = err.code === 'LIMIT_FILE_SIZE' ? 'File is too large.' : err.message;
  } else if (err instanceof SyntaxError && 'body' in (err as object)) {
    status = 400;
    code = 'INVALID_JSON';
    message = 'Request body is not valid JSON.';
  }

  if (status >= 500) {
    logger.error('Unhandled error', { method: req.method, path: req.path, err });
  }

  res.status(status).json({ success: false, error: { code, message, ...(details ? { details } : {}) } });
}
