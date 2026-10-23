import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/config/env.js';
import { hostFingerprint } from '../src/config/mongoUri.js';

const base = {
  MONGODB_URI: 'mongodb://localhost:27017/academy_crm',
  JWT_ACCESS_SECRET: 'x'.repeat(32),
};

/** A configuration that satisfies every production rule. */
const production = {
  ...base,
  NODE_ENV: 'production',
  DEPLOY_ENV: 'production',
  PRODUCTION_DB_HOST_SHA256: hostFingerprint('localhost'),
  MAIL_TRANSPORT: 'smtp',
  SMTP_HOST: 'smtp.example.com',
};

describe('parseEnv', () => {
  it('rejects a MONGODB_URI holding two connection strings, without echoing the value', () => {
    const secret = 'mongodb+srv://user:s3cr3t@cluster0.example.net/db?retryWrites=truemongodb://127.0.0.1:27017/db';
    let message = '';
    try {
      parseEnv({ ...base, MONGODB_URI: secret });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('MONGODB_URI must contain exactly one connection string');
    expect(message).not.toContain('s3cr3t');
    expect(message).not.toContain('cluster0');
  });

  it('rejects whitespace or quotes in MONGODB_URI', () => {
    expect(() => parseEnv({ ...base, MONGODB_URI: 'mongodb://localhost:27017/db mongodb' })).toThrow(/exactly one|spaces or quotes/);
    expect(() => parseEnv({ ...base, MONGODB_URI: '"mongodb://localhost:27017/db"' })).toThrow();
    expect(() => parseEnv({ ...base, MONGODB_URI: 'mongodb://localhost:27017/db?replicaSet=rs0' })).not.toThrow();
  });

  it('applies defaults for optional settings', () => {
    const env = parseEnv({ ...base });
    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(4000);
    expect(env.CORS_ORIGINS).toEqual(['http://localhost:5173']);
    expect(env.API_DOCS_ENABLED).toBe(true);
    expect(env.ACCESS_TOKEN_TTL_SECONDS).toBe(900);
    expect(env.COOKIE_SECURE).toBe(false);
    expect(env.MAIL_TRANSPORT).toBe('outbox');
  });

  it('coerces numbers and splits the CORS origin list', () => {
    const env = parseEnv({
      ...base,
      PORT: '8080',
      CORS_ORIGINS: 'http://localhost:5173, https://crm.example.com',
    });
    expect(env.PORT).toBe(8080);
    expect(env.CORS_ORIGINS).toEqual(['http://localhost:5173', 'https://crm.example.com']);
  });

  it('uses secure defaults in production', () => {
    const env = parseEnv(production);
    expect(env.API_DOCS_ENABLED).toBe(false);
    expect(env.COOKIE_SECURE).toBe(true);
    expect(parseEnv({ ...production, API_DOCS_ENABLED: 'true' }).API_DOCS_ENABLED).toBe(true);
  });

  it('rejects a missing MONGODB_URI', () => {
    expect(() => parseEnv({ JWT_ACCESS_SECRET: base.JWT_ACCESS_SECRET })).toThrow(/MONGODB_URI/);
  });

  it('rejects a non-MongoDB MONGODB_URI', () => {
    expect(() => parseEnv({ ...base, MONGODB_URI: 'postgresql://localhost/db' })).toThrow(/mongodb:\/\//);
  });

  it('requires a JWT secret of at least 32 characters', () => {
    expect(() => parseEnv({ MONGODB_URI: base.MONGODB_URI })).toThrow(/JWT_ACCESS_SECRET/);
    expect(() => parseEnv({ ...base, JWT_ACCESS_SECRET: 'short' })).toThrow(/at least 32/);
  });

  it('refuses unsafe production settings', () => {
    expect(() => parseEnv({ ...production, MAIL_TRANSPORT: 'outbox' })).toThrow(/MAIL_TRANSPORT: must be "smtp"/);
    expect(() => parseEnv({ ...production, COOKIE_SECURE: 'false' })).toThrow(/COOKIE_SECURE: must be true/);
    expect(() => parseEnv({ ...production, BCRYPT_ROUNDS: '8' })).toThrow(/BCRYPT_ROUNDS/);
  });

  it('checks settings that depend on each other', () => {
    expect(() => parseEnv({ ...base, MAIL_TRANSPORT: 'smtp' })).toThrow(/SMTP_HOST/);
    expect(() => parseEnv({ ...base, COOKIE_SAMESITE: 'none' })).toThrow(/SameSite=None/);
  });

  it('rejects malformed values with a readable message', () => {
    expect(() => parseEnv({ ...base, PORT: 'abc', CORS_ORIGINS: 'not-a-url' })).toThrow(/PORT[\s\S]*CORS_ORIGINS/);
  });
});
