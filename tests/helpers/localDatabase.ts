import { isLoopbackHost, isTestDatabaseName, mongoUriParts } from '../../src/config/mongoUri.js';

/**
 * Returns `uri` only if it is a local throwaway test database: readable, every host loopback, and a
 * database named with a "test"/"e2e" segment (no name means the driver's default "test"). Every
 * direct connection in the test suites goes through this (a static test enforces it), so a test can
 * never wipe a remote or non-test database, even if MONGODB_URI is inherited from the environment.
 * Application connections are covered by connectDatabase's own NODE_ENV=test rules.
 */
export function localTestUri(uri: string | undefined = process.env.MONGODB_URI): string {
  const { hosts, database, unreadable } = mongoUriParts(uri ?? '');
  if (!uri || unreadable || !hosts.every(isLoopbackHost) || !isTestDatabaseName(database ?? 'test')) {
    throw new Error('Tests only connect to a local throwaway database (loopback host, database named *_test or *_e2e).');
  }
  return uri;
}
