import { env } from '../../config/env.js';
import { runInTransaction } from '../../database/mongoose.js';
import { sendMail } from '../../mail/mailer.js';
import { passwordResetEmail } from '../../mail/templates.js';
import { ApiError } from '../../utils/ApiError.js';
import { logger } from '../../utils/logger.js';
import { burnPasswordCheck, hashPassword, verifyPassword } from '../../utils/password.js';
import { hashToken } from '../../utils/tokens.js';
import { permissionsFor } from '../roles/permissions.js';
import { type CurrentUserDto, ROLE_FIELDS, toUserDto, type UserDto, type UserWithRole } from '../users/user.dto.js';
import { User } from '../users/user.model.js';
import { ActionToken } from './actionToken.model.js';
import type { ChangePasswordInput, LoginInput, ResetPasswordInput, UpdateOwnProfileInput } from './auth.schema.js';
import { RefreshToken } from './refreshToken.model.js';
import {
  buildPasswordLink,
  type ClientInfo,
  issueActionToken,
  issueSession,
  type IssuedSession,
  revokeAllSessions,
} from './session.service.js';

export interface AuthResult extends IssuedSession {
  user: UserDto;
}

const invalidCredentials = () => ApiError.unauthorized('Invalid email or password', 'INVALID_CREDENTIALS');
const invalidRefreshToken = () => ApiError.unauthorized('Session is invalid or has expired', 'INVALID_REFRESH_TOKEN');
const invalidActionToken = () =>
  ApiError.badRequest('This link is invalid or has expired. Request a new one.', 'INVALID_RESET_TOKEN');

/** Thrown inside the rotation transaction when another request already used the token. */
class TokenAlreadyRotated extends Error {}

async function loadUserWithRole(id: unknown): Promise<(UserWithRole & { tokenVersion: number }) | null> {
  const user = await User.findById(id).populate<{ role: UserWithRole['role'] }>('role', ROLE_FIELDS).lean();
  return user as unknown as (UserWithRole & { tokenVersion: number }) | null;
}

