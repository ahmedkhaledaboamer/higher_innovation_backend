import mongoose from 'mongoose';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { hostFingerprint } from '../src/config/mongoUri.js';
import { localTestUri } from './helpers/localDatabase.js';

/**
 * Nothing may reach a database before its hosts are verified. Uses only the local in-memory replica
 * set: its members report themselves as 127.0.0.1:<port>, so declaring 127.0.0.1 a "production" host
 * while connecting through the name "localhost" reproduces a safe-looking name that leads to forbidden
 * servers (as an SRV record or DNS alias could).
 */
const DATABASE = 'academy_crm_test_gate';
const localUri = process.env.MONGODB_URI!.replace('127.0.0.1', 'localhost').replace('/academy_crm_test', `/${DATABASE}`);

async function collectionsIn(database: string): Promise<string[]> {
  const inspector = await mongoose.createConnection(localTestUri()).asPromise();
  try {
    const collections = await inspector.useDb(database).db!.listCollections().toArray();
    return collections.map((collection) => collection.name).sort();
  } finally {
    await inspector.close();
  }
}

afterAll(async () => {
  await mongoose.disconnect();
  const cleanup = await mongoose.createConnection(localTestUri()).asPromise();
  await cleanup.useDb(DATABASE).dropDatabase();
  await cleanup.close();
});

describe('connection gate', () => {
  it('a refused target receives no collection, index or document from the application', async () => {
    vi.resetModules();
    vi.doMock('../src/config/env.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../src/config/env.js')>();
      return {
        ...actual,
        env: { ...actual.env, NODE_ENV: 'development', DEPLOY_ENV: undefined, PRODUCTION_DB_HOST_SHA256: [hostFingerprint('127.0.0.1')] },
      };
    });
    try {
      // Load every model, as the API and the scripts do before connecting.
      await import('../src/app.js');
      const { connectDatabase } = await import('../src/database/mongoose.js');
      expect(mongoose.modelNames().length).toBeGreaterThan(5);

      // An application write issued before the connection is verified (e.g. a request racing startup).
      const early = mongoose
        .model('Role')
        .create({ key: 'VIEWER', name: 'Gate test' })
        .then(() => 'written', () => 'rejected');

      await expect(connectDatabase(localUri)).rejects.toThrow(/production database host/);
      await expect(early).resolves.toBe('rejected');
      expect(mongoose.connection.readyState).toBe(mongoose.ConnectionStates.disconnected);
      expect(await collectionsIn(DATABASE)).toEqual([]);
    } finally {
      vi.doUnmock('../src/config/env.js');
      vi.resetModules();
    }
  });
});
