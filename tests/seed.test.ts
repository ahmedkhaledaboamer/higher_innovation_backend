import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/createApp.js';
import { seedOwner, seedRoles } from '../src/database/setup.js';
import { Role } from '../src/modules/roles/role.model.js';
import { User } from '../src/modules/users/user.model.js';
import { useTestDatabase } from './helpers/db.js';
import { createUser, login, uniqueEmail } from './helpers/factories.js';

useTestDatabase();

const owner = () => ({ email: uniqueEmail('owner'), password: 'Owner-password-1', firstName: 'Ahmed', lastName: 'Owner' });

describe('seed', () => {
  it('creates the seven roles and is safe to run again', async () => {
    await seedRoles();
    await seedRoles();
    const roles = await Role.find().sort({ level: 1 }).lean();
    expect(roles).toHaveLength(7);
    expect(roles[0]).toMatchObject({ key: 'OWNER', level: 0, isSystem: true });
  });

  it('creates one active Owner who can sign in, and never a second one', async () => {
    await seedRoles();
    const input = owner();

    expect(await seedOwner(input)).toEqual({ created: true, email: input.email });
    expect(await seedOwner(owner())).toEqual({ created: false, reason: 'OWNER_EXISTS' });
    expect(await User.countDocuments()).toBe(1);

    const session = await login(createApp(), input.email, input.password);
    const me = await request(createApp()).get('/api/v1/auth/me').set(session.auth);
    expect(me.body.data).toMatchObject({ role: 'OWNER', status: 'ACTIVE' });
  });

  it('refuses to promote an existing non-Owner account', async () => {
    await seedRoles();
    const { email } = await createUser({ role: 'SALES' });
    await expect(seedOwner({ ...owner(), email })).rejects.toThrow(/never promoted/);
  });
});
