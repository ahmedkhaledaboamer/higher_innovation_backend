import mongoose from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';
import { connectDatabase, disconnectDatabase } from '../../src/database/mongoose.js';
import { seedRoles } from '../../src/database/setup.js';

/**
 * Call at the top of a test file that needs the database:
 * connects before the file runs, empties every collection after each test,
 * and disconnects at the end. With `roles: true` the seven system roles are
 * re-created before each test, as the seed command would.
 */
export function useTestDatabase(options: { roles?: boolean } = {}): void {
  beforeAll(async () => {
    await connectDatabase();
    // Wait until every model's indexes (unique, TTL) exist, so tests exercise them for real.
    await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
  });

  if (options.roles) {
    beforeEach(async () => {
      await seedRoles();
    });
  }

  afterEach(async () => {
    const collections = await mongoose.connection.db?.collections();
    await Promise.all((collections ?? []).map((collection) => collection.deleteMany({})));
  });

  afterAll(async () => {
    await disconnectDatabase();
  });
}
