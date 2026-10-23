import { Writable } from 'node:stream';
import express from 'express';
import { pino } from 'pino';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { ActionToken } from '../src/modules/auth/actionToken.model.js';
import { REDACT_PATHS } from '../src/utils/logger.js';
import { useTestDatabase } from './helpers/db.js';
import { signedInAs, uniqueEmail } from './helpers/factories.js';
import { tokenFromEmail, waitForEmail } from './helpers/outbox.js';

/**
 * Release-readiness evidence for security properties that had no direct test before:
 * invitation-link expiry and single use, production masking of unexpected errors, and log redaction.
 */
useTestDatabase({ roles: true });

const app = createApp();

async function invite(): Promise<{ email: string; token: string }> {
  const admin = await signedInAs(app, 'ADMIN');
  const email = uniqueEmail();
  const res = await request(app).post('/api/v1/users').set(admin.auth).send({ firstName: 'Ivy', lastName: 'Invite', email, role: 'VIEWER' });
  expect(res.status).toBe(201);
  return { email, token: tokenFromEmail(await waitForEmail(email)) };
}

const accept = (token: string, password = 'Accepted-pass-1') =>
  request(app).post('/api/v1/auth/reset-password').send({ token, password });

describe('invitation links', () => {
  it('expire after INVITE_TTL_HOURS', async () => {
    const { token } = await invite();
    const stored = await ActionToken.findOne({ purpose: 'INVITE' }).lean();
    const ttlMs = stored!.expiresAt.getTime() - stored!.createdAt!.getTime();
    expect(Math.round(ttlMs / 3_600_000)).toBe(Number(process.env.INVITE_TTL_HOURS ?? 72));

    await ActionToken.updateMany({ purpose: 'INVITE' }, { expiresAt: new Date(Date.now() - 1000) });
    const res = await accept(token);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_RESET_TOKEN');
  });

  it('work only once', async () => {
    const { token } = await invite();
    expect((await accept(token)).status).toBe(200);
    const again = await accept(token, 'Another-pass-22');
    expect(again.status).toBe(400);
    expect(again.body.code).toBe('INVALID_RESET_TOKEN');
  });
});

describe('production error handling', () => {
  it('hides the message and stack of unexpected errors in production', async () => {
    vi.resetModules();
    vi.doMock('../src/config/env.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../src/config/env.js')>()),
      isProduction: true,
    }));
    try {
      const { errorHandler } = await import('../src/middlewares/errorHandler.js');
      const probe = express();
      probe.get('/boom', () => {
        throw new Error('db password is hunter2 at mongodb+srv://user:pw@host');
      });
      probe.use(errorHandler);

      const res = await request(probe).get('/boom');
      expect(res.status).toBe(500);
      expect(res.body).toMatchObject({ success: false, message: 'Internal server error', code: 'INTERNAL_ERROR' });
      expect(JSON.stringify(res.body)).not.toMatch(/hunter2|mongodb|stack|at \w/);
    } finally {
      vi.doUnmock('../src/config/env.js');
      vi.resetModules();
    }
  });
});

describe('log redaction', () => {
  it('censors credentials and tokens in request logs and bodies', () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const log = pino({ redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } }, sink);

    log.info({
      req: { headers: { authorization: 'Bearer eyJsecret.token.value', cookie: 'crm_refresh=opaque-refresh-value' } },
      res: { headers: { 'set-cookie': 'crm_refresh=opaque-refresh-value; HttpOnly' } },
      body: { password: 'Plain-pass-1', newPassword: 'Plain-pass-2', token: 'reset-token-value', refreshToken: 'r', accessToken: 'a' },
    });

    const output = lines.join('');
    expect(output).toContain('[REDACTED]');
    for (const secret of ['eyJsecret', 'opaque-refresh-value', 'Plain-pass-1', 'Plain-pass-2', 'reset-token-value']) {
      expect(output).not.toContain(secret);
    }
  });
});
