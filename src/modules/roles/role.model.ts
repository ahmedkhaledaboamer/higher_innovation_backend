import { type InferSchemaType, model, Schema } from 'mongoose';
import { ROLE_KEYS } from './permissions.js';

/**
 * A role users can hold. The seven system roles are created by the seed command;
 * their permissions are defined in code (permissions.ts), not stored here.
 */
const roleSchema = new Schema(
  {
    key: { type: String, enum: ROLE_KEYS, required: true, unique: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: '', trim: true },
    level: { type: Number, required: true, min: 0 },
    isSystem: { type: Boolean, default: true },
  },
  { timestamps: true },
);

export type RoleDocument = InferSchemaType<typeof roleSchema>;

export const Role = model('Role', roleSchema);
