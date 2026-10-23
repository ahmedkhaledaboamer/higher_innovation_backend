import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { ActionToken } from '../src/modules/auth/actionToken.model.js';
import { hashToken } from '../src/utils/tokens.js';
import { useTestDatabase } from './helpers/db.js';
import { createUser, DEFAULT_PASSWORD, login, uniqueEmail } from './helpers/factories.js';
import { emailsTo, tokenFromEmail, waitForEmail } from './helpers/outbox.js';

useTestDatabase({ roles: true });

const app = createApp();
const NEW_PASSWORD = 'Fresh-password-99';

const forgot = (email: string) => request(app).post('/api/v1/auth/forgot-password').send({ email });
const reset = (token: string, password = NEW_PASSWORD) =>
  request(app).post('/api/v1/auth/reset-password').send({ token, password });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('POST /auth/forgot-password', () => {
  it('answers identically for unknown and known emails (no account enumeration)', async () => {
    const { email } = await createUser();
    const unknown = uniqueEmail('ghost');

    const a = await forgot(unknown);
    const b = await forgot(email);

    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    expect(a.body).toEqual(b.body);

    await waitForEmail(email);
    await sleep(100);
    expect(await emailsTo(unknown)).toHaveLength(0);
  });

  it('sends nothing to suspended or invited accounts', async () => {
    const suspended = await createUser({ status: 'SUSPENDED' });
    const invited = await createUser({ status: 'INVITED', password: null });

    await forgot(suspended.email);
    await forgot(invited.email);
    await sleep(150);

    expect(await emailsTo(suspended.email)).toHaveLength(0);
    expect(await emailsTo(invited.email)).toHaveLength(0);
  });

  it('emails a frontend link and stores only a hash of the token', async () => {
    const { email } = await createUser();
    await forgot(email);

    const message = await waitForEmail(email);
    expect(message.subject).toBe('Reset your Academy CRM password');
    expect(message.text).toContain('http://localhost:5173/reset-password?token=');

    const raw = tokenFromEmail(message);
    const stored = await ActionToken.findOne({ purpose: 'PASSWORD_RESET' }).lean();
    expect(stored!.tokenHash).toBe(hashToken(raw));
    expect(stored!.tokenHash).not.toBe(raw);
    // Expires in ~30 minutes.
    const minutes = (stored!.expiresAt.getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(29);
    expect(minutes).toBeLessThanOrEqual(30);
  });
});

describe('POST /auth/reset-password', () => {
  it('sets the new password, works only once, and ends existing sessions', async () => {
    const { email } = await createUser();
    const session = await login(app, email);

    await forgot(email);
    const token = tokenFromEmail(await waitForEmail(email));

    const res = await reset(token);
    expect(res.status).toBe(200);

    // Single use.
    const again = await reset(token, 'Another-password-5');
    expect(again.status).toBe(400);
    expect(again.body.code).toBe('INVALID_RESET_TOKEN');

    // Every pre-existing session is gone.
    expect((await request(app).get('/api/v1/auth/me').set(session.auth)).body.code).toBe('TOKEN_REVOKED');
    expect((await request(app).post('/api/v1/auth/refresh').set('Cookie', session.refreshCookie)).status).toBe(401);

    // Old password no longer works, new one does.
    expect((await request(app).post('/api/v1/auth/login').send({ email, password: DEFAULT_PASSWORD })).status).toBe(401);
    await login(app, email, NEW_PASSWORD);
  });

  it('rejects an expired token', async () => {
    const { email } = await createUser();
    await forgot(email);
    const token = tokenFromEmail(await waitForEmail(email));
    await ActionToken.updateMany({}, { expiresAt: new Date(Date.now() - 1000) });

    const res = await reset(token);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_RESET_TOKEN');
  });

  it('invalidates an older link when a new one is requested', async () => {
    const { email } = await createUser();
    await forgot(email);
    const first = tokenFromEmail(await waitForEmail(email, 1));
    await forgot(email);
    const second = tokenFromEmail(await waitForEmail(email, 2));

    expect((await reset(first)).status).toBe(400);
    expect((await reset(second)).status).toBe(200);
  });

  it('rejects unknown tokens and weak passwords', async () => {
    const unknown = await reset('x'.repeat(43));
    expect(unknown.status).toBe(400);
    expect(unknown.body.code).toBe('INVALID_RESET_TOKEN');

    const weak = await reset('x'.repeat(43), 'password');
    expect(weak.status).toBe(400);
    expect(weak.body.code).toBe('VALIDATION_ERROR');
    expect(weak.body.errors[0].path).toBe('password');
  });

  it('cannot be used to reactivate a suspended account', async () => {
    const { id, email } = await createUser();
    await forgot(email);
    const token = tokenFromEmail(await waitForEmail(email));

    const { User } = await import('../src/modules/users/user.model.js');
    await User.updateOne({ _id: id }, { status: 'SUSPENDED' });

    expect((await reset(token)).status).toBe(400);
    expect((await User.findById(id).lean())!.status).toBe('SUSPENDED');
  });
});
