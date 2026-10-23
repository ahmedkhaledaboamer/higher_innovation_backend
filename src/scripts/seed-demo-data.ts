/**
 * Demo data for local development:  npm run seed:demo
 *
 * Adds 10 realistic records per business module (see src/database/demoSeed.ts). Re-running adds
 * only what is missing; existing records are never modified or deleted.
 *
 * Refuses to run unless the target is clearly a local development/test database:
 *   - NODE_ENV development or test, DEPLOY_ENV unset/development/test, no staging approval flag;
 *   - MONGODB_URI uses only localhost / 127.0.0.1 / ::1 (no mongodb+srv) and names a database with a
 *     "dev", "development", "local", "demo", "test" or "e2e" segment (e.g. academy_crm_dev);
 *   - after connecting, the server must report only local members (no port-forward to a remote cluster).
 * Requires the system roles: run `npm run db:seed` once first.
 *
 * Remote database (development only, explicit opt-in): set DEMO_SEED_REMOTE_DATABASE to the exact
 * database name in MONGODB_URI. Before the first write the database must contain only this CRM's
 * collections and demo records; a database of another project or with real data is refused.
 */
import { env } from '../config/env.js';
import { mongoUriParts } from '../config/mongoUri.js';
import { assertDedicatedDemoDatabase, DEMO_MODULES, seedDemoData } from '../database/demoSeed.js';
import { assertLocalDemoConnection, demoSeedTargetProblems, isRemoteDemoSeed } from '../database/demoSeedGuard.js';
import { assertTransactionSupport, connectDatabase, currentConnection, disconnectDatabase } from '../database/mongoose.js';
import { logger } from '../utils/logger.js';

const problems = demoSeedTargetProblems(env, env.MONGODB_URI);
if (problems.length > 0) {
  // Names settings only; the connection string is never printed.
  logger.error({ problems }, 'Refusing to seed demo data: the target is not clearly a local development/test database. Nothing was written.');
  process.exit(1);
}

try {
  await connectDatabase();
  await assertTransactionSupport();
  if (isRemoteDemoSeed(env)) {
    await assertDedicatedDemoDatabase(currentConnection(), env.DEMO_SEED_REMOTE_DATABASE!);
  } else {
    await assertLocalDemoConnection(currentConnection(), env.MONGODB_URI);
  }

  const report = await seedDemoData();
  for (const module of DEMO_MODULES) logger.info({ module, ...report[module] }, 'Demo data');
  logger.info({ database: mongoUriParts(env.MONGODB_URI).database }, 'Demo data seeding finished');
  await disconnectDatabase();
  process.exit(0);
} catch (error) {
  logger.error({ err: error }, 'Demo data seeding failed');
  await disconnectDatabase().catch(() => undefined);
  process.exit(1);
}
