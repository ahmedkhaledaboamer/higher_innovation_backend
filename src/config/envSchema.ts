import { z } from 'zod';
import {
  hostHasExactFingerprint,
  hostMatchesFingerprints,
  isIpLiteral,
  isStrictlyUnder,
  memberDomainOf,
  isLoopbackHost,
  isStagingDatabaseName,
  isTestDatabaseName,
  mongoUriParts,
} from './mongoUri.js';

/**
 * Environment schema and validation, free of side effects (no .env loading, no singleton), so it can
 * be used both by the running API (config/env.ts) and by offline checks such as the staging preflight.
 */

const booleanString = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');

/** Comma-separated list of origins, e.g. "http://localhost:5173,https://crm.example.com". */
const originList = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  )
  .pipe(z.array(z.url({ protocol: /^https?$/ })));

/** Comma-separated SHA-256 host fingerprints (see config/mongoUri.ts hostFingerprint). */
const fingerprintList = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  )
  .pipe(z.array(z.string().regex(/^[0-9a-f]{64}$/, 'must be SHA-256 hex fingerprints, comma-separated')));

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),

  MONGODB_URI: z
    .string({ error: 'MONGODB_URI is required' })
    .min(1, 'MONGODB_URI is required')
    .refine((value) => /^mongodb(\+srv)?:\/\//.test(value), {
      message: 'MONGODB_URI must be a mongodb:// or mongodb+srv:// connection string',
    })
    // Exactly one connection string: two pasted together still start with "mongodb://" and would
    // otherwise only fail inside the driver (or connect with a garbled option). Messages never
    // include the value, which may contain credentials.
    .refine((value) => (value.match(/mongodb(\+srv)?:\/\//g) ?? []).length === 1, {
      message: 'MONGODB_URI must contain exactly one connection string',
    })
    .refine((value) => !/[\s"']/.test(value), {
      message: 'MONGODB_URI must not contain spaces or quotes',
    }),

  CORS_ORIGINS: originList.default(['http://localhost:5173']),

  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  /**
   * Number of reverse proxies in front of the app (0 = none).
   * Needed so rate limiting and logs see the client's real IP instead of the proxy's.
   */
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),

  API_DOCS_ENABLED: booleanString.optional(),

  /* ------------------------------ authentication ------------------------------ */

  /** HMAC secret for access tokens. Generate with: node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))" */
  JWT_ACCESS_SECRET: z
    .string({ error: 'JWT_ACCESS_SECRET is required' })
    .min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  JWT_ISSUER: z.string().min(1).default('academy-crm-api'),
  JWT_AUDIENCE: z.string().min(1).default('academy-crm'),

  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(7),

  /** Secure cookies need HTTPS. Defaults to true in production, false elsewhere. */
  COOKIE_SECURE: booleanString.optional(),
  /** "strict" works when the frontend and API share a site (e.g. app.x.com + api.x.com). Use "none" only for different sites. */
  COOKIE_SAMESITE: z.enum(['strict', 'lax', 'none']).default('strict'),
  COOKIE_DOMAIN: z.string().min(1).optional(),

  /** bcrypt work factor. Each +1 doubles hashing time. */
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),

  /** Base URL of the frontend, used to build password-reset and invitation links. */
  FRONTEND_URL: z.url({ protocol: /^https?$/ }).default('http://localhost:5173'),
  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().min(5).max(120).default(30),
  INVITE_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(72),

  /** Stricter limit for login and password-reset endpoints. */
  AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),

  /* ----------------------------------- email ---------------------------------- */

  /** "smtp" sends real email; "outbox" writes each message to MAIL_OUTBOX_DIR (development/tests only). */
  MAIL_TRANSPORT: z.enum(['smtp', 'outbox']).default('outbox'),
  MAIL_FROM: z.string().min(3).default('Academy CRM <no-reply@localhost>'),
  MAIL_OUTBOX_DIR: z.string().min(1).default('.outbox'),
  SMTP_HOST: z.string().min(1).optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  /** true = TLS from the first byte (port 465); false = STARTTLS upgrade (port 587). */
  SMTP_SECURE: booleanString.default(false),
  SMTP_USER: z.string().min(1).optional(),
  SMTP_PASS: z.string().min(1).optional(),

  // --- Deployment identity and isolation (see docs/STAGING.md) ---------------------------------
  /**
   * Which deployment this is. Optional for local development and tests, required with
   * NODE_ENV=production. With "staging" the API refuses production database targets and stays
   * offline until connectivity is approved; with "production" it only accepts declared production hosts.
   */
  DEPLOY_ENV: z.enum(['development', 'test', 'staging', 'production']).optional(),
  /**
   * Comma-separated SHA-256 fingerprints of production database host names or of a parent domain (an
   * Atlas cluster domain such as "<id>.mongodb.net" covers the SRV, shard and private-endpoint hosts).
   * Required for staging and production; optional in development (then production hosts are refused).
   */
  PRODUCTION_DB_HOST_SHA256: fingerprintList.optional(),
  /**
   * Comma-separated SHA-256 fingerprints of the staging database host names or of the staging cluster
   * domain (at least three labels, e.g. "<id>.mongodb.net"). Required for staging: every host the URI
   * names and every host the cluster reports must match one.
   */
  STAGING_DB_HOST_SHA256: fingerprintList.optional(),
  /** Owner's explicit approval for a staging deployment to open database connections. */
  STAGING_CONNECTIVITY_APPROVED: booleanString.default(false),
  /**
   * Development only: lets `npm run seed:demo` write demo data to a non-local database (e.g. a dedicated
   * Atlas database). Must equal the database name in MONGODB_URI exactly, as a typed confirmation.
   */
  DEMO_SEED_REMOTE_DATABASE: z.string().trim().min(1).max(64).optional(),
});

