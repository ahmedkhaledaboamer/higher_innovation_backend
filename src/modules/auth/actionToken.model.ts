import { type InferSchemaType, model, Schema } from 'mongoose';

/**
 * Short-lived, single-use tokens sent by email:
 *   PASSWORD_RESET – "forgot password" link (minutes).
 *   INVITE         – "set your password" link for a newly created staff account (hours).
 *
 * The raw token exists only in the email; the database stores its SHA-256 hash.
 */
export const ACTION_TOKEN_PURPOSES = ['PASSWORD_RESET', 'INVITE'] as const;
export type ActionTokenPurpose = (typeof ACTION_TOKEN_PURPOSES)[number];

const actionTokenSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    purpose: { type: String, enum: ACTION_TOKEN_PURPOSES, required: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

actionTokenSchema.index({ user: 1, purpose: 1 });
// Removed automatically by MongoDB after expiry.
actionTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type ActionTokenFields = InferSchemaType<typeof actionTokenSchema>;

export const ActionToken = model('ActionToken', actionTokenSchema);
