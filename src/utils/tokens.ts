import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { ApiError } from './ApiError.js';

/* --------------------------------- access JWT -------------------------------- */

export interface AccessTokenClaims {
  /** User id. */
  sub: string;
  /** The user's tokenVersion when the token was issued. */
  ver: number;
  /** Issued-at, seconds since epoch. */
  iat: number;
  exp: number;
}

/**
 * Access tokens carry only the user id. Role, permissions and account status are
 * loaded from the database on every request, so changes apply immediately instead
 * of when the token expires.
 */
export function signAccessToken(userId: string, tokenVersion: number): string {
  return jwt.sign({ ver: tokenVersion }, env.JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    subject: userId,
    expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
  });
}

export function verifyAccessToken(token: string): AccessTokenClaims {
  try {
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET, {
      // Pin the algorithm: never let the token header choose it (prevents "alg: none" tricks).
      algorithms: ['HS256'],
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
    });
    if (typeof payload === 'string' || typeof payload.sub !== 'string' || typeof payload.ver !== 'number') {
      throw ApiError.unauthorized('Invalid access token', 'INVALID_TOKEN');
    }
    return payload as AccessTokenClaims;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof jwt.TokenExpiredError) {
      throw ApiError.unauthorized('Access token has expired', 'TOKEN_EXPIRED');
    }
    throw ApiError.unauthorized('Invalid access token', 'INVALID_TOKEN');
  }
}

/* ------------------------------- opaque tokens ------------------------------- */

/** A random, URL-safe secret (256 bits) for refresh, reset and invite tokens. */
export function generateOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Tokens are stored as SHA-256 hashes. A fast hash is right here (unlike passwords):
 * the input is 256 random bits, so there is nothing to brute-force.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
