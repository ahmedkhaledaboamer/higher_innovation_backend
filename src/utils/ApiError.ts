/** One field-level problem, e.g. `{ path: 'email', message: 'Invalid email' }`. */
export interface ErrorDetail {
  path: string;
  message: string;
}

/**
 * An error that is safe to show to API clients.
 *
 * Throw it from services or middleware; the global error handler turns it into
 * a JSON response with this status code, message and machine-readable `code`.
 * Any error that is NOT an ApiError is treated as an unexpected bug and
 * reported to clients as a generic 500.
 */
export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: ErrorDetail[] | undefined;

  constructor(statusCode: number, message: string, code: string, details?: ErrorDetail[]) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }

  static badRequest(message = 'Bad request', code = 'BAD_REQUEST', details?: ErrorDetail[]) {
    return new ApiError(400, message, code, details);
  }

  static unauthorized(message = 'Authentication required', code = 'UNAUTHORIZED') {
    return new ApiError(401, message, code);
  }

  static forbidden(message = 'You do not have permission to perform this action', code = 'FORBIDDEN') {
    return new ApiError(403, message, code);
  }

  static notFound(message = 'Resource not found', code = 'NOT_FOUND') {
    return new ApiError(404, message, code);
  }

  static conflict(message = 'Resource already exists', code = 'CONFLICT') {
    return new ApiError(409, message, code);
  }

  static tooManyRequests(message = 'Too many requests, please try again later', code = 'RATE_LIMITED') {
    return new ApiError(429, message, code);
  }

  static serviceUnavailable(message = 'Service temporarily unavailable', code = 'SERVICE_UNAVAILABLE') {
    return new ApiError(503, message, code);
  }
}
