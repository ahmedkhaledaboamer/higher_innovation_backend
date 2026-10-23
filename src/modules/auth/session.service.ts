import { randomUUID } from 'node:crypto';
import type { ClientSession, Types } from 'mongoose';
import { env } from '../../config/env.js';
import { generateOpaqueToken, hashToken, signAccessToken } from '../../utils/tokens.js';
import { User } from '../users/user.model.js';
import { ActionToken, type ActionTokenPurpose } from './actionToken.model.js';
import { RefreshToken } from './refreshToken.model.js';

type Id = Types.ObjectId | string;

export interface ClientInfo {
  ip?: string | undefined;
  userAgent?: string | undefined;
}

export interface IssuedSession {
  accessToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
  /** Raw refresh token: goes into the httpOnly cookie only, never into a response body or log. */
  refreshToken: string;
}

/**
 * Issues an access token plus a refresh token.
 * Pass `family` to continue an existing login (rotation); omit it to start a new one.
 */
export async function issueSession(
  user: { _id: Id; tokenVersion: number },
  client: ClientInfo,
  options: { family?: string; session?: ClientSession } = {},
): Promise<IssuedSession> {
  const refreshToken = generateOpaqueToken();

  await RefreshToken.create(
    [
      {
        user: user._id,
        tokenHash: hashToken(refreshToken),
        family: options.family ?? randomUUID(),
        expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000),
        userAgent: client.userAgent?.slice(0, 300) ?? null,
        ip: client.ip ?? null,
      },
    ],
    { session: options.session },
  );

  return {
    accessToken: signAccessToken(user._id.toString(), user.tokenVersion),
    expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
    refreshToken,
  };
}

/**
 * Signs the user out everywhere: revokes every refresh token and bumps tokenVersion,
 * which invalidates every access token already issued. Returns the new tokenVersion.
 */
export async function revokeAllSessions(
  userId: Id,
  reason: 'LOGOUT_ALL' | 'PASSWORD_CHANGED' | 'ACCOUNT_DISABLED',
  session?: ClientSession,
): Promise<number> {
  await RefreshToken.updateMany(
    { user: userId, revokedAt: null },
    { revokedAt: new Date(), revokedReason: reason },
    { session },
  );
  const updated = await User.findByIdAndUpdate(
    userId,
    { $inc: { tokenVersion: 1 } },
    { new: true, session, projection: { tokenVersion: 1 } },
  ).lean();
  return updated?.tokenVersion ?? 0;
}

/**
 * Creates a single-use email token (password reset or invitation) and returns the raw value.
 * Any older unused token for the same purpose is deleted, so only the latest link works.
 */
export async function issueActionToken(
  userId: Id,
  purpose: ActionTokenPurpose,
  session?: ClientSession,
): Promise<string> {
  const ttlMs =
    purpose === 'INVITE' ? env.INVITE_TTL_HOURS * 60 * 60 * 1000 : env.PASSWORD_RESET_TTL_MINUTES * 60 * 1000;
  const raw = generateOpaqueToken();

  await ActionToken.deleteMany({ user: userId, purpose, usedAt: null }, { session });
  await ActionToken.create(
    [{ user: userId, purpose, tokenHash: hashToken(raw), expiresAt: new Date(Date.now() + ttlMs) }],
    { session },
  );
  return raw;
}

/** Link to the frontend page that accepts both reset and invitation tokens. */
export function buildPasswordLink(rawToken: string): string {
  const url = new URL('/reset-password', env.FRONTEND_URL);
  url.searchParams.set('token', rawToken);
  return url.toString();
}
