import mongoose from 'mongoose';
import { canonicalHost } from '../config/mongoUri.js';

export interface DriverTarget {
  /** Canonical seed hosts (the SRV name for mongodb+srv); null for anything canonicalHost refuses. */
  hosts: Array<string | null>;
  /** Database the driver will use ("test" when the URI names none). */
  database: string;
}

/**
 * How the MongoDB driver itself reads `uri`: its own parser (the MongoClient constructor), which opens
 * no sockets and does no DNS lookups. The client is never connected. The connection boundary compares
 * this with config/mongoUri.ts so the hosts that were checked are exactly the hosts the driver will use.
 *
 * Driver parse errors can quote parts of the connection string (including credentials), so only the
 * error class is reported.
 */
export function driverTarget(uri: string): DriverTarget {
  let options: { hosts?: Array<{ host?: string; socketPath?: string }>; srvHost?: string; dbName: string };
  try {
    ({ options } = new mongoose.mongo.MongoClient(uri) as unknown as { options: typeof options });
  } catch (error) {
    throw new Error(`The MongoDB driver rejects the connection string (${error instanceof Error ? error.name : 'error'}).`);
  }
  const hosts = options.srvHost
    ? [canonicalHost(options.srvHost)]
    : (options.hosts ?? []).map((address) => (address.socketPath || !address.host ? null : canonicalHost(address.host)));
  return { hosts, database: options.dbName };
}
