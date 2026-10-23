/**
 * Who may do what. This file is the single source of truth for authorization.
 *
 * Routes declare the permission they need (`authorize(PERMISSIONS.USERS_CREATE)`);
 * a role grants a fixed set of permissions. Roles live in the database (seeded,
 * so the frontend can list them), but their permissions are defined here in code,
 * reviewed like any other code change and impossible to alter through the API.
 *
 * Permissions for modules that do not exist yet are defined now so the whole
 * matrix can be reviewed in one place; they are enforced when those modules ship.
 */

export const PERMISSIONS = {
  USERS_READ: 'users:read',
  USERS_CREATE: 'users:create',
  USERS_UPDATE: 'users:update',
  USERS_ASSIGN_ROLE: 'users:assign_role',
  ROLES_READ: 'roles:read',

  // Leads. "all" = every lead; "assigned" = only leads where assignedTo is the caller.
  // update_* also covers status changes and adding notes. Leads are archived, never deleted.
  LEADS_READ_ALL: 'leads:read_all',
  LEADS_READ_ASSIGNED: 'leads:read_assigned',
  LEADS_CREATE: 'leads:create',
  LEADS_UPDATE_ALL: 'leads:update_all',
  LEADS_UPDATE_ASSIGNED: 'leads:update_assigned',
  LEADS_ASSIGN: 'leads:assign',
  LEADS_ARCHIVE: 'leads:archive',

  // Courses (catalog). courses:write covers create, edit, archive and restore.
  COURSES_READ: 'courses:read',
  COURSES_WRITE: 'courses:write',

  // Students. Same model as leads: "all" = every student; "assigned" = students whose
  // advisor is the caller. students:assign changes the advisor.
  STUDENTS_READ_ALL: 'students:read_all',
  STUDENTS_READ_ASSIGNED: 'students:read_assigned',
  STUDENTS_CREATE: 'students:create',
  STUDENTS_UPDATE_ALL: 'students:update_all',
  STUDENTS_UPDATE_ASSIGNED: 'students:update_assigned',
  STUDENTS_ASSIGN: 'students:assign',
  STUDENTS_ARCHIVE: 'students:archive',
  /** Trainers: students enrolled in courses the caller teaches (open assignment). Reduced fields. */
  STUDENTS_READ_TEACHING: 'students:read_teaching',

  // Enrollments. Visibility follows the student: you see/change the enrollments of the
  // students you can see/change.
  ENROLLMENTS_READ: 'enrollments:read',
  ENROLLMENTS_WRITE: 'enrollments:write',

  // Trainers and trainer assignments. trainers:write covers profiles, assignments, archive.
  TRAINERS_READ: 'trainers:read',
  TRAINERS_WRITE: 'trainers:write',
  /** The caller's own trainer profile and assignments (users linked to a trainer profile). */
  TRAINERS_READ_OWN: 'trainers:read_own',

  // Phases 7-8
  CAMPAIGNS_READ: 'campaigns:read',
  CAMPAIGNS_WRITE: 'campaigns:write',
  REPORTS_READ: 'reports:read',
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ROLE_KEYS = ['OWNER', 'ADMIN', 'MARKETING', 'SALES', 'HR', 'TRAINER', 'VIEWER'] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];

export interface RoleDefinition {
  key: RoleKey;
  name: string;
  description: string;
  /** Lower is more privileged. Matches the frontend's Role.level. */
  level: number;
  permissions: readonly Permission[];
}

const P = PERMISSIONS;
const ALL_PERMISSIONS = Object.values(PERMISSIONS);

export const ROLE_DEFINITIONS: Record<RoleKey, RoleDefinition> = {
  OWNER: {
    key: 'OWNER',
    name: 'Owner',
    description: 'Full access to the whole system. Created only by the seed command.',
    level: 0,
    permissions: ALL_PERMISSIONS,
  },
  ADMIN: {
    key: 'ADMIN',
    name: 'Admin',
    description: 'Manages the system and staff accounts below Admin.',
    level: 1,
    permissions: ALL_PERMISSIONS,
  },
  MARKETING: {
    key: 'MARKETING',
    name: 'Marketing',
    description: 'Campaigns, lead sources and marketing reports; can add and view leads.',
    level: 2,
    permissions: [P.CAMPAIGNS_READ, P.CAMPAIGNS_WRITE, P.LEADS_READ_ALL, P.LEADS_CREATE, P.COURSES_READ, P.REPORTS_READ],
  },
  SALES: {
    key: 'SALES',
    name: 'Sales',
    description: 'Works the leads assigned to them and registers students.',
    level: 2,
    permissions: [
      P.LEADS_READ_ASSIGNED,
      P.LEADS_UPDATE_ASSIGNED,
      P.LEADS_CREATE,
      P.STUDENTS_READ_ASSIGNED,
      P.STUDENTS_CREATE,
      P.STUDENTS_UPDATE_ASSIGNED,
      P.ENROLLMENTS_READ,
      P.ENROLLMENTS_WRITE,
      P.COURSES_READ,
    ],
  },
  HR: {
    key: 'HR',
    name: 'HR',
    description: 'Views staff accounts and trainer records.',
    level: 2,
    permissions: [P.USERS_READ, P.ROLES_READ, P.TRAINERS_READ],
  },
  TRAINER: {
    key: 'TRAINER',
    name: 'Trainer',
    description: 'Sees the course catalog, their own assignments, and the students and enrollments of the courses they teach.',
    level: 3,
    // Read-only and limited to courses with an open assignment for the caller's trainer
    // profile; see modules/assignments/teaching.access.ts. No write permission of any kind.
    permissions: [P.COURSES_READ, P.TRAINERS_READ_OWN, P.STUDENTS_READ_TEACHING, P.ENROLLMENTS_READ],
  },
  VIEWER: {
    key: 'VIEWER',
    name: 'Viewer',
    description: 'Read-only access to business data; no access to staff accounts.',
    level: 4,
    permissions: [
      P.LEADS_READ_ALL,
      P.COURSES_READ,
      P.STUDENTS_READ_ALL,
      P.ENROLLMENTS_READ,
      P.TRAINERS_READ,
      P.CAMPAIGNS_READ,
      P.REPORTS_READ,
    ],
  },
};

export function permissionsFor(role: RoleKey): readonly Permission[] {
  return ROLE_DEFINITIONS[role].permissions;
}

export function hasPermission(role: RoleKey, permission: Permission): boolean {
  return ROLE_DEFINITIONS[role].permissions.includes(permission);
}

/**
 * Staff-management hierarchy: an actor may manage (create, edit, re-role) only users
 * whose role is strictly less privileged than their own, and only assign such roles.
 * Owner > Admin > everyone else. Nobody can grant OWNER through the API.
 */
export function canManageRole(actor: RoleKey, target: RoleKey): boolean {
  if (target === 'OWNER') return false;
  if (actor === 'OWNER') return true;
  if (actor === 'ADMIN') return target !== 'ADMIN';
  return false;
}