export type Env = z.infer<typeof envSchema> & { API_DOCS_ENABLED: boolean; COOKIE_SECURE: boolean };

/** Parses a raw environment object. Exported separately so it can be unit-tested. */
export function parseEnv(source: NodeJS.ProcessEnv): Env {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    throw configError(result.error.issues.map((issue) => [issue.path.join('.') || '(root)', issue.message]));
  }

  const parsed = result.data;
  const production = parsed.NODE_ENV === 'production';
  const env: Env = {
    ...parsed,
    // Swagger UI is on by default everywhere except production.
    API_DOCS_ENABLED: parsed.API_DOCS_ENABLED ?? !production,
    COOKIE_SECURE: parsed.COOKIE_SECURE ?? production,
  };

  // Rules that involve more than one setting, or that only apply in production.
  const problems: Array<[string, string]> = [];
  if (env.COOKIE_SAMESITE === 'none' && !env.COOKIE_SECURE) {
    problems.push(['COOKIE_SAMESITE', 'browsers reject SameSite=None cookies unless COOKIE_SECURE=true']);
  }
  if (env.MAIL_TRANSPORT === 'smtp' && !env.SMTP_HOST) {
    problems.push(['SMTP_HOST', 'is required when MAIL_TRANSPORT=smtp']);
  }
  if (production) {
    if (env.MAIL_TRANSPORT !== 'smtp') problems.push(['MAIL_TRANSPORT', 'must be "smtp" in production']);
    if (!env.COOKIE_SECURE) problems.push(['COOKIE_SECURE', 'must be true in production']);
    if (env.BCRYPT_ROUNDS < 10) problems.push(['BCRYPT_ROUNDS', 'must be at least 10 in production']);
  }
  problems.push(...deploymentProblems(env), ...databaseTargetProblems(env, env.MONGODB_URI));
  if (problems.length > 0) throw configError(problems);

  return env;
}

/** The settings that decide which databases this process may reach. */
export type DeploymentConfig = Pick<
  Env,
  'NODE_ENV' | 'DEPLOY_ENV' | 'PRODUCTION_DB_HOST_SHA256' | 'STAGING_DB_HOST_SHA256' | 'STAGING_CONNECTIVITY_APPROVED' | 'DEMO_SEED_REMOTE_DATABASE'
>;

type Mode = 'test' | 'staging' | 'production' | 'development';

function modeOf(env: DeploymentConfig): Mode {
  if (env.NODE_ENV === 'test' || env.DEPLOY_ENV === 'test') return 'test';
  if (env.DEPLOY_ENV === 'staging' || env.DEPLOY_ENV === 'production') return env.DEPLOY_ENV;
  return 'development';
}

/**
 * True when every connection must be verified (target rules before connecting, the hosts the cluster
 * reports after connecting): tests, staging, production, and development once production fingerprints
 * are configured. Only plain local development without fingerprints skips verification.
 */
export function verificationRequired(env: DeploymentConfig): boolean {
  return modeOf(env) !== 'development' || (env.PRODUCTION_DB_HOST_SHA256 ?? []).length > 0;
}

