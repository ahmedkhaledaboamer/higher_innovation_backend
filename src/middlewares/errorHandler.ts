import type { ErrorRequestHandler } from 'express';
import mongoose from 'mongoose';
import { ZodError } from 'zod';
import { isProduction } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';
import { logger } from '../utils/logger.js';
import type { ErrorBody } from '../utils/response.js';

/**
 * The single place where errors become HTTP responses.
 *
 * Express 5 forwards both thrown errors and rejected promises from async
 * handlers here, so controllers and services just `throw` and never build
 * error responses themselves.
 */
export const errorHandler: ErrorRequestHandler = (error, req, res, next) => {
  // The response already started streaming; let Express close the connection.
  if (res.headersSent) {
    next(error);
    return;
  }

  const apiError = toApiError(error);

  if (apiError.statusCode >= 500) {
    // Full detail goes to the log only (with the request id), never to the client.
    (req.log ?? logger).error({ err: error }, 'Unhandled error');
  }

  const body: ErrorBody = {
    success: false,
    message: apiError.message,
    code: apiError.code,
    ...(apiError.details ? { errors: apiError.details } : {}),
    ...(req.id ? { requestId: String(req.id) } : {}),
  };

  res.status(apiError.statusCode).json(body);
};

/** Maps any thrown value to an ApiError with a client-safe message. */
function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;

  if (error instanceof ZodError) {
    return ApiError.badRequest(
      'Validation failed',
      'VALIDATION_ERROR',
      error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }

  // Errors raised by express.json() for malformed or oversized bodies.
  if (isBodyParserError(error)) {
    if (error.type === 'entity.parse.failed') {
      return ApiError.badRequest('Request body is not valid JSON', 'INVALID_JSON');
    }
    if (error.type === 'entity.too.large') {
      return new ApiError(413, 'Request body is too large', 'PAYLOAD_TOO_LARGE');
    }
    return ApiError.badRequest('Malformed request body', 'BAD_REQUEST');
  }

  const databaseError = fromDatabaseError(error);
  if (databaseError) return databaseError;

  return new ApiError(
    500,
    isProduction ? 'Internal server error' : describe(error),
    'INTERNAL_ERROR',
  );
}

/**
 * Translates Mongoose/MongoDB errors that are caused by the request (not by a bug)
 * into proper 4xx/503 responses. Services should still check business rules
 * explicitly; this is the safety net for cases such as two requests creating
 * the same email at the same moment (the unique index rejects the second).
 */
function fromDatabaseError(error: unknown): ApiError | null {
  // Unique index violation, e.g. a second user with the same email.
  if (error instanceof mongoose.mongo.MongoServerError && error.code === 11000) {
    // Report the field names only; echoing the values could leak other users' data.
    const fields = Object.keys((error.keyValue as Record<string, unknown> | undefined) ?? {}).join(', ');
    return ApiError.conflict(
      fields ? `A record with this ${fields} already exists` : 'A record with these values already exists',
      'UNIQUE_CONSTRAINT',
    );
  }

  // Schema rules (required, enum, min/max...) rejected the document.
  if (error instanceof mongoose.Error.ValidationError) {
    return ApiError.badRequest(
      'Validation failed',
      'VALIDATION_ERROR',
      Object.values(error.errors).map((issue) => ({ path: issue.path, message: issue.message })),
    );
  }

  // A value could not be converted to the schema type, typically a malformed ObjectId in the URL.
  if (error instanceof mongoose.Error.CastError) {
    return ApiError.badRequest(`Invalid value for "${error.path}"`, 'INVALID_ID');
  }

  if (error instanceof mongoose.Error.DocumentNotFoundError) {
    return ApiError.notFound('Record not found', 'NOT_FOUND');
  }

  // The database is unreachable or the connection dropped.
  if (
    error instanceof mongoose.Error.MongooseServerSelectionError ||
    error instanceof mongoose.mongo.MongoNetworkError ||
    (error instanceof mongoose.mongo.MongoError && /not connected|client must be connected/i.test(error.message)) ||
    (error instanceof mongoose.Error && /buffering timed out|before initial connection/i.test(error.message))
  ) {
    return ApiError.serviceUnavailable('Database is unavailable', 'DATABASE_UNAVAILABLE');
  }

  return null;
}

function isBodyParserError(error: unknown): error is { type: string; status?: number } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'type' in error &&
    typeof (error as { type: unknown }).type === 'string' &&
    (error as { type: string }).type.startsWith('entity.')
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'Internal server error';
}
