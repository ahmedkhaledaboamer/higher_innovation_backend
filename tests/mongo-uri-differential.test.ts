import { describe, expect, it } from 'vitest';
import type { DeploymentConfig } from '../src/config/envSchema.js';
import { hostFingerprint, mongoUriParts } from '../src/config/mongoUri.js';
import { driverTarget } from '../src/database/driverUri.js';
import { assertDatabaseTarget } from '../src/database/mongoose.js';

/**
 * Differential test: config/mongoUri.ts against the installed MongoDB driver's own connection-string
 * parser (MongoClient constructor: no sockets, no DNS). Property:
 *   - when both read a URI, they name exactly the same hosts and database;
 *   - when only the driver reads it, the connection boundary refuses it (fail closed);
 *   - when the driver rejects it, the connection could never be opened anyway.
 * Fake hosts and credentials only.
 */
type Outcome = 'agree' | 'driver-only' | 'driver-rejects';

const enforced: DeploymentConfig = {
  NODE_ENV: 'development',
  DEPLOY_ENV: undefined,
  PRODUCTION_DB_HOST_SHA256: [hostFingerprint('prod.example.org')],
  STAGING_DB_HOST_SHA256: undefined,
  STAGING_CONNECTIVITY_APPROVED: false,
};

function compare(uri: string): Outcome {
  let driver: ReturnType<typeof driverTarget>;
  try {
    driver = driverTarget(uri);
  } catch {
    return 'driver-rejects';
  }
  const ours = mongoUriParts(uri);
  if (ours.unreadable || driver.hosts.includes(null)) {
    // Fail closed: wherever verification applies, the boundary refuses what it cannot read.
    expect(() => assertDatabaseTarget(uri, enforced), uri).toThrow(/^Refusing to connect/);
    return 'driver-only';
  }
  expect([...ours.hosts].sort(), `hosts: ${uri}`).toEqual([...(driver.hosts as string[])].sort());
  expect(ours.database ?? 'test', `database: ${uri}`).toBe(driver.database);
  return 'agree';
}