export const authService = {
  async login({ email, password }: LoginInput, client: ClientInfo): Promise<AuthResult> {
    const user = await User.findOne({ email })
      .select('+passwordHash')
      .populate<{ role: UserWithRole['role'] }>('role', ROLE_FIELDS)
      .lean();

    // Same error and roughly the same time whether the email is unknown, the account
    // has no password yet (INVITED), or the password is wrong: no account enumeration.
    if (!user || !user.passwordHash) {
      await burnPasswordCheck(password);
      throw invalidCredentials();
    }
    if (!(await verifyPassword(password, user.passwordHash))) throw invalidCredentials();

    // Only revealed to someone who knows the correct password.
    if (user.status !== 'ACTIVE') {
      throw ApiError.forbidden('This account is not active. Contact an administrator.', 'ACCOUNT_DISABLED');
    }

    await User.updateOne({ _id: user._id }, { lastLoginAt: new Date() });
    const session = await issueSession(user, client);
    const fresh = await loadUserWithRole(user._id);
    return { ...session, user: toUserDto(fresh!) };
  },

  /**
   * Exchanges a refresh token for a new access + refresh token pair (rotation).
   * Presenting an already-rotated token is treated as theft: the whole login (family) is revoked.
   */
  async refresh(rawToken: string | undefined, client: ClientInfo): Promise<AuthResult> {
    if (!rawToken) throw ApiError.unauthorized('No session', 'REFRESH_TOKEN_MISSING');

    const stored = await RefreshToken.findOne({ tokenHash: hashToken(rawToken) }).lean();
    if (!stored) throw invalidRefreshToken();

    const revokeFamily = async () => {
      await RefreshToken.updateMany(
        { family: stored.family, revokedAt: null },
        { revokedAt: new Date(), revokedReason: 'REUSE_DETECTED' },
      );
      logger.warn({ userId: stored.user.toString(), family: stored.family }, 'Refresh token reuse detected; session revoked');
    };

    if (stored.revokedAt) {
      if (stored.revokedReason === 'ROTATED') await revokeFamily();
      throw invalidRefreshToken();
    }
    if (stored.expiresAt.getTime() <= Date.now()) throw invalidRefreshToken();

    const user = await loadUserWithRole(stored.user);
    if (!user || user.status !== 'ACTIVE') {
      await RefreshToken.updateMany(
        { family: stored.family, revokedAt: null },
        { revokedAt: new Date(), revokedReason: 'ACCOUNT_DISABLED' },
      );
      throw ApiError.unauthorized('Account is not active', 'ACCOUNT_DISABLED');
    }

    try {
      const session = await runInTransaction(async (txn) => {
        // Atomic claim: only one request can flip revokedAt from null. A concurrent
        // second request with the same token gets nothing back and is treated as reuse.
        const claimed = await RefreshToken.findOneAndUpdate(
          { _id: stored._id, revokedAt: null },
          { revokedAt: new Date(), revokedReason: 'ROTATED' },
          { session: txn },
        );
        if (!claimed) throw new TokenAlreadyRotated();
        return issueSession(user, client, { family: stored.family, session: txn });
      });
      return { ...session, user: toUserDto(user) };
    } catch (error) {
      if (error instanceof TokenAlreadyRotated) {
        await revokeFamily();
        throw invalidRefreshToken();
      }
      throw error;
    }
  },

  /** Ends the current login. Idempotent: an unknown or missing token is not an error. */
  async logout(rawToken: string | undefined): Promise<void> {
    if (!rawToken) return;
    await RefreshToken.updateOne(
      { tokenHash: hashToken(rawToken), revokedAt: null },
      { revokedAt: new Date(), revokedReason: 'LOGOUT' },
    );
  },

  /** Ends every login of this user on every device, including already-issued access tokens. */
  async logoutAll(userId: string): Promise<void> {
    await runInTransaction((txn) => revokeAllSessions(userId, 'LOGOUT_ALL', txn));
  },

  /** Updates the caller's own personal fields; returns the same shape as GET /auth/me. */
  async updateOwnProfile(userId: string, input: UpdateOwnProfileInput): Promise<CurrentUserDto> {
    const set: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      if (value !== undefined) set[key] = value;
    }
    await User.updateOne({ _id: userId }, { $set: set }, { runValidators: true });
    return this.me(userId);
  },

  async me(userId: string): Promise<CurrentUserDto> {
    const user = await loadUserWithRole(userId);
    if (!user) throw ApiError.unauthorized('Invalid access token', 'INVALID_TOKEN');
    return { ...toUserDto(user), permissions: permissionsFor(user.role.key) };
  },

  /**
   * Changes the password, signs out every other session, and returns a fresh session
   * for the device that made the change so the user stays signed in there.
   */
  async changePassword(userId: string, input: ChangePasswordInput, client: ClientInfo): Promise<AuthResult> {
    const user = await User.findById(userId).select('+passwordHash').lean();
    if (!user?.passwordHash) throw ApiError.unauthorized();

    if (!(await verifyPassword(input.currentPassword, user.passwordHash))) {
      throw ApiError.badRequest('Current password is incorrect', 'INVALID_CURRENT_PASSWORD', [
        { path: 'currentPassword', message: 'Current password is incorrect' },
      ]);
    }

    const passwordHash = await hashPassword(input.newPassword);
    const session = await runInTransaction(async (txn) => {
      await User.updateOne({ _id: userId }, { passwordHash, passwordChangedAt: new Date() }, { session: txn });
      const tokenVersion = await revokeAllSessions(userId, 'PASSWORD_CHANGED', txn);
      return issueSession({ _id: userId, tokenVersion }, client, { session: txn });
    });

    const fresh = await loadUserWithRole(userId);
    return { ...session, user: toUserDto(fresh!) };
  },

  /**
   * Starts a password reset. Always behaves the same from the outside, whether or not
   * the email has an account, so the endpoint cannot be used to discover accounts.
   */
  async forgotPassword(email: string): Promise<void> {
    const user = await User.findOne({ email }).select('firstName email status').lean();
    if (!user || user.status !== 'ACTIVE') return;

    const rawToken = await issueActionToken(user._id, 'PASSWORD_RESET');

    // Not awaited: waiting for SMTP would make "account exists" responses measurably slower.
    void sendMail(
      passwordResetEmail({
        to: user.email,
        firstName: user.firstName,
        link: buildPasswordLink(rawToken),
        minutes: env.PASSWORD_RESET_TTL_MINUTES,
      }),
    ).catch((error: unknown) => {
      logger.error({ err: error, userId: user._id.toString() }, 'Failed to send password reset email');
    });
  },

  /**
   * Sets a new password using a reset or invitation token. The token is consumed,
   * every existing session is revoked, and an invited account becomes ACTIVE.
   */
  async resetPassword({ token, password }: ResetPasswordInput): Promise<{ purpose: 'PASSWORD_RESET' | 'INVITE' }> {
    // Hash first: bcrypt is slow and should not hold a transaction open.
    const passwordHash = await hashPassword(password);
    const tokenHash = hashToken(token);

    return runInTransaction(async (txn) => {
      // Atomic: marks the token used only if it is unused and unexpired, so it works exactly once.
      const consumed = await ActionToken.findOneAndUpdate(
        { tokenHash, usedAt: null, expiresAt: { $gt: new Date() } },
        { usedAt: new Date() },
        { session: txn },
      ).lean();
      if (!consumed) throw invalidActionToken();

      const user = await User.findById(consumed.user).session(txn).lean();
      const expectedStatus = consumed.purpose === 'INVITE' ? 'INVITED' : 'ACTIVE';
      if (!user || user.status !== expectedStatus) throw invalidActionToken();

      await User.updateOne(
        { _id: user._id },
        { passwordHash, passwordChangedAt: new Date(), ...(consumed.purpose === 'INVITE' ? { status: 'ACTIVE' } : {}) },
        { session: txn },
      );
      await revokeAllSessions(user._id, 'PASSWORD_CHANGED', txn);
      // Any other outstanding link of the same kind stops working too.
      await ActionToken.deleteMany({ user: user._id, purpose: consumed.purpose, usedAt: null }, { session: txn });

      return { purpose: consumed.purpose };
    });
  },
};
