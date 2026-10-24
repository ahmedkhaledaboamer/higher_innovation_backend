import jwt from 'jsonwebtoken';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/createApp.js';
import { RefreshToken } from '../src/modules/auth/refreshToken.model.js';
import { User } from '../src/modules/users/user.model.js';
import { hashToken } from '../src/utils/tokens.js';
import { useTestDatabase } from './helpers/db.js';
import { createUser, DEFAULT_PASSWORD, extractRefreshCookie, login, uniqueEmail } from './helpers/factories.js';

useTestDatabase({ roles: true });

const app = createApp();
const SECRET = process.env.JWT_ACCESS_SECRET!;
const SENSITIVE = /passwordHash|tokenHash|tokenVersion|\$2[aby]\$/;

const me = (auth?: Record<string, string>) => request(app).get('/api/v1/auth/me').set(auth ?? {});
const refresh = (cookie?: string) => {
  const req = request(app).post('/api/v1/auth/refresh');
  return cookie ? req.set('Cookie', cookie) : req;
};

describe('POST /auth/login', () => {
  it('signs in with valid credentials and sets a hardened refresh cookie', async () => {
    const { email } = await createUser({ role: 'SALES' });

    const res = await request(app).post('/api/v1/auth/login').send({ email: email.toUpperCase(), password: DEFAULT_PASSWORD });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      tokenType: 'Bearer',
      expiresIn: 900,
      user: { email, role: 'SALES', roleName: 'Sales', status: 'ACTIVE' },
    });
    expect(res.body.data.accessToken).toEqual(expect.any(String));
    expect(res.headers['cache-control']).toBe('no-store');

    const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('crm_refresh='))!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Path=\/api\/v1\/auth/);
    expect(cookie).toMatch(/SameSite=Strict/);

    // Neither the body nor the database exposes secrets.
    expect(JSON.stringify(res.body)).not.toMatch(SENSITIVE);
    expect(JSON.stringify(res.body)).not.toContain(extractRefreshCookie(res).split('=')[1]);
    const stored = await RefreshToken.findOne().lean();
    expect(stored!.tokenHash).toBe(hashToken(extractRefreshCookie(res).split('=')[1]!));
    expect((await User.findOne({ email }).lean())!.lastLoginAt).toBeInstanceOf(Date);
  });

  it('rejects a wrong password and an unknown email with the same response', async () => {
    const { email } = await createUser();

    const wrongPassword = await request(app).post('/api/v1/auth/login').send({ email, password: 'Wrong-password-1' });
    const unknownEmail = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: uniqueEmail('nobody'), password: 'Wrong-password-1' });

    for (const res of [wrongPassword, unknownEmail]) {
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' });
      expect(res.headers['set-cookie']).toBeUndefined();
    }
  });

  it('does not let an invited user (no password yet) sign in', async () => {
    const { email } = await createUser({ status: 'INVITED', password: null });
    const res = await request(app).post('/api/v1/auth/login').send({ email, password: DEFAULT_PASSWORD });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_CREDENTIALS');
  });

  it('refuses a suspended account even with the right password', async () => {
    const { email } = await createUser({ status: 'SUSPENDED' });
    const res = await request(app).post('/api/v1/auth/login').send({ email, password: DEFAULT_PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ACCOUNT_DISABLED');
  });

  it('validates the request body', async () => {
    const res = await request(app).post('/api/v1/auth/login').send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(res.body.errors.map((e: { path: string }) => e.path).sort()).toEqual(['email', 'password']);
  });

  it('has no public registration endpoint', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: uniqueEmail(), password: DEFAULT_PASSWORD, role: 'OWNER' });
    expect(res.status).toBe(404);
  });
});

