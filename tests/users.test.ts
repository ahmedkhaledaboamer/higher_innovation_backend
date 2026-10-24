import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/createApp.js';
import { User } from '../src/modules/users/user.model.js';
import { useTestDatabase } from './helpers/db.js';
import { createUser, login, signedInAs, uniqueEmail } from './helpers/factories.js';
import { tokenFromEmail, waitForEmail } from './helpers/outbox.js';

useTestDatabase({ roles: true });

const app = createApp();
const SENSITIVE = /passwordHash|tokenHash|tokenVersion|\$2[aby]\$/;

const newUser = (overrides: Record<string, unknown> = {}) => ({
  firstName: 'Nour',
  lastName: 'Hassan',
  email: uniqueEmail('staff'),
  role: 'SALES',
  ...overrides,
});

describe('access to /users', () => {
  it('requires authentication', async () => {
    expect((await request(app).get('/api/v1/users')).status).toBe(401);
  });

  it('is forbidden to roles without users:read', async () => {
    for (const role of ['SALES', 'MARKETING', 'TRAINER', 'VIEWER'] as const) {
      const { auth } = await signedInAs(app, role);
      const res = await request(app).get('/api/v1/users').set(auth);
      expect(res.status, role).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
    }
  });

  it('lets HR read users but not create them', async () => {
    const hr = await signedInAs(app, 'HR');
    expect((await request(app).get('/api/v1/users').set(hr.auth)).status).toBe(200);
    expect((await request(app).post('/api/v1/users').set(hr.auth).send(newUser())).status).toBe(403);
  });
});

describe('GET /users', () => {
  it('paginates, searches and filters without exposing secrets', async () => {
    const admin = await signedInAs(app, 'ADMIN');
    await createUser({ role: 'SALES', firstName: 'Salma' });
    await createUser({ role: 'SALES', firstName: 'Samir' });
    await createUser({ role: 'MARKETING', firstName: 'Mona' });

    const page = await request(app).get('/api/v1/users?limit=2&page=1&sortBy=createdAt&sortDir=asc').set(admin.auth);
    expect(page.status).toBe(200);
    expect(page.body.data).toHaveLength(2);
    expect(page.body.meta).toEqual({ page: 1, limit: 2, total: 4, totalPages: 2 });
    expect(JSON.stringify(page.body)).not.toMatch(SENSITIVE);

    const sales = await request(app).get('/api/v1/users?role=SALES').set(admin.auth);
    expect(sales.body.data.map((u: { firstName: string }) => u.firstName).sort()).toEqual(['Salma', 'Samir']);

    const search = await request(app).get('/api/v1/users?search=mon').set(admin.auth);
    expect(search.body.data.map((u: { firstName: string }) => u.firstName)).toEqual(['Mona']);

    const bad = await request(app).get('/api/v1/users?limit=1000&role=GOD').set(admin.auth);
    expect(bad.status).toBe(400);
  });

  it('returns one user by id, 404 for unknown ids and 400 for malformed ids', async () => {
    const admin = await signedInAs(app, 'ADMIN');
    const { id } = await createUser();

    expect((await request(app).get(`/api/v1/users/${id}`).set(admin.auth)).body.data.id).toBe(id);
    expect((await request(app).get('/api/v1/users/665f1c2e9b3e4a0012345678').set(admin.auth)).status).toBe(404);
    expect((await request(app).get('/api/v1/users/not-an-id').set(admin.auth)).status).toBe(400);
  });
});

