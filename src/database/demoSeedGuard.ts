import type mongoose from 'mongoose';
import type { DeploymentConfig } from '../config/envSchema.js';
import { canonicalHost, isLoopbackHost, mongoUriParts } from '../config/mongoUri.js';

/**
 * Safety rules for the demo-data seed (`npm run seed:demo`). By default demo data may only be written
 * to a local development or test database. Anything uncertain is refused before a connection is
 * opened, and the connected server is checked again before the first write. Messages name settings
 * only, never values (a connection string can contain credentials).
 *
 * Remote opt-in (development only): DEMO_SEED_REMOTE_DATABASE set to the exact database name in
 * MONGODB_URI allows a non-local host (e.g. Atlas). The name then replaces the "local host and dev
 * name" rules as a typed confirmation; system databases, production-looking names and disabled TLS
 * validation are still refused, and before writing the database must hold nothing but this CRM's
 * collections and demo records (assertDedicatedDemoDatabase in demoSeed.ts).
 */

export type DemoSeedConfig = Pick<
  DeploymentConfig,
  'NODE_ENV' | 'DEPLOY_ENV' | 'STAGING_CONNECTIVITY_APPROVED' | 'PRODUCTION_DB_HOST_SHA256' | 'DEMO_SEED_REMOTE_DATABASE'
>;

const SYSTEM_DATABASES = new Set(['admin', 'local', 'config']);
const INSECURE_TLS_OPTIONS: Record<string, string> = {
  tlsinsecure: 'true',
  tlsallowinvalidhostnames: 'true',
  tlsallowinvalidcertificates: 'true',
  sslvalidate: 'false',
};

/** True when the remote opt-in is configured (the script then checks the database contents instead of locality). */
export const isRemoteDemoSeed = (config: DemoSeedConfig): boolean => config.DEMO_SEED_REMOTE_DATABASE !== undefined;

/** A database name made for local work: a "dev", "development", "local", "demo", "test" or "e2e" segment. */
const LOCAL_DATABASE_NAME = /(^|[_.-])(dev|development|local|demo|test|e2e)($|[_.-])/i;
/** Names that suggest shared or real data, refused even when they also look local. */
const SHARED_DATABASE_NAME = /(^|[_.-])(prod|production|live|staging|stage|main|master|backup)($|[_.-])/i;

export function demoSeedTargetProblems(config: DemoSeedConfig, uri: string): string[] {
  const problems: string[] = [];
  const remote = config.DEMO_SEED_REMOTE_DATABASE;
  if (remote !== undefined && config.NODE_ENV !== 'development') {
    problems.push('DEMO_SEED_REMOTE_DATABASE may only be used with NODE_ENV=development');
  } else if (config.NODE_ENV !== 'development' && config.NODE_ENV !== 'test') {
    problems.push('NODE_ENV must be "development" or "test" (demo data is never seeded in production mode)');
  }
  if (config.DEPLOY_ENV !== undefined && config.DEPLOY_ENV !== 'development' && config.DEPLOY_ENV !== 'test') {
    problems.push('DEPLOY_ENV must be unset, "development" or "test" (demo data is never seeded into staging or production)');
  }
  if (config.STAGING_CONNECTIVITY_APPROVED) {
    problems.push('STAGING_CONNECTIVITY_APPROVED must not be set for a demo seed');
  }
  if ((config.PRODUCTION_DB_HOST_SHA256 ?? []).length > 0) {
    problems.push('PRODUCTION_DB_HOST_SHA256 is set, so this environment is not a plain local one; unset it for a demo seed');
  }

  const { hosts, database, options, unreadable, srv } = mongoUriParts(uri);
  if (unreadable) {
    problems.push('MONGODB_URI cannot be read');
    return problems;
  }
  if (!database) {
    problems.push('MONGODB_URI must name the database explicitly (e.g. /academy_crm_dev)');
    return problems;
  }
  if (SHARED_DATABASE_NAME.test(database)) {
    problems.push('the database name looks like a shared or production database (prod, live, staging, main, backup)');
  }

  if (remote === undefined) {
    if (srv) problems.push('MONGODB_URI must not be mongodb+srv:// (SRV records point at hosted clusters, not a local database)');
    if (!hosts.every(isLoopbackHost)) problems.push('MONGODB_URI must only use local hosts (localhost, 127.0.0.1 or ::1)');
    if (!LOCAL_DATABASE_NAME.test(database)) {
      problems.push('the database name must contain "dev", "development", "local", "demo", "test" or "e2e" as a separate word (e.g. academy_crm_dev)');
    }
    return problems;
  }

  if (database !== remote) {
    problems.push('DEMO_SEED_REMOTE_DATABASE must equal the database name in MONGODB_URI exactly (it is the confirmation of the target)');
  }
  if (SYSTEM_DATABASES.has(database.toLowerCase())) {
    problems.push('demo data cannot be written to the admin, local or config database');
  }
  if (Object.entries(INSECURE_TLS_OPTIONS).some(([key, value]) => options[key]?.toLowerCase() === value)) {
    problems.push('MONGODB_URI must not disable TLS certificate or host name validation');
  }
  return problems;
}

/**
 * After connecting, before any write: the server itself must report only local members, and the
 * connection must use the database that was checked. Catches a local port that forwards to a remote
 * cluster, which a connection-string check cannot see.
 */
export async function assertLocalDemoConnection(connection: mongoose.Connection, uri: string): Promise<void> {
  const db = connection.db;
  if (!db) throw new Error('Refusing to seed demo data: MongoDB is not connected.');
  const expected = mongoUriParts(uri).database;
  if (!expected || db.databaseName !== expected) {
    throw new Error('Refusing to seed demo data: the connection does not use the checked database.');
  }
  const hello = (await db.admin().command({ hello: 1 })) as Record<string, unknown>;
  const reported: unknown[] = [hello.me, hello.primary, ...[hello.hosts, hello.passives, hello.arbiters].flatMap((list) => (Array.isArray(list) ? list : []))];
  const servers = (connection.getClient() as unknown as { topology?: { description?: { servers?: Map<string, unknown> } } }).topology?.description?.servers;
  if (servers instanceof Map) reported.push(...servers.keys());
  const addresses = reported.filter((address): address is string => typeof address === 'string');
  if (addresses.length === 0 || !addresses.every((address) => {
    const host = canonicalHost(address);
    return host !== null && isLoopbackHost(host);
  })) {
    throw new Error('Refusing to seed demo data: the connected MongoDB reports non-local members (for example a port forwarded to a remote cluster).');
  }
}