describe('mongoUriParts agrees with the MongoDB driver', () => {
  it('on a corpus of standard, SRV, multi-host, encoded and malformed URIs', () => {
    const corpus: Record<string, Outcome> = {
      'mongodb://h.example.net/db': 'agree',
      'mongodb://H.Example.NET.:27017/db': 'agree',
      'mongodb://h%2Eexample.net:27017/db': 'agree',
      'mongodb://u:p%40s@h.example.net/db': 'agree',
      'mongodb://u@h.example.net/db': 'agree',
      'mongodb://h.example.net:27017,i.example.net:27018,j.example.net/db?replicaSet=rs': 'agree',
      'mongodb://[::1]:27017/db': 'agree',
      'mongodb://[0:0:0:0:0:0:0:1]:27017/db': 'agree',
      'mongodb://[::1],127.0.0.1:27018/db': 'agree',
      'mongodb://h.example.net/db%2Fx': 'agree',
      'mongodb://h.example.net/a.b': 'agree',
      'mongodb://h.example.net?replicaSet=rs': 'agree',
      'mongodb://h.example.net/': 'agree',
      'mongodb://h.example.net': 'agree',
      'mongodb://h.example.net:/db': 'agree',
      'mongodb://h.example.net/db?authSource=admin&directConnection=true': 'agree',
      'mongodb://h.example.net/db?proxyHost=proxy.example.net&proxyPort=1080': 'agree',
      'mongodb://h.example.net\\@prod.example.org/db': 'agree',
      'mongodb://h_x.example.net/db': 'agree',
      'mongodb://xn--mongo-ixa.example.net/db': 'agree',
      'mongodb+srv://cluster0.abcde.example.net/db': 'agree',
      'mongodb+srv://CLUSTER0.abcde.example.net./db': 'agree',
      'mongodb+srv://u:p@cluster0.abcde.example.net/db?retryWrites=true&w=majority': 'agree',
      'mongodb+srv://cluster0.abcde.example.net/db?srvServiceName=custom': 'agree',
      'mongodb+srv://example.net/db': 'agree',
      // Numeric IPv4 spellings reach the resolver as written; both sides are compared canonicalised.
      'mongodb://127.1:27017/db': 'agree',
      'mongodb://0x7f.0.0.1:27017/db': 'agree',
      'mongodb://2130706433:27017/db': 'agree',
      // Accepted by the driver, refused by us (fail closed).
      'mongodb://mongö.example.net/db': 'driver-only',
      'mongodb://ｍongo.example.net/db': 'driver-only',
      'mongodb://a..b.example.net/db': 'driver-only',
      'mongodb://%2Ftmp%2Fmongodb-27017.sock/db': 'driver-only',
      'mongodb://h.example.net,/db': 'driver-only',
      'mongodb://h.example.net#frag/db': 'driver-only',
      // Rejected by the driver.
      'mongodb://h.example.net:99999/db': 'driver-rejects',
      'mongodb://u:p@@h.example.net/db': 'driver-rejects',
      'mongodb://u:p@x@h.example.net/db': 'driver-rejects',
      'mongodb://:p@h.example.net/db': 'driver-rejects',
      'mongodb://h.example.net/db?appName=a@x.example.net': 'driver-rejects',
      'mongodb://h.example.net/%E0%A4%A': 'driver-rejects',
      'mongodb+srv://cluster0.abcde.example.net:27017/db': 'driver-rejects',
      'mongodb+srv://a.example.net,b.example.net/db': 'driver-rejects',
      'MONGODB://h.example.net/db': 'driver-rejects',
      'mongodb:/h.example.net/db': 'driver-rejects',
    };
    expect(Object.fromEntries(Object.keys(corpus).map((uri) => [uri, compare(uri)]))).toEqual(corpus);
  });

  it('numeric IPv4 spellings are checked as the address the resolver will use', () => {
    for (const spelling of ['127.1', '0x7f.0.0.1', '2130706433']) {
      expect(mongoUriParts(`mongodb://${spelling}:27017/db`).hosts).toEqual(['127.0.0.1']);
    }
  });

  it('on 5,000 generated URIs built from the characters that matter', () => {
    // Deterministic PRNG so failures are reproducible.
    let seed = 20261020;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
    const pieces = ['h.example.net', 'prod.example.org', 'H.EXAMPLE.NET.', '127.0.0.1', '[::1]', 'a', '@', ':', '27017', '/', '?', '#', '%40', '%2E', '%2F', '%', ',', '\\', '[', ']', '=', '&', 'db', 'x', '.', '..', '-', '_'];
    const counts: Record<Outcome, number> = { agree: 0, 'driver-only': 0, 'driver-rejects': 0 };
    for (let i = 0; i < 5000; i += 1) {
      const scheme = random() < 0.8 ? 'mongodb://' : 'mongodb+srv://';
      const credentials = random() < 0.4 ? `${pick(['u', 'u:p', 'u:p%40', ':p', 'u:p@x'])}@` : '';
      const hosts = Array.from({ length: 1 + Math.floor(random() * 3) }, () => {
        const host = Array.from({ length: 1 + Math.floor(random() * 3) }, () => pick(pieces)).join('');
        return random() < 0.5 ? `${host}:${pick(['27017', '1', '', '99999'])}` : host;
      }).join(',');
      const tail = random() < 0.7 ? `/${Array.from({ length: Math.floor(random() * 3) }, () => pick(pieces)).join('')}` : '';
      const query = random() < 0.4 ? `?${pick(['replicaSet=rs', 'appName=a', 'tls=true', 'authSource=admin'])}${random() < 0.3 ? `&${pick(pieces)}` : ''}` : '';
      counts[compare(`${scheme}${credentials}${hosts}${tail}${query}`)] += 1;
    }
    // Every class is exercised, and no URI read by both parsers differed (asserted inside compare).
    expect(counts.agree).toBeGreaterThan(200);
    expect(counts['driver-only']).toBeGreaterThan(50);
    expect(counts['driver-rejects']).toBeGreaterThan(200);
  });
});
