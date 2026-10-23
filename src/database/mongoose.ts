import mongoose from 'mongoose';
import { env, isProduction } from '../config/env.js';
import { type DeploymentConfig, databaseTargetProblems, deploymentProblems, hostProblem, verificationRequired } from '../config/envSchema.js';
import { canonicalHost, mongoUriParts, redactConnectionStrings } from '../config/mongoUri.js';
import { logger } from '../utils/logger.js';
import { driverTarget } from './driverUri.js';
import { ensureSrvResolvable, PUBLIC_DNS_SERVERS } from './srvDns.js';

/**
 * MongoDB connection, shared by the whole process through Mongoose.
 *
 * Mongoose keeps one connection pool per process: call connectDatabase() once at
 * startup (server.ts) and import models anywhere afterwards.
 */

// Reject query filters on fields that are not in the schema instead of silently ignoring them.
mongoose.set('strictQuery', true);

// Once connected, Mongoose queues queries while the connection is briefly down. Give up after 3s
// instead of the default 10s, so requests during an outage get a prompt 503.
mongoose.set('bufferTimeoutMS', 3_000);

// API responses expose `id` (string) instead of Mongo's `_id`, and never the internal `__v`.
// Schemas can still hide extra fields (e.g. passwordHash) with `select: false`.
mongoose.set('toJSON', {
  virtuals: true,
  versionKey: false,
  transform(_doc, ret: Record<string, unknown>) {
    delete ret._id;
    return ret;
  },
});

/**
 * Mongoose's automatic operations: creating collections and indexes for every model as soon as the
 * connection opens, and replaying queries queued before it opened. They stay off until the
 * connection's hosts are verified (connectDatabase), so nothing from the application reaches an
 * unverified server. A query issued before that fails immediately instead of being queued.
 */
const HELD = { autoCreate: false, autoIndex: false, bufferCommands: false } as const;

function holdAutomaticOperations(): void {
  Object.assign(mongoose.connection.config, HELD);
}
holdAutomaticOperations();

/** After verification: what Mongoose would have done on open, now explicitly and awaited. */
async function releaseAutomaticOperations(): Promise<void> {
  // Building indexes automatically is convenient in development but can lock large
  // collections in production; there they are built by an explicit sync step (db:indexes).
  Object.assign(mongoose.connection.config, { autoCreate: true, autoIndex: !isProduction, bufferCommands: true });
  await Promise.all(
    Object.values(mongoose.connection.models).map(async (model) => {
      if (model.schema.options.autoCreate !== false) await model.createCollection();
      if (!isProduction && model.schema.options.autoIndex !== false) await model.createIndexes();
    }),
  );
}

// Set while we close the connection on purpose, so shutdown is not logged as an outage.
let closing = false;

mongoose.connection.on('disconnected', () => {
  if (!closing) logger.warn('MongoDB disconnected');
});
mongoose.connection.on('reconnected', () => logger.info('MongoDB reconnected'));

/**
 * Staging stays offline until the owner approves it: with DEPLOY_ENV=staging nothing (server,
 * index sync, seed) may open a database connection unless STAGING_CONNECTIVITY_APPROVED=true.
 */
export function assertConnectivityAllowed(config: Pick<typeof env, 'DEPLOY_ENV' | 'STAGING_CONNECTIVITY_APPROVED'> = env): void {
  if (config.DEPLOY_ENV === 'staging' && !config.STAGING_CONNECTIVITY_APPROVED) {
    throw new Error(
      'Database connectivity is blocked for DEPLOY_ENV=staging. Set STAGING_CONNECTIVITY_APPROVED=true only after the owner has approved staging connectivity (docs/STAGING.md).',
    );
  }
}

const sameHosts = (a: Array<string | null>, b: string[]) =>
  a.length === b.length && [...a].sort().every((host, i) => host === [...b].sort()[i]);

/**
 * Re-checks the deployment identity and the URI actually being connected to (which may differ from
 * env.MONGODB_URI), with the same rules as the configuration. When verification is required the
 * driver's own reading of the URI must name exactly the hosts and database that were checked.
 * Names settings only, never values.
 */
export function assertDatabaseTarget(uri: string, config: DeploymentConfig = env): void {
  const problems = [...deploymentProblems(config), ...databaseTargetProblems(config, uri)];
  if (problems.length === 0 && verificationRequired(config)) {
    try {
      const driver = driverTarget(uri);
      const ours = mongoUriParts(uri);
      if (!sameHosts(driver.hosts, ours.hosts) || driver.database !== (ours.database ?? 'test')) {
        problems.push(['MONGODB_URI', 'is read differently by the MongoDB driver than by the isolation checks']);
      }
    } catch (error) {
      problems.push(['MONGODB_URI', (error as Error).message]);
    }
  }
  if (problems.length > 0) {
    throw new Error(`Refusing to connect to MongoDB:\n${problems.map(([path, message]) => `  - ${path}: ${message}`).join('\n')}`);
  }
}

