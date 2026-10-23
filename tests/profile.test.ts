import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { User } from '../src/modules/users/user.model.js';
import { useTestDatabase } from './helpers/db.js';
import { signedInAs } from './helpers/factories.js';

useTestDatabase({ roles: true });

const app = createApp();

describe('PATCH /auth/me (own profile)', () => {
  it('lets any signed-in user edit their own personal fields only', async () => {
    for (const role of ['TRAINER', 'SALES', 'VIEWER'] as const) {
      const me = await signedInAs(app, role);
      const res = await request(app)
        .patch('/api/v1/auth/me')
        .set(me.auth)
        .send({
          firstName: 'Mona',
          lastName: 'Adel',
          phone: '+971 50 123 4567',
          location: 'Dubai',
          // Not editable by the user themselves:
          email: 'hijack@example.com',
          role: 'OWNER',
          status: 'ACTIVE',
          department: 'Board',
          permissions: ['users:create'],
        });
      expect(res.status, role).toBe(200);
      expect(res.body.data).toMatchObject({
        name: 'Mona Adel',
        phone: '+971 50 123 4567',
        location: 'Dubai',
        email: me.email,
        role,
        department: null,
      });
      expect(res.body.data.permissions).not.toContain('users:create');
      const stored = await User.findById(me.id).lean();
      expect(stored).toMatchObject({ email: me.email, department: null });
    }
  });

  it('clears location with an empty string and validates input', async () => {
    const me = await signedInAs(app, 'SALES');
    await request(app).patch('/api/v1/auth/me').set(me.auth).send({ location: 'Cairo' });
    expect((await request(app).patch('/api/v1/auth/me').set(me.auth).send({ location: '' })).body.data.location).toBeNull();

    for (const body of [{}, { firstName: '' }, { phone: 'abc' }, { email: 'x@y.z' }]) {
      const res = await request(app).patch('/api/v1/auth/me').set(me.auth).send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect((await request(app).patch('/api/v1/auth/me').send({ firstName: 'X' })).status).toBe(401);
  });
});
