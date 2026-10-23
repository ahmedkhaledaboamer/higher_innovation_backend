import { type InferSchemaType, model, Schema } from 'mongoose';

/**
 * One refresh token per row. Only the SHA-256 hash is stored, so a database leak
 * does not hand out working sessions.
 *
 * Rotation: every refresh marks the presented token as revoked and issues a new one
 * in the same `family` (one family = one login on one device). If a revoked token is
 * ever presented again, someone is replaying a stolen token, so the whole family
 * is revoked and both the thief and the real user must sign in again.
 */
const refreshTokenSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    family: { type: String, required: true, index: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    revokedReason: {
      type: String,
      enum: ['ROTATED', 'LOGOUT', 'LOGOUT_ALL', 'REUSE_DETECTED', 'PASSWORD_CHANGED', 'ACCOUNT_DISABLED', null],
      default: null,
    },
    userAgent: { type: String, maxlength: 300, default: null },
    ip: { type: String, maxlength: 64, default: null },
  },
  { timestamps: true },
);

// MongoDB deletes each token automatically once it expires. Revoked tokens are kept
// until then on purpose: they are what makes reuse detection possible.
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type RefreshTokenFields = InferSchemaType<typeof refreshTokenSchema>;

export const RefreshToken = model('RefreshToken', refreshTokenSchema);