/**
 * Deployment identity must be explicit and consistent. Isolation fails closed: a production-mode
 * process has to say whether it is staging or production, and contradictory settings are refused
 * instead of being silently ignored.
 */
export function deploymentProblems(env: DeploymentConfig): Array<[string, string]> {
  const problems: Array<[string, string]> = [];
  const deployed = env.DEPLOY_ENV === 'staging' || env.DEPLOY_ENV === 'production';
  const production = env.PRODUCTION_DB_HOST_SHA256 ?? [];
  const staging = env.STAGING_DB_HOST_SHA256 ?? [];
  if (env.NODE_ENV === 'production' && !deployed) {
    problems.push(['DEPLOY_ENV', 'must be "staging" or "production" when NODE_ENV=production']);
  }
  if (deployed && env.NODE_ENV !== 'production') {
    problems.push(['NODE_ENV', `must be "production" when DEPLOY_ENV=${env.DEPLOY_ENV} (deployments run the production code paths)`]);
  }
  if ((env.DEPLOY_ENV === 'development' || env.DEPLOY_ENV === 'test') && env.NODE_ENV !== env.DEPLOY_ENV) {
    problems.push(['DEPLOY_ENV', 'contradicts NODE_ENV']);
  }
  if (env.STAGING_CONNECTIVITY_APPROVED && env.DEPLOY_ENV !== 'staging') {
    problems.push(['STAGING_CONNECTIVITY_APPROVED', 'may only be set when DEPLOY_ENV=staging']);
  }
  if (deployed && production.length === 0) {
    problems.push(['PRODUCTION_DB_HOST_SHA256', `is required when DEPLOY_ENV=${env.DEPLOY_ENV} (fingerprints of the production database hosts or cluster domain)`]);
  }
  if (env.DEPLOY_ENV === 'staging' && staging.length === 0) {
    problems.push(['STAGING_DB_HOST_SHA256', 'is required when DEPLOY_ENV=staging (exact fingerprints of the staging host names: the SRV name, or every seed and cluster member of a mongodb:// string; domain fingerprints are not accepted)']);
  }
  if (staging.length > 0 && env.DEPLOY_ENV !== 'staging') {
    problems.push(['STAGING_DB_HOST_SHA256', 'may only be set when DEPLOY_ENV=staging']);
  }
  if (env.DEMO_SEED_REMOTE_DATABASE !== undefined && (env.NODE_ENV !== 'development' || env.DEPLOY_ENV !== undefined)) {
    problems.push(['DEMO_SEED_REMOTE_DATABASE', 'may only be set for local development (NODE_ENV=development, DEPLOY_ENV unset)']);
  }
  if (staging.some((fingerprint) => production.includes(fingerprint))) {
    problems.push(['STAGING_DB_HOST_SHA256', 'shares a fingerprint with PRODUCTION_DB_HOST_SHA256']);
  }
  return problems;
}

/**
 * Whether this process may use a database host (null = allowed). Messages name settings only, never
 * host names.
 *
 * `reach` distinguishes the two cases:
 * - omitted: `host` is named in the connection string (a seed host, or the SRV name);
 * - given: `host` was reported by the cluster or reached by the driver (replica set members, SRV
 *   targets), and `reach` describes the connection string that led there (its canonical hosts and
 *   whether it is mongodb+srv).
 *
 * - test: loopback hosts only (the suites wipe collections).
 * - staging, fail closed:
 *   - never an IP address or a single-label (search-domain dependent) name;
 *   - never a host or parent domain matching PRODUCTION_DB_HOST_SHA256 (deny-list, broad matching);
 *   - a connection-string host must itself be in STAGING_DB_HOST_SHA256 (exact match, no parents);
 *   - a reported host must be exactly listed too; the only exception is mongodb+srv, where a host
 *     strictly beneath the member domain of the exactly verified SRV name is accepted (memberDomainOf:
 *     the driver's SRV parent-domain rule, with at least three labels). mongodb:// seeds never extend
 *     trust to a domain: the driver has no such rule for them, so every member must be listed.
 *   No fingerprint ever authorises a domain, so a broad entry cannot admit unrelated hosts.
 * - production: every host matches PRODUCTION_DB_HOST_SHA256 (this only narrows what production accepts).
 * - development: hosts matching PRODUCTION_DB_HOST_SHA256 (if configured) are refused.
 */
