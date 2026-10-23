import { type Env, parseEnv } from './envSchema.js';
import { driverTarget } from '../database/driverUri.js';
import { hostHasExactFingerprint, hostMatchesFingerprints, isIpLiteral, isLoopbackHost, isStagingDatabaseName, mongoUriParts } from './mongoUri.js';

/**
 * Offline staging preflight: proves from configuration alone that a staging deployment cannot
 * target production. It never connects anywhere and never returns setting values, only check names
 * and outcomes. Checks that need the live environment are listed as MANUAL.
 */

export type PreflightStatus = 'PASS' | 'FAIL' | 'MANUAL';

export interface PreflightCheck {
  id: string;
  status: PreflightStatus;
  detail: string;
}

export function runStagingPreflight(source: Record<string, string | undefined>): PreflightCheck[] {
  const checks: PreflightCheck[] = [];
  const check = (id: string, ok: boolean, pass: string, fail: string) =>
    checks.push({ id, status: ok ? 'PASS' : 'FAIL', detail: ok ? pass : fail });

  // 1. The whole configuration must parse, including the staging isolation rules in envSchema.
  let env: Env | null = null;
  try {
    env = parseEnv(source as NodeJS.ProcessEnv);
    check('config.valid', true, 'configuration parses, including the staging isolation rules', '');
  } catch (error) {
    // The message names settings only (never values).
    checks.push({ id: 'config.valid', status: 'FAIL', detail: (error as Error).message.replace(/\n\s*/g, ' ') });
  }

  const raw = (key: string) => source[key];
  check('deploy.identity', raw('DEPLOY_ENV') === 'staging', 'DEPLOY_ENV=staging', 'DEPLOY_ENV must be "staging"');
  check('deploy.mode', raw('NODE_ENV') === 'production', 'NODE_ENV=production', 'NODE_ENV must be "production"');
  check(
    'connectivity.blocked',
    raw('STAGING_CONNECTIVITY_APPROVED') !== 'true',
    'database connectivity is still blocked (STAGING_CONNECTIVITY_APPROVED is not true)',
    'STAGING_CONNECTIVITY_APPROVED=true is set; remove it until the owner approves connectivity',
  );

  const uri = raw('MONGODB_URI') ?? '';
  const { hosts, database, options, unreadable } = mongoUriParts(uri);
  const denylist = env?.PRODUCTION_DB_HOST_SHA256 ?? [];
  const allowlist = env?.STAGING_DB_HOST_SHA256 ?? [];
  let driverAgrees = false;
  try {
    const driver = driverTarget(uri);
    driverAgrees = !unreadable && driver.hosts.length === hosts.length && driver.hosts.every((host) => host !== null && hosts.includes(host)) && driver.database === (database ?? 'test');
  } catch {
    driverAgrees = false;
  }
  check('db.single-uri', (uri.match(/mongodb(\+srv)?:\/\//g) ?? []).length === 1, 'exactly one connection string', 'MONGODB_URI must contain exactly one connection string');
  check('db.readable', !unreadable, 'host list and database name can be read', 'host list or database name cannot be read');
  check('db.driver-parse', driverAgrees, 'the MongoDB driver reads the same hosts and database', 'the MongoDB driver rejects the connection string or reads it differently');
  check('db.name', isStagingDatabaseName(database), 'database name contains "staging" as a separate word', 'database name must contain "staging" as a separate word (e.g. academy_staging)');
  check('db.denylist', denylist.length > 0, 'production host fingerprints are configured', 'PRODUCTION_DB_HOST_SHA256 is missing or invalid');
  check(
    'db.not-production',
    denylist.length > 0 && hosts.length > 0 && !hosts.some((host) => hostMatchesFingerprints(host, denylist)),
    'no database host (or parent domain) is a declared production host',
    'a database host or its domain matches a production fingerprint (or no fingerprints are configured)',
  );
  check('db.allowlist', allowlist.length > 0, 'staging host fingerprints are configured', 'STAGING_DB_HOST_SHA256 is missing or invalid');
  check(
    'db.staging-host',
    allowlist.length > 0 && hosts.length > 0 && hosts.every((host) => hostHasExactFingerprint(host, allowlist)),
    'every connection-string host is exactly declared in STAGING_DB_HOST_SHA256',
    'a connection-string host is not exactly declared in STAGING_DB_HOST_SHA256 (domains are not accepted)',
  );
  check('db.hostnames', hosts.length > 0 && !hosts.some(isIpLiteral), 'database hosts are names, not IP addresses', 'use host names; IP addresses cannot be checked against the production fingerprints');
  check(
    'db.tls-validation',
    !['tlsinsecure', 'tlsallowinvalidhostnames', 'tlsallowinvalidcertificates'].some((key) => options[key]?.toLowerCase() === 'true') && options.sslvalidate?.toLowerCase() !== 'false',
    'TLS certificate and host name validation are on',
    'remove tlsInsecure / tlsAllowInvalidHostnames / tlsAllowInvalidCertificates',
  );
  check('db.remote', hosts.length > 0 && hosts.every((host) => !isLoopbackHost(host) && host !== '0.0.0.0'), 'database host is not localhost', 'database host is local; staging should use its own managed replica set');
  check('db.tls', uri.startsWith('mongodb+srv://') || /[?&](tls|ssl)=true/i.test(uri), 'TLS is on (mongodb+srv or tls=true)', 'use mongodb+srv:// (Atlas) or tls=true');

  const frontend = raw('FRONTEND_URL') ?? '';
  const origins = (raw('CORS_ORIGINS') ?? '').split(',').map((o) => o.trim()).filter(Boolean);
  check('http.frontend-https', frontend.startsWith('https://'), 'FRONTEND_URL uses https', 'FRONTEND_URL must use https');
  check('http.cors-https', origins.length > 0 && origins.every((o) => o.startsWith('https://')), 'CORS_ORIGINS are all https', 'CORS_ORIGINS must be set and all https');
  check('cookie.secure', env?.COOKIE_SECURE === true, 'COOKIE_SECURE is true', 'COOKIE_SECURE must be true');
  check('proxy.trust', Number(raw('TRUST_PROXY') ?? 0) >= 1, 'TRUST_PROXY >= 1', 'TRUST_PROXY must be the number of proxies in front of the API (usually 1)');
  check('secret.jwt', (raw('JWT_ACCESS_SECRET') ?? '').length >= 32 && !/^(change|replace|your|<)/i.test(raw('JWT_ACCESS_SECRET') ?? ''), 'JWT secret is set (>= 32 characters, not a placeholder)', 'JWT_ACCESS_SECRET must be a new random value of 32+ characters');
  check('mail.smtp', raw('MAIL_TRANSPORT') === 'smtp' && Boolean(raw('SMTP_HOST')), 'SMTP transport with a host', 'MAIL_TRANSPORT=smtp and SMTP_HOST are required');
  check('docs.off', raw('API_DOCS_ENABLED') !== 'true', 'Swagger UI is off', 'API_DOCS_ENABLED=true exposes Swagger on staging; confirm this is intended');

  const manual = [
    ['manual.fingerprints', 'PRODUCTION_DB_HOST_SHA256 covers the production cluster domain (<id>.mongodb.net) and any production host outside it (private endpoints, aliases); STAGING_DB_HOST_SHA256 holds the exact staging SRV name, or for mongodb:// every seed and every replica set member; no domains'],
    ['manual.atlas-project', 'staging is a separate Atlas project: its database user cannot authenticate to production, and its cluster domain differs from production'],
    ['manual.smtp-sandbox', 'SMTP_HOST is a sandbox/capture service, not the production mail account'],
    ['manual.db-user', 'the staging database user has readWrite on the staging database only'],
    ['manual.network', 'Atlas network access lists only the staging API egress addresses'],
    ['manual.backup', 'staging snapshot taken and a restore rehearsed'],
    ['manual.secrets', 'every secret comes from the platform secret store, none copied from production'],
    ['manual.frontend', 'the staging frontend was built with VITE_API_URL pointing at the staging API'],
  ] as const;
  for (const [id, detail] of manual) checks.push({ id, status: 'MANUAL', detail });
  return checks;
}
