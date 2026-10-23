import type { Request } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import { env } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';

/**
 * Counters live in process memory. That is fine for a single server; if the API
 * is ever run as several instances, switch to a shared store so limits add up.
 */

/** Baseline limit for the whole API, per client IP. */
export const apiRateLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.RATE_LIMIT_MAX,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  // Health probes from load balancers must never be throttled into looking "down".
  skip: (req) => req.originalUrl.startsWith('/api/v1/health'),
  handler(_req, _res, next) {
    next(ApiError.tooManyRequests());
  },
});

/** Client IP (IPv6 addresses grouped by /56 so one client cannot rotate addresses) plus the target email. */
function ipAndEmailKey(req: Request): string {
  const ip = ipKeyGenerator(req.ip ?? 'unknown');
  const email: unknown = req.body?.email;
  return typeof email === 'string' ? `${ip}|${email.trim().toLowerCase()}` : ip;
}

function authLimiter(options: { prefix: string; skipSuccessfulRequests?: boolean; byEmail?: boolean }) {
  return rateLimit({
    windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS,
    limit: env.AUTH_RATE_LIMIT_MAX,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skipSuccessfulRequests: options.skipSuccessfulRequests ?? false,
    keyGenerator: (req) => `${options.prefix}:${options.byEmail ? ipAndEmailKey(req) : ipKeyGenerator(req.ip ?? 'unknown')}`,
    handler(_req, _res, next) {
      next(ApiError.tooManyRequests('Too many attempts. Please wait a few minutes and try again.'));
    },
  });
}

/**
 * Login: only failed attempts count, per IP + email, so guessing one account's
 * password is throttled while a user who signs in successfully is never blocked.
 */
export const loginRateLimiter = authLimiter({ prefix: 'login', skipSuccessfulRequests: true, byEmail: true });

/** Forgot password: limits reset emails sent to one address from one client. */
export const forgotPasswordRateLimiter = authLimiter({ prefix: 'forgot', byEmail: true });

/** Reset and change password: limits token and current-password guessing per IP. */
export const passwordRateLimiter = authLimiter({ prefix: 'password', skipSuccessfulRequests: true });
