import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import request from 'supertest';
import { expect } from 'vitest';
import type { RoleKey } from '../../src/modules/roles/permissions.js';
import { Role } from '../../src/modules/roles/role.model.js';
import { User, type UserStatus } from '../../src/modules/users/user.model.js';
import { hashPassword } from '../../src/utils/password.js';

export const DEFAULT_PASSWORD = 'Correct-horse-42';

export function uniqueEmail(prefix = 'user'): string {
  return `${prefix}.${randomUUID().slice(0, 8)}@example.com`;
}

/** Inserts a real user (real bcrypt hash) directly, the way the seed or an accepted invite would leave it. */
export async function createUser(
  options: { role?: RoleKey; status?: UserStatus; password?: string | null; email?: string; firstName?: string } = {},
) {
  const role = await Role.findOne({ key: options.role ?? 'SALES' }).lean();
  if (!role) throw new Error('Roles not seeded; use useTestDatabase({ roles: true })');

  const email = options.email ?? uniqueEmail((options.role ?? 'sales').toLowerCase());
  const password = options.password === undefined ? DEFAULT_PASSWORD : options.password;
  const user = await User.create({
    firstName: options.firstName ?? 'Test',
    lastName: 'User',
    email,
    passwordHash: password ? await hashPassword(password) : null,
    role: role._id,
    status: options.status ?? 'ACTIVE',
  });
  return { user, id: user._id.toString(), email, password };
}

export interface Session {
  accessToken: string;
  /** "crm_refresh=<token>", ready for `.set('Cookie', ...)`. */
  refreshCookie: string;
  auth: { Authorization: string };
}

/** Reads the refresh cookie from a response's Set-Cookie header. */
export function extractRefreshCookie(res: request.Response): string {
  const header = res.headers['set-cookie'] as unknown as string[] | undefined;
  const cookie = header?.find((value) => value.startsWith('crm_refresh='));
  if (!cookie) throw new Error('No crm_refresh cookie in response');
  return cookie.split(';')[0]!;
}

export async function login(app: Express, email: string, password = DEFAULT_PASSWORD): Promise<Session> {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  const accessToken: string = res.body.data.accessToken;
  return { accessToken, refreshCookie: extractRefreshCookie(res), auth: { Authorization: `Bearer ${accessToken}` } };
}

/** Creates a user with the given role and signs them in. */
export async function signedInAs(app: Express, role: RoleKey) {
  const created = await createUser({ role });
  return { ...created, ...(await login(app, created.email)) };
}
