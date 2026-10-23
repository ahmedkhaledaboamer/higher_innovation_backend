import { User } from '../users/user.model.js';
import { type Permission, ROLE_DEFINITIONS, type RoleKey } from './permissions.js';
import { Role } from './role.model.js';

export interface RoleDto {
  id: string;
  key: RoleKey;
  name: string;
  description: string;
  level: number;
  isSystem: boolean;
  permissions: readonly Permission[];
  usersCount: number;
}

export const rolesService = {
  /** Roles ordered from most to least privileged, with their permissions and user counts. */
  async list(): Promise<RoleDto[]> {
    const [roles, counts] = await Promise.all([
      Role.find().sort({ level: 1, name: 1 }).lean(),
      User.aggregate<{ _id: unknown; count: number }>([{ $group: { _id: '$role', count: { $sum: 1 } } }]),
    ]);
    const countByRole = new Map(counts.map((row) => [String(row._id), row.count]));

    return roles.map((role) => ({
      id: role._id.toString(),
      key: role.key,
      name: role.name,
      description: role.description,
      level: role.level,
      isSystem: role.isSystem,
      permissions: ROLE_DEFINITIONS[role.key].permissions,
      usersCount: countByRole.get(role._id.toString()) ?? 0,
    }));
  },
};
