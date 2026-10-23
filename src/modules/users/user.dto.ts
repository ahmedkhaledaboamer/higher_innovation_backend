import type { Types } from 'mongoose';
import type { Permission, RoleKey } from '../roles/permissions.js';
import type { UserStatus } from './user.model.js';

/** A user document with its role populated, as loaded by the services. */
export interface UserWithRole {
  _id: Types.ObjectId;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string | null;
  role: { key: RoleKey; name: string };
  status: UserStatus;
  avatarUrl?: string | null;
  department?: string | null;
  location?: string | null;
  lastLoginAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Fields to populate on `role` wherever a UserDto will be built. */
export const ROLE_FIELDS = 'key name';

/**
 * The only shape in which a user leaves the API.
 *
 * Built field by field (an allow-list), so secrets such as passwordHash or
 * tokenVersion can never leak, even if a query accidentally selects them.
 */
export interface UserDto {
  id: string;
  firstName: string;
  lastName: string;
  /** firstName + lastName, matching the frontend's `User.name`. */
  name: string;
  email: string;
  phone: string | null;
  role: RoleKey;
  roleName: string;
  status: UserStatus;
  avatarUrl: string | null;
  department: string | null;
  location: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CurrentUserDto extends UserDto {
  permissions: readonly Permission[];
}

export function toUserDto(user: UserWithRole): UserDto {
  return {
    id: user._id.toString(),
    firstName: user.firstName,
    lastName: user.lastName,
    name: `${user.firstName} ${user.lastName}`.trim(),
    email: user.email,
    phone: user.phone ?? null,
    role: user.role.key,
    roleName: user.role.name,
    status: user.status,
    avatarUrl: user.avatarUrl ?? null,
    department: user.department ?? null,
    location: user.location ?? null,
    lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}