describe('access token validation (GET /auth/me)', () => {
  it('returns the current user with their permissions', async () => {
    const { email } = await createUser({ role: 'SALES' });
    const session = await login(app, email);

    const res = await me(session.auth);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ email, role: 'SALES', name: 'Test User' });
    expect(res.body.data.permissions).toContain('leads:read_assigned');
    expect(res.body.data.permissions).not.toContain('leads:read_all');
    expect(JSON.stringify(res.body)).not.toMatch(SENSITIVE);
  });

  it('requires a token', async () => {
    const res = await me();
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('rejects malformed, forged and expired tokens', async () => {
    const { id } = await createUser();
    const claims = { ver: 0 };
    const options = { subject: id, issuer: 'academy-crm-api', audience: 'academy-crm' };

    const cases: Array<[string, string]> = [
      ['garbage', 'INVALID_TOKEN'],
      [jwt.sign(claims, 'some-other-secret-that-is-long-enough!!', { ...options, expiresIn: 600 }), 'INVALID_TOKEN'],
      [jwt.sign(claims, SECRET, { ...options, audience: 'another-app', expiresIn: 600 }), 'INVALID_TOKEN'],
      [jwt.sign({ ...claims, exp: Math.floor(Date.now() / 1000) - 60 }, SECRET, options), 'TOKEN_EXPIRED'],
      // "alg: none" token: must never be accepted.
      [jwt.sign(claims, '', { ...options, algorithm: 'none' }), 'INVALID_TOKEN'],
    ];

    for (const [token, code] of cases) {
      const res = await me({ Authorization: `Bearer ${token}` });
      expect(res.status, code).toBe(401);
      expect(res.body.code).toBe(code);
    }
  });

  it('rejects the token of a user who was suspended or deleted after signing in', async () => {
    const suspended = await createUser();
    const deleted = await createUser();
    const s1 = await login(app, suspended.email);
    const s2 = await login(app, deleted.email);

    await User.updateOne({ _id: suspended.id }, { status: 'SUSPENDED' });
    await User.deleteOne({ _id: deleted.id });

    expect((await me(s1.auth)).body.code).toBe('ACCOUNT_DISABLED');
    expect((await me(s2.auth)).body.code).toBe('INVALID_TOKEN');
  });
});