describe('POST /users (invitations)', () => {
  it('creates an INVITED user who activates the account through the emailed link', async () => {
    const admin = await signedInAs(app, 'ADMIN');
    const body = newUser({ status: 'ACTIVE', passwordHash: 'injected', password: 'Injected-pass-1' });

    const res = await request(app).post('/api/v1/users').set(admin.auth).send(body);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ email: body.email, role: 'SALES', status: 'INVITED', inviteSent: true });
    expect(JSON.stringify(res.body)).not.toMatch(SENSITIVE);

    // Fields the client tried to smuggle in were ignored.
    const stored = await User.findOne({ email: body.email }).select('+passwordHash').lean();
    expect(stored!.passwordHash).toBeNull();
    expect(stored!.createdBy!.toString()).toBe(admin.id);

    // Cannot sign in before accepting the invitation.
    expect((await request(app).post('/api/v1/auth/login').send({ email: body.email, password: 'Injected-pass-1' })).status).toBe(401);

    const invite = await waitForEmail(body.email);
    expect(invite.subject).toBe('Your Academy CRM account');
    const accept = await request(app)
      .post('/api/v1/auth/reset-password')
      .send({ token: tokenFromEmail(invite), password: 'My-own-password-1' });
    expect(accept.status).toBe(200);

    const session = await login(app, body.email, 'My-own-password-1');
    const me = await request(app).get('/api/v1/auth/me').set(session.auth);
    expect(me.body.data).toMatchObject({ status: 'ACTIVE', role: 'SALES' });
  });

  it('enforces the role hierarchy: nobody creates an Owner, only the Owner creates Admins', async () => {
    const owner = await signedInAs(app, 'OWNER');
    const admin = await signedInAs(app, 'ADMIN');

    for (const [actor, role, status] of [
      [admin, 'OWNER', 403],
      [admin, 'ADMIN', 403],
      [owner, 'OWNER', 403],
      [owner, 'ADMIN', 201],
      [admin, 'VIEWER', 201],
    ] as const) {
      const res = await request(app).post('/api/v1/users').set(actor.auth).send(newUser({ role }));
      expect(res.status, `${actor.email} -> ${role}`).toBe(status);
      if (status === 403) expect(res.body.code).toBe('ROLE_NOT_ASSIGNABLE');
    }
  });

  it('rejects duplicate emails and invalid input', async () => {
    const admin = await signedInAs(app, 'ADMIN');
    const { email } = await createUser();

    const duplicate = await request(app).post('/api/v1/users').set(admin.auth).send(newUser({ email: email.toUpperCase() }));
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe('EMAIL_TAKEN');

    const invalid = await request(app).post('/api/v1/users').set(admin.auth).send({ email: 'nope', role: 'KING' });
    expect(invalid.status).toBe(400);
    expect(invalid.body.errors.map((e: { path: string }) => e.path).sort()).toEqual(['email', 'firstName', 'lastName', 'role']);
  });

  it('resends an invitation, and refuses for an already active user', async () => {
    const admin = await signedInAs(app, 'ADMIN');
    const created = await request(app).post('/api/v1/users').set(admin.auth).send(newUser());
    const { id, email } = created.body.data;

    const resend = await request(app).post(`/api/v1/users/${id}/resend-invite`).set(admin.auth);
    expect(resend.status).toBe(200);
    const first = tokenFromEmail(await waitForEmail(email, 1));
    const second = tokenFromEmail(await waitForEmail(email, 2));
    // Only the newest link works.
    expect((await request(app).post('/api/v1/auth/reset-password').send({ token: first, password: 'My-own-password-1' })).status).toBe(400);
    expect((await request(app).post('/api/v1/auth/reset-password').send({ token: second, password: 'My-own-password-1' })).status).toBe(200);

    expect((await request(app).post(`/api/v1/users/${id}/resend-invite`).set(admin.auth)).status).toBe(409);
  });
});

describe('PATCH /users/:id/role', () => {
  it('changes a role and the new permissions apply on the next request', async () => {
    const admin = await signedInAs(app, 'ADMIN');
    const sales = await signedInAs(app, 'SALES');

    const res = await request(app).patch(`/api/v1/users/${sales.id}/role`).set(admin.auth).send({ role: 'MARKETING' });
    expect(res.status).toBe(200);
    expect(res.body.data.role).toBe('MARKETING');

    const me = await request(app).get('/api/v1/auth/me').set(sales.auth);
    expect(me.body.data.role).toBe('MARKETING');
    expect(me.body.data.permissions).toContain('campaigns:write');
  });

  it('blocks escalation, managing higher roles, and changing your own role', async () => {
    const owner = await signedInAs(app, 'OWNER');
    const admin = await signedInAs(app, 'ADMIN');
    const otherAdmin = await createUser({ role: 'ADMIN' });
    const sales = await createUser({ role: 'SALES' });
    const salesSession = await login(app, sales.email);

    const cases = [
      [admin, sales.id, 'ADMIN', 'ROLE_NOT_ASSIGNABLE'],
      [admin, sales.id, 'OWNER', 'ROLE_NOT_ASSIGNABLE'],
      [admin, otherAdmin.id, 'SALES', 'INSUFFICIENT_ROLE'],
      [admin, owner.id, 'SALES', 'INSUFFICIENT_ROLE'],
      [admin, admin.id, 'OWNER', 'CANNOT_MODIFY_SELF'],
      [owner, owner.id, 'ADMIN', 'CANNOT_MODIFY_SELF'],
      [owner, sales.id, 'OWNER', 'ROLE_NOT_ASSIGNABLE'],
    ] as const;
    for (const [actor, targetId, role, code] of cases) {
      const res = await request(app).patch(`/api/v1/users/${targetId}/role`).set(actor.auth).send({ role });
      expect(res.status, code).toBe(403);
      expect(res.body.code).toBe(code);
    }

    // A Sales user lacks the permission entirely, even for themselves.
    const self = await request(app).patch(`/api/v1/users/${sales.id}/role`).set(salesSession.auth).send({ role: 'ADMIN' });
    expect(self.status).toBe(403);
    expect((await User.findById(sales.id).populate<{ role: { key: string } }>('role').lean())!.role.key).toBe('SALES');
  });
});