/**
 * Checks every host the connected cluster reports about itself (hello) and every server the driver
 * reached (which, for mongodb+srv, are the SRV targets) against the host rules, as hosts reached
 * through the seeds of `uri` (see hostProblem). Host names in the URI are checked before connecting,
 * but SRV records, DNS aliases or a port-forward can still lead elsewhere. Does nothing in plain local
 * development without fingerprints.
 */
export async function assertConnectedHostsAllowed(connection: mongoose.Connection, config: DeploymentConfig, uri: string): Promise<void> {
  if (!verificationRequired(config)) return;
  const seeds = mongoUriParts(uri);
  if (seeds.unreadable) throw new Error('Refusing to use MongoDB: the connection string cannot be read.');
  const db = connection.db;
  if (!db) throw new Error('MongoDB is not connected');

  const hello = (await db.admin().command({ hello: 1 })) as Record<string, unknown>;
  const reported: unknown[] = [hello.me, hello.primary, ...[hello.hosts, hello.passives, hello.arbiters].flatMap((list) => (Array.isArray(list) ? list : []))];
  // The driver's view of the topology (not a public API, so read defensively; hello alone covers
  // replica sets).
  const servers = (connection.getClient() as unknown as { topology?: { description?: { servers?: Map<string, unknown> } } }).topology?.description?.servers;
  if (servers instanceof Map) reported.push(...servers.keys());

  const addresses = reported.filter((address): address is string => typeof address === 'string');
  const problems = new Set(
    addresses.map((address) => hostProblem(config, canonicalHost(address), { seeds: seeds.hosts, srv: seeds.srv })).filter((problem): problem is string => problem !== null),
  );
  if (addresses.length === 0) problems.add('reports no host that can be checked');
  if (problems.size > 0) {
    throw new Error(`Refusing to use MongoDB: the connected cluster ${[...problems].join('; ')}.`);
  }
}

/**
 * After verification, a server the driver adds later (replica set reconfiguration, SRV polling for
 * sharded clusters) is checked when the driver announces it (`serverOpening`); a forbidden one starts
 * closing the connection. Best effort, not a guarantee: the driver does not select a server before its
 * first monitoring check, but closing is asynchronous (the driver first ends cursors and sessions, which
 * can send commands), so an operation may still be dispatched while the close is in progress.
 */
/** The rule applied to each server the driver announces after verification (null = allowed). */
export function topologyChangeCheck(config: DeploymentConfig, uri: string): (address: string) => string | null {
  const { hosts: seeds, srv } = mongoUriParts(uri);
  return (address) => hostProblem(config, canonicalHost(address), { seeds, srv });
}

let watchedClient: unknown = null;
function watchTopology(config: DeploymentConfig, uri: string): void {
  const client = mongoose.connection.getClient();
  if (watchedClient === client) return;
  watchedClient = client;
  const check = topologyChangeCheck(config, uri);
  client.on('serverOpening', (event: { address: string }) => {
    const problem = check(event.address);
    if (problem === null) return;
    logger.fatal(`MongoDB added a server this deployment may not use (MONGODB_URI ${problem}); closing the database connection.`);
    void mongoose.connection.close(true).catch(() => undefined);
  });
}

/** Driver errors can carry the connection string (or parts of it) in nested causes; keep only a redacted message. */
function connectionError(error: unknown): Error {
  const original = error instanceof Error ? error : new Error(String(error));
  const safe = new Error(`Could not connect to MongoDB: ${redactConnectionStrings(original.message)}`);
  safe.name = original.name;
  return safe;
}

const isRefusal = (error: unknown): error is Error => error instanceof Error && /^Refusing to (connect to|use) MongoDB/.test(error.message);

/**
 * Verifies the target on a separate, short-lived connection that has no models, queues nothing and
 * sends only `hello`, so no application operation can reach a server before it is verified.
 */
async function verifyOnProbe(uri: string, config: DeploymentConfig): Promise<void> {
  const probe = mongoose.createConnection(uri, { ...HELD, maxPoolSize: 1, serverSelectionTimeoutMS: 5_000 });
  try {
    try {
      await probe.asPromise();
    } catch (error) {
      throw connectionError(error);
    }
    await assertConnectedHostsAllowed(probe, config, uri);
  } finally {
    await probe.close(true).catch(() => undefined);
  }
}

/**
 * The only place in the codebase that opens a MongoDB connection (a test enforces this). Every entry
 * point (API, index sync, seed, test helpers) goes through here and gets, in order:
 *   1. the staging connectivity gate and the target rules, for the URI actually used, cross-checked
 *      with the driver's own parse;
 *   2. host verification on a separate probe connection (when verification is required);
 *   3. the application connection, opened with Mongoose's automatic operations held back;
 *   4. the same verification on that connection (DNS may have changed since step 2);
 *   5. only then automatic operations, collections and indexes, and a watch on later topology changes.
 * Any refusal closes the connection and nothing has been written.
 */
