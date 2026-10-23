import { type HydratedDocument, type InferSchemaType, model, Schema } from 'mongoose';

/**
 * ACTIVE    – can sign in.
 * INVITED   – account created by an admin; becomes ACTIVE when the user sets a password via the invite link.
 * SUSPENDED – temporarily blocked by an admin.
 * INACTIVE  – no longer with the academy.
 * Matches the frontend's UserStatus ('Active' | 'Invited' | 'Suspended' | 'Inactive').
 */
export const USER_STATUSES = ['ACTIVE', 'INVITED', 'SUSPENDED', 'INACTIVE'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

const userSchema = new Schema(
  {
    firstName: { type: String, required: true, trim: true, maxlength: 60 },
    lastName: { type: String, required: true, trim: true, maxlength: 60 },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 254 },
    phone: { type: String, trim: true, maxlength: 30, default: null },

    // Never returned by queries unless explicitly requested with .select('+passwordHash').
    // Null while the account is INVITED and no password has been set yet.
    passwordHash: { type: String, select: false, default: null },

    role: { type: Schema.Types.ObjectId, ref: 'Role', required: true, index: true },
    status: { type: String, enum: USER_STATUSES, required: true, default: 'INVITED', index: true },

    avatarUrl: { type: String, trim: true, default: null },
    // Free text until the Department module exists (HR phase).
    department: { type: String, trim: true, maxlength: 80, default: null },
    location: { type: String, trim: true, maxlength: 80, default: null },

    lastLoginAt: { type: Date, default: null },
    passwordChangedAt: { type: Date, default: null },
    // Copied into every access token. Incrementing it (password change, "log out everywhere",
    // suspension) makes all previously issued access tokens fail immediately.
    tokenVersion: { type: Number, required: true, default: 0, min: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true },
);

userSchema.index({ createdAt: -1 });

export type UserFields = InferSchemaType<typeof userSchema>;
export type UserDocument = HydratedDocument<UserFields>;

export const User = model('User', userSchema);
