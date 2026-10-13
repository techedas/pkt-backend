/**
 * Application error carrying a stable, machine-readable code.
 * Everything thrown from services should be an AppError so the error
 * middleware can map it to the standard error response.
 */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }

  static badRequest(message: string, code = 'BAD_REQUEST', details?: unknown) {
    return new AppError(code, message, 400, details);
  }

  static unauthorized(message = 'Authentication required.', code = 'UNAUTHORIZED') {
    return new AppError(code, message, 401);
  }

  static forbidden(message = 'You do not have permission to perform this action.', code = 'FORBIDDEN') {
    return new AppError(code, message, 403);
  }

  static notFound(entity = 'Resource', code = 'NOT_FOUND') {
    return new AppError(code, `${entity} not found.`, 404);
  }

  static conflict(message: string, code = 'CONFLICT', details?: unknown) {
    return new AppError(code, message, 409, details);
  }
}