describe('PATCH /users/:id', () => {
  it('suspending a user ends their sessions immediately', async () => {
    const admin = await signedInAs(app, 'ADMIN');
    const sales = await signedInAs(app, 'SALES');

    const res = await request(app).patch(`/api/v1/users/${sales.id}`).set(admin.auth).send({ status: 'SUSPENDED' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('SUSPENDED');

    expect((await request(app).get('/api/v1/auth/me').set(sales.auth)).status).toBe(401);
    expect((await request(app).post('/api/v1/auth/refresh').set('Cookie', sales.refreshCookie)).status).toBe(401);
    expect((await request(app).post('/api/v1/auth/login').send({ email: sales.email, password: sales.password })).status).toBe(403);
  });

  it('updates profile fields and refuses status changes on yourself or on higher roles', async () => {
    const admin = await signedInAs(app, 'ADMIN');
    const owner = await createUser({ role: 'OWNER' });
    const sales = await createUser();

    const profile = await request(app)
      .patch(`/api/v1/users/${sales.id}`)
      .set(admin.auth)
      .send({ firstName: 'Karim', department: 'Sales', location: '' });
    expect(profile.status).toBe(200);
    expect(profile.body.data).toMatchObject({ firstName: 'Karim', department: 'Sales', location: null });

    const self = await request(app).patch(`/api/v1/users/${admin.id}`).set(admin.auth).send({ status: 'INACTIVE' });
    expect(self.body.code).toBe('CANNOT_MODIFY_SELF');

    const higher = await request(app).patch(`/api/v1/users/${owner.id}`).set(admin.auth).send({ status: 'SUSPENDED' });
    expect(higher.body.code).toBe('INSUFFICIENT_ROLE');

    const empty = await request(app).patch(`/api/v1/users/${sales.id}`).set(admin.auth).send({});
    expect(empty.status).toBe(400);
  });
});

describe('GET /roles', () => {
  it('lists the seven roles with permissions and user counts', async () => {
    const admin = await signedInAs(app, 'ADMIN');
    await createUser({ role: 'SALES' });

    const res = await request(app).get('/api/v1/roles').set(admin.auth);
    expect(res.status).toBe(200);
    expect(res.body.data.map((r: { key: string }) => r.key)).toEqual([
      'OWNER',
      'ADMIN',
      'HR',
      'MARKETING',
      'SALES',
      'TRAINER',
      'VIEWER',
    ]);
    const salesRole = res.body.data.find((r: { key: string }) => r.key === 'SALES');
    expect(salesRole).toMatchObject({ name: 'Sales', level: 2, isSystem: true, usersCount: 1 });
    expect(salesRole.permissions).toContain('leads:read_assigned');
  });

  it('is forbidden without roles:read', async () => {
    const sales = await signedInAs(app, 'SALES');
    expect((await request(app).get('/api/v1/roles').set(sales.auth)).status).toBe(403);
  });
});

describe('GET /users multi-value filters', () => {
  it('accepts several roles and statuses (comma-separated or repeated)', async () => {
    const admin = await signedInAs(app, 'ADMIN');
    await createUser({ role: 'SALES' });
    await createUser({ role: 'MARKETING', status: 'SUSPENDED' });
    await createUser({ role: 'VIEWER' });

    const roles = await request(app).get('/api/v1/users?role=SALES,MARKETING').set(admin.auth);
    expect(roles.body.data.map((u: { role: string }) => u.role).sort()).toEqual(['MARKETING', 'SALES']);
    const repeated = await request(app).get('/api/v1/users?role=SALES&role=VIEWER').set(admin.auth);
    expect(repeated.body.meta.total).toBe(2);
    const statuses = await request(app).get('/api/v1/users?status=SUSPENDED,INVITED').set(admin.auth);
    expect(statuses.body.data.map((u: { status: string }) => u.status)).toEqual(['SUSPENDED']);
    expect((await request(app).get('/api/v1/users?role=SALES,KING').set(admin.auth)).status).toBe(400);
  });
});