describe('refresh token rotation', () => {
  it('issues a new token pair and invalidates the old refresh token', async () => {
    const { email } = await createUser();
    const session = await login(app, email);

    const rotated = await refresh(session.refreshCookie);
    expect(rotated.status).toBe(200);
    expect(rotated.body.data.accessToken).toEqual(expect.any(String));
    const newCookie = extractRefreshCookie(rotated);
    expect(newCookie).not.toBe(session.refreshCookie);
    expect((await me({ Authorization: `Bearer ${rotated.body.data.accessToken}` })).status).toBe(200);

    const reused = await refresh(session.refreshCookie);
    expect(reused.status).toBe(401);
    expect(reused.body.code).toBe('INVALID_REFRESH_TOKEN');
  });

  it('detects reuse of a rotated token and revokes the whole session family', async () => {
    const { email } = await createUser();
    const session = await login(app, email);
    const rotated = await refresh(session.refreshCookie);
    const newCookie = extractRefreshCookie(rotated);

    // An attacker replays the stolen, already-rotated token...
    expect((await refresh(session.refreshCookie)).status).toBe(401);
    // ...so the legitimate newer token stops working too.
    const afterReuse = await refresh(newCookie);
    expect(afterReuse.status).toBe(401);

    const family = await RefreshToken.find().lean();
    expect(family.every((token) => token.revokedAt)).toBe(true);
    expect(family.map((t) => t.revokedReason).sort()).toEqual(['REUSE_DETECTED', 'ROTATED']);
  });

  it('allows only one of two concurrent refreshes with the same token', async () => {
    const { email } = await createUser();
    const session = await login(app, email);

    const results = await Promise.all([refresh(session.refreshCookie), refresh(session.refreshCookie)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
  });

  it('rejects missing, unknown and expired refresh tokens and clears the cookie', async () => {
    expect((await refresh()).body.code).toBe('REFRESH_TOKEN_MISSING');

    const unknown = await refresh('crm_refresh=not-a-real-token');
    expect(unknown.status).toBe(401);
    expect((unknown.headers['set-cookie'] as unknown as string[])[0]).toMatch(/crm_refresh=;.*Expires=Thu, 01 Jan 1970/);

    const { email } = await createUser();
    const session = await login(app, email);
    await RefreshToken.updateMany({}, { expiresAt: new Date(Date.now() - 1000) });
    expect((await refresh(session.refreshCookie)).body.code).toBe('INVALID_REFRESH_TOKEN');
  });

  it('refuses to refresh for an account that has been suspended', async () => {
    const { id, email } = await createUser();
    const session = await login(app, email);
    await User.updateOne({ _id: id }, { status: 'SUSPENDED' });

    const res = await refresh(session.refreshCookie);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('ACCOUNT_DISABLED');
  });
});

describe('logout', () => {
  it('revokes the refresh token and clears the cookie', async () => {
    const { email } = await createUser();
    const session = await login(app, email);

    const res = await request(app).post('/api/v1/auth/logout').set('Cookie', session.refreshCookie);
    expect(res.status).toBe(200);
    expect((res.headers['set-cookie'] as unknown as string[])[0]).toMatch(/^crm_refresh=;/);
    expect((await refresh(session.refreshCookie)).status).toBe(401);
  });

  it('is idempotent without a cookie', async () => {
    expect((await request(app).post('/api/v1/auth/logout')).status).toBe(200);
  });

  it('logout-all ends every session, including existing access tokens', async () => {
    const { email } = await createUser();
    const laptop = await login(app, email);
    const phone = await login(app, email);

    const res = await request(app).post('/api/v1/auth/logout-all').set(laptop.auth);
    expect(res.status).toBe(200);

    expect((await me(laptop.auth)).body.code).toBe('TOKEN_REVOKED');
    expect((await me(phone.auth)).body.code).toBe('TOKEN_REVOKED');
    expect((await refresh(phone.refreshCookie)).status).toBe(401);
  });
});

describe('POST /auth/change-password', () => {
  const change = (auth: Record<string, string>, body: object) =>
    request(app).post('/api/v1/auth/change-password').set(auth).send(body);

  it('requires authentication', async () => {
    expect((await request(app).post('/api/v1/auth/change-password').send({})).status).toBe(401);
  });

  it('rejects a wrong current password and a weak new password', async () => {
    const { email } = await createUser();
    const session = await login(app, email);

    const wrong = await change(session.auth, { currentPassword: 'Not-my-password-1', newPassword: 'Brand-new-pass-7' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.code).toBe('INVALID_CURRENT_PASSWORD');

    const weak = await change(session.auth, { currentPassword: DEFAULT_PASSWORD, newPassword: 'short' });
    expect(weak.status).toBe(400);
    expect(weak.body.code).toBe('VALIDATION_ERROR');

    const same = await change(session.auth, { currentPassword: DEFAULT_PASSWORD, newPassword: DEFAULT_PASSWORD });
    expect(same.status).toBe(400);
  });

  it('changes the password, keeps this device signed in, and signs out the others', async () => {
    const { email } = await createUser();
    const thisDevice = await login(app, email);
    const otherDevice = await login(app, email);
    const newPassword = 'Brand-new-pass-7';

    const res = await change(thisDevice.auth, { currentPassword: DEFAULT_PASSWORD, newPassword });
    expect(res.status).toBe(200);
    const fresh = { Authorization: `Bearer ${res.body.data.accessToken}` };

    expect((await me(fresh)).status).toBe(200);
    expect((await me(thisDevice.auth)).body.code).toBe('TOKEN_REVOKED');
    expect((await me(otherDevice.auth)).body.code).toBe('TOKEN_REVOKED');
    expect((await refresh(otherDevice.refreshCookie)).status).toBe(401);
    expect((await refresh(extractRefreshCookie(res))).status).toBe(200);

    expect((await request(app).post('/api/v1/auth/login').send({ email, password: DEFAULT_PASSWORD })).status).toBe(401);
    await login(app, email, newPassword);
  });
});

describe('login rate limiting', () => {
  it('blocks repeated failed attempts for one account (AUTH_RATE_LIMIT_MAX=10 in tests)', async () => {
    const { email } = await createUser();
    const attempt = (password: string) => request(app).post('/api/v1/auth/login').send({ email, password });

    for (let i = 0; i < 10; i += 1) {
      expect((await attempt('Wrong-password-1')).status).toBe(401);
    }
    const blocked = await attempt(DEFAULT_PASSWORD);
    expect(blocked.status).toBe(429);
    expect(blocked.body.code).toBe('RATE_LIMITED');

    // Other accounts from the same client are unaffected.
    const other = await createUser();
    expect((await request(app).post('/api/v1/auth/login').send({ email: other.email, password: DEFAULT_PASSWORD })).status).toBe(200);
  });
});
