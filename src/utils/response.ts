import type { Response } from 'express';
import type { ErrorDetail } from './ApiError.js';

/**
 * The two response envelopes every endpoint uses, so the frontend can rely on
 * one shape:
 *
 *   success: { success: true,  message, data, meta?, warnings? }
 *   error:   { success: false, message, code, errors? }
 */
export interface SuccessBody<T> {
  success: true;
  message: string;
  data: T;
  meta?: Record<string, unknown>;
  /**
   * Non-blocking notices about the request that succeeded (e.g. a lead whose contact matches a
   * student, D56). Present only when there is at least one.
   */
  warnings?: Array<{ code: string; message: string }>;
}

export interface ErrorBody {
  success: false;
  message: string;
  code: string;
  errors?: ErrorDetail[];
  requestId?: string;
}

interface SuccessOptions {
  statusCode?: number;
  message?: string;
  meta?: Record<string, unknown>;
  warnings?: Array<{ code: string; message: string }>;
}

export function sendSuccess<T>(res: Response, data: T, options: SuccessOptions = {}): void {
  const { statusCode = 200, message = 'OK', meta, warnings } = options;
  const body: SuccessBody<T> = {
    success: true,
    message,
    data,
    ...(meta ? { meta } : {}),
    ...(warnings && warnings.length > 0 ? { warnings } : {}),
  };
  res.status(statusCode).json(body);
}

export function sendCreated<T>(
  res: Response,
  data: T,
  message = 'Created successfully',
  warnings?: Array<{ code: string; message: string }>,
): void {
  sendSuccess(res, data, { statusCode: 201, message, warnings });
}