export function hostProblem(env: DeploymentConfig, host: string | null, reach?: { seeds: readonly string[]; srv: boolean }): string | null {
  if (host === null) return 'contains a host that cannot be read';
  const production = env.PRODUCTION_DB_HOST_SHA256 ?? [];
  switch (modeOf(env)) {
    case 'test':
      return isLoopbackHost(host) ? null : 'must only use local (loopback) hosts when NODE_ENV=test';
    case 'staging': {
      if (isIpLiteral(host)) return 'must use host names, not IP addresses, when DEPLOY_ENV=staging (IP addresses cannot be fingerprint-checked)';
      if (!host.includes('.')) return 'must use fully qualified host names when DEPLOY_ENV=staging';
      if (hostMatchesFingerprints(host, production)) return 'points at a production database host (matches PRODUCTION_DB_HOST_SHA256)';
      const allowed = env.STAGING_DB_HOST_SHA256 ?? [];
      if (hostHasExactFingerprint(host, allowed)) return null;
      if (reach === undefined) return 'uses a host that is not a declared staging host (STAGING_DB_HOST_SHA256 must contain its exact name)';
      if (!reach.srv) {
        return 'reports a host that is neither a declared staging host nor reached through a verified SRV name (every member of a mongodb:// cluster must be listed exactly in STAGING_DB_HOST_SHA256)';
      }
      const [srvHost] = reach.seeds;
      const domain = reach.seeds.length === 1 && srvHost !== undefined && hostProblem(env, srvHost) === null ? memberDomainOf(srvHost) : null;
      if (domain !== null && isStrictlyUnder(host, domain)) return null;
      return 'reports a host that is neither a declared staging host nor under the domain of the verified SRV name (STAGING_DB_HOST_SHA256)';
    }
    case 'production':
      return hostMatchesFingerprints(host, production) ? null : 'every host must match PRODUCTION_DB_HOST_SHA256 when DEPLOY_ENV=production';
    case 'development':
      return hostMatchesFingerprints(host, production)
        ? 'points at a production database host (matches PRODUCTION_DB_HOST_SHA256) outside DEPLOY_ENV=production'
        : null;
  }
}

/** TLS options that would let a different server pose as the intended host. */
const INSECURE_TLS_OPTIONS: Record<string, string> = {
  tlsinsecure: 'true',
  tlsallowinvalidhostnames: 'true',
  tlsallowinvalidcertificates: 'true',
  sslvalidate: 'false',
};

/**
 * Rules for the connection string a process is about to use. Checked when the configuration loads
 * and again at the connection boundary for the URI actually passed in (connectDatabase). Messages
 * name the setting only, never its value (connection strings contain credentials).
 */
export function databaseTargetProblems(env: DeploymentConfig, uri: string): Array<[string, string]> {
  const problems: Array<[string, string]> = [];
  const { hosts, database, options, unreadable } = mongoUriParts(uri);
  const mode = modeOf(env);

  if (unreadable && verificationRequired(env)) {
    problems.push(['MONGODB_URI', 'host list or database name cannot be read']);
    return problems;
  }
  for (const message of new Set(hosts.map((host) => hostProblem(env, host)).filter((m): m is string => m !== null))) {
    problems.push(['MONGODB_URI', message]);
  }

  if (mode === 'test' && !isTestDatabaseName(database)) {
    problems.push(['MONGODB_URI', 'database name must contain "test" or "e2e" as a separate word when NODE_ENV=test']);
  }
  if (mode === 'staging') {
    if (!isStagingDatabaseName(database)) {
      problems.push(['MONGODB_URI', 'database name must contain "staging" as a separate word (e.g. academy_staging) when DEPLOY_ENV=staging']);
    }
    if (Object.entries(INSECURE_TLS_OPTIONS).some(([key, value]) => options[key]?.toLowerCase() === value)) {
      problems.push(['MONGODB_URI', 'must not disable TLS certificate or host name validation when DEPLOY_ENV=staging']);
    }
  }
  if (mode === 'production' && isStagingDatabaseName(database)) {
    problems.push(['MONGODB_URI', 'is a staging database but DEPLOY_ENV=production']);
  }
  return problems;
}

function configError(problems: Array<[string, string]>): Error {
  const lines = problems.map(([path, message]) => `  - ${path}: ${message}`).join('\n');
  return new Error(`Invalid environment configuration:\n${lines}`);
}
