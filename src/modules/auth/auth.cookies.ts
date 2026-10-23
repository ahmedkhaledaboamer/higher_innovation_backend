import type { CookieOptions, Request, Response } from 'express';
import { env } from '../../config/env.js';

export const REFRESH_COOKIE_NAME = 'crm_refresh';

/**
 * The refresh token lives only in this cookie:
 * - httpOnly: page JavaScript (and therefore XSS) cannot read it;
 * - secure:   sent over HTTPS only (required in production);
 * - sameSite: not sent on cross-site requests, which blocks CSRF;
 * - path:     sent only to /api/v1/auth, never to the rest of the API.
 */
function baseOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    sameSite: env.COOKIE_SAMESITE,
    path: '/api/v1/auth',
    ...(env.COOKIE_DOMAIN ? { domain: env.COOKIE_DOMAIN } : {}),
  };
}

export function setRefreshCookie(res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE_NAME, token, {
    ...baseOptions(),
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
  });
}

export function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE_NAME, baseOptions());
}

export function readRefreshCookie(req: Request): string | undefined {
  const value: unknown = req.cookies?.[REFRESH_COOKIE_NAME];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