export async function connectDatabase(uri: string = env.MONGODB_URI): Promise<void> {
  assertConnectivityAllowed();
  assertDatabaseTarget(uri);
  const development = env.NODE_ENV === 'development' && (env.DEPLOY_ENV === undefined || env.DEPLOY_ENV === 'development');
  if (await ensureSrvResolvable(uri, development)) {
    logger.warn(`The system DNS refused the SRV lookup for MONGODB_URI; using public DNS resolvers (${PUBLIC_DNS_SERVERS.join(', ')}) for this process (development only).`);
  }
  const verify = verificationRequired(env);
  holdAutomaticOperations();
  if (verify) await verifyOnProbe(uri, env);

  try {
    // Give up quickly at boot if the server is unreachable or the credentials are wrong.
    await mongoose.connect(uri, { ...HELD, serverSelectionTimeoutMS: 5_000 });
  } catch (error) {
    await disconnectDatabase().catch(() => undefined);
    throw connectionError(error);
  }
  try {
    if (verify) {
      await assertConnectedHostsAllowed(mongoose.connection, env, uri);
      watchTopology(env, uri);
    }
    await releaseAutomaticOperations();
  } catch (error) {
    await disconnectDatabase().catch(() => undefined);
    throw isRefusal(error) ? error : connectionError(error);
  }
}

/** The application connection opened by connectDatabase(), for checks that need it (e.g. the demo-seed guard). */
export function currentConnection(): mongoose.Connection {
  return mongoose.connection;
}

export async function disconnectDatabase(): Promise<void> {
  closing = true;
  try {
    await mongoose.disconnect();
  } finally {
    holdAutomaticOperations();
    closing = false;
  }
}

/**
 * Multi-document transactions only work on a replica set or a sharded cluster.
 * A plain standalone `mongod` would accept the connection and then fail on the first
 * transaction, so check once at startup and refuse to run with a clear message instead.
 */
export async function assertTransactionSupport(connection: mongoose.Connection = mongoose.connection): Promise<void> {
  const db = connection.db;
  if (!db) throw new Error('MongoDB is not connected');

  const hello = await db.admin().command({ hello: 1 });
  const isReplicaSet = typeof hello.setName === 'string';
  const isShardedCluster = hello.msg === 'isdbgrid';

  if (!isReplicaSet && !isShardedCluster) {
    throw new Error(
      'MongoDB is running as a standalone server, which does not support transactions. ' +
        'Run it as a replica set (see README: "Requirements") or use MongoDB Atlas.',
    );
  }
}

/** Oldest MongoDB the API supports: reports use `$dateTrunc`, added in MongoDB 5.0. */
export const MIN_MONGODB_VERSION = [5, 0] as const;

/** True when `version` ("7.0.12", "5.0.0-rc1") is at least MIN_MONGODB_VERSION. */
export function isSupportedMongoVersion(version: string): boolean {
  const [major = 0, minor = 0] = version.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const [minMajor, minMinor] = MIN_MONGODB_VERSION;
  return major > minMajor || (major === minMajor && minor >= minMinor);
}

/**
 * Refuses to start on a server too old for the aggregation operators the reports use, instead
 * of failing later on the first report request.
 */
export async function assertServerVersion(connection: mongoose.Connection = mongoose.connection): Promise<void> {
  const db = connection.db;
  if (!db) throw new Error('MongoDB is not connected');
  const { version } = (await db.admin().command({ buildInfo: 1 })) as { version: string };
  if (!isSupportedMongoVersion(version)) {
    throw new Error(`MongoDB ${version} is not supported; version ${MIN_MONGODB_VERSION.join('.')} or later is required.`);
  }
}

/**
 * Explicit transaction guarantees, independent of cluster defaults:
 * - `snapshot` reads: every read in the transaction sees one majority-committed point in time.
 * - `majority` writes: a committed transaction (including its contact-lock writes) survives a
 *   primary failover; with w:1 it could be rolled back and a duplicate could slip through later.
 */
export const TRANSACTION_OPTIONS = {
  readConcern: { level: 'snapshot' },
  writeConcern: { w: 'majority' },
} as const;

/**
 * Runs `work` inside a transaction. Every query inside must pass `{ session }`.
 * The driver retries the whole callback on transient errors (e.g. write conflicts), so keep side
 * effects that cannot be repeated (such as sending email) outside of it.
 */
export async function runInTransaction<T>(work: (session: mongoose.ClientSession) => Promise<T>): Promise<T> {
  return mongoose.connection.transaction(work, TRANSACTION_OPTIONS);
}

/** Sends a `ping` command to prove the database answers. Used at startup and by the readiness check. */
export async function pingDatabase(): Promise<void> {
  const db = mongoose.connection.db;
  if (mongoose.connection.readyState !== mongoose.ConnectionStates.connected || !db) {
    throw new Error('MongoDB is not connected');
  }
  await db.admin().ping();
}
