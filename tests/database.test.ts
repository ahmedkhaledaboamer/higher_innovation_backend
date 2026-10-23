import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { describe, expect, it, vi } from 'vitest';
import { localTestUri } from './helpers/localDatabase.js';
import {
  assertServerVersion,
  assertTransactionSupport,
  isSupportedMongoVersion,
  runInTransaction,
  TRANSACTION_OPTIONS,
} from '../src/database/mongoose.js';

describe('assertTransactionSupport', () => {
  it('accepts a replica set (the test database)', async () => {
    const connection = await mongoose.createConnection(localTestUri()).asPromise();
    try {
      await expect(assertTransactionSupport(connection)).resolves.toBeUndefined();
    } finally {
      await connection.close();
    }
  });

  it('refuses a standalone mongod, which cannot run transactions', async () => {
    const standalone = await MongoMemoryServer.create();
    const connection = await mongoose.createConnection(localTestUri(standalone.getUri())).asPromise();
    try {
      await expect(assertTransactionSupport(connection)).rejects.toThrow(/standalone server/);
    } finally {
      await connection.close();
      await standalone.stop();
    }
  });
});

describe('MongoDB version check', () => {
  it('requires 5.0 or later ($dateTrunc in reports)', () => {
    expect(isSupportedMongoVersion('5.0.0')).toBe(true);
    expect(isSupportedMongoVersion('7.0.12')).toBe(true);
    expect(isSupportedMongoVersion('8.0.4')).toBe(true);
    expect(isSupportedMongoVersion('4.4.29')).toBe(false);
    expect(isSupportedMongoVersion('4.2.0')).toBe(false);
  });

  it('accepts the test server', async () => {
    const connection = await mongoose.createConnection(localTestUri()).asPromise();
    try {
      await expect(assertServerVersion(connection)).resolves.toBeUndefined();
    } finally {
      await connection.close();
    }
  });
});

describe('runInTransaction', () => {
  it('always uses snapshot reads and majority writes', async () => {
    const spy = vi.spyOn(mongoose.connection, 'transaction').mockResolvedValue('done' as never);
    try {
      await runInTransaction(async () => 'done');
      expect(spy).toHaveBeenCalledWith(expect.any(Function), TRANSACTION_OPTIONS);
      expect(TRANSACTION_OPTIONS).toEqual({ readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
    } finally {
      spy.mockRestore();
    }
  });
});
