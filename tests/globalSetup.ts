import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { localTestUri } from './helpers/localDatabase.js';

/**
 * Starts one throwaway MongoDB for the whole test run, then stops it.
 *
 * It is a real `mongod` binary (downloaded once and cached by mongodb-memory-server),
 * started as a single-node replica set because MongoDB transactions only work on replica sets.
 * Also creates a fresh email outbox directory, so tests can read the emails the app sends.
 */
export default async function setup() {
  const replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const outboxDir = await mkdtemp(path.join(tmpdir(), 'academy-crm-outbox-'));

  // Set before test workers start, so src/config/env.ts sees them when tests import the app.
  process.env.MONGODB_URI = localTestUri(replSet.getUri('academy_crm_test'));
  process.env.MAIL_OUTBOX_DIR = outboxDir;

  return async () => {
    await replSet.stop();
    await rm(outboxDir, { recursive: true, force: true });
  };
}
