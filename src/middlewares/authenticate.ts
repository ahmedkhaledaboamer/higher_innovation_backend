import type { Request, RequestHandler } from 'express';
import { isValidObjectId } from 'mongoose';
import type { RoleKey } from '../modules/roles/permissions.js';
import { permissionsFor } from '../modules/roles/permissions.js';
import { User } from '../modules/users/user.model.js';
import type { AuthContext } from '../types/express.js';
import { ApiError } from '../utils/ApiError.js';
import { verifyAccessToken } from '../utils/tokens.js';

/**
 * Requires a valid access token (`Authorization: Bearer <token>`) and an active account.
 *
 * The token only proves who the caller is. Role, permissions and status are read
 * from the database on every request, never from the token or anything the
 * client sends, so a suspension or role change applies to the very next request.
 */
export const authenticate: RequestHandler = async (req, _res, next) => {
  const token = readBearerToken(req);
  if (!token) throw ApiError.unauthorized('Authentication required', 'UNAUTHORIZED');

  const claims = verifyAccessToken(token);
  if (!isValidObjectId(claims.sub)) throw ApiError.unauthorized('Invalid access token', 'INVALID_TOKEN');

  const user = await User.findById(claims.sub)
    .select('email status tokenVersion role')
    .populate<{ role: { key: RoleKey } | null }>('role', 'key')
    .lean();

  if (!user || !user.role) throw ApiError.unauthorized('Invalid access token', 'INVALID_TOKEN');
  if (user.tokenVersion !== claims.ver) {
    throw ApiError.unauthorized('Session has ended, please sign in again', 'TOKEN_REVOKED');
  }
  if (user.status !== 'ACTIVE') throw ApiError.unauthorized('Account is not active', 'ACCOUNT_DISABLED');

  const auth: AuthContext = {
    userId: user._id.toString(),
    email: user.email,
    role: user.role.key,
    permissions: permissionsFor(user.role.key),
  };
  req.auth = auth;
  next();
};

function readBearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const [scheme, value] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && value ? value.trim() : null;
}

/** For handlers behind `authenticate`: returns the auth context or fails loudly if the route was wired wrong. */
export function requireAuth(req: Request): AuthContext {
  if (!req.auth) throw new Error('requireAuth() used on a route without the authenticate middleware');
  return req.auth;
}
