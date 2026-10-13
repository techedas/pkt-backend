import type { Response } from 'express';
import type { Pagination } from './pagination';

export function ok<T>(res: Response, data: T, message?: string, status = 200) {
  return res.status(status).json({ success: true, data, ...(message ? { message } : {}) });
}

export function created<T>(res: Response, data: T, message?: string) {
  return ok(res, data, message, 201);
}

export function paginated<T>(res: Response, data: T[], pagination: Pagination, message?: string) {
  return res.json({ success: true, data, pagination, ...(message ? { message } : {}) });
}
