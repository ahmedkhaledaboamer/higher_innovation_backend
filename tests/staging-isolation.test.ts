import dns from 'node:dns';
import { readdirSync, readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import mongoose from 'mongoose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type DeploymentConfig, hostProblem, parseEnv } from '../src/config/envSchema.js';
import {
  canonicalHost,
  hostFingerprint,
  hostMatchesFingerprints,
  isStagingDatabaseName,
  isStrictlyUnder,
  memberDomainOf,
  isTestDatabaseName,
  mongoUriParts,
  redactConnectionStrings,
} from '../src/config/mongoUri.js';
import { runStagingPreflight } from '../src/config/stagingPreflight.js';
import { driverTarget } from '../src/database/driverUri.js';
import {
  assertConnectedHostsAllowed,
  assertConnectivityAllowed,
  assertDatabaseTarget,
  connectDatabase,
  disconnectDatabase,
  topologyChangeCheck,
} from '../src/database/mongoose.js';
import { localTestUri } from './helpers/localDatabase.js';

/**
 * Staging isolation: a staging deployment can only use declared staging hosts, never a declared
 * production host (however spelled), stays offline until connectivity is approved, refuses
 * contradictory or incomplete settings, and the offline preflight proves it without printing values.
 * All hosts and credentials below are fake; the only database used is the local in-memory one.
 */
const PROD_DOMAIN = 'abcde.example.net';
const PROD_HOST = `prod-cluster.${PROD_DOMAIN}`;
const STAGING_DOMAIN = 'fghij.example.net';
const STAGING_HOST = `staging-cluster.${STAGING_DOMAIN}`;
const FAKE_PASSWORD = 'n0t-a-real-password';

const staging = {
  DEPLOY_ENV: 'staging',
  NODE_ENV: 'production',
  MONGODB_URI: `mongodb+srv://staging_app:${FAKE_PASSWORD}@${STAGING_HOST}/academy_staging?retryWrites=true&w=majority`,
  PRODUCTION_DB_HOST_SHA256: hostFingerprint(PROD_DOMAIN),
  STAGING_DB_HOST_SHA256: hostFingerprint(STAGING_HOST),
  JWT_ACCESS_SECRET: 'f'.repeat(48),
  CORS_ORIGINS: 'https://crm-staging.example.com',
  FRONTEND_URL: 'https://crm-staging.example.com',
  TRUST_PROXY: '1',
  MAIL_TRANSPORT: 'smtp',
  SMTP_HOST: 'sandbox.smtp.example.com',
};

const stagingConfig: DeploymentConfig = {
  NODE_ENV: 'production',
  DEPLOY_ENV: 'staging',
  PRODUCTION_DB_HOST_SHA256: [hostFingerprint(PROD_DOMAIN)],
  STAGING_DB_HOST_SHA256: [hostFingerprint(STAGING_HOST)],
  STAGING_CONNECTIVITY_APPROVED: true,
};
const testConfig: DeploymentConfig = { NODE_ENV: 'test', DEPLOY_ENV: undefined, PRODUCTION_DB_HOST_SHA256: undefined, STAGING_DB_HOST_SHA256: undefined, STAGING_CONNECTIVITY_APPROVED: false };

function errorMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as Error).message;
  }
  return '';
}

/** A connection stand-in whose cluster reports `hello` (no network). */
function fakeConnection(hello: Record<string, unknown>, servers: string[] = []): mongoose.Connection {
  return {
    db: { admin: () => ({ command: async () => hello }) },
    getClient: () => ({ topology: { description: { servers: new Map(servers.map((address) => [address, {}])) } } }),
  } as unknown as mongoose.Connection;
}

describe('mongoUriParts and canonical hosts', () => {
  it('extracts hosts, database and options without credentials', () => {
    expect(mongoUriParts(staging.MONGODB_URI)).toEqual({
      hosts: [STAGING_HOST],
      database: 'academy_staging',
      options: { retrywrites: 'true', w: 'majority' },
      unreadable: false,
      srv: true,
    });
    expect(mongoUriParts('mongodb://127.0.0.1:27017,127.0.0.1:27018/db?replicaSet=rs0').hosts).toEqual(['127.0.0.1', '127.0.0.1']);
    expect(mongoUriParts('mongodb+srv://u:p@Cluster.Example.NET')).toMatchObject({ hosts: ['cluster.example.net'], database: null });
    expect(JSON.stringify(mongoUriParts(staging.MONGODB_URI))).not.toContain(FAKE_PASSWORD);
  });

  it('normalises equivalent host spellings', () => {
    const spellings = [
      `mongodb+srv://u:p@${PROD_HOST}./academy_staging`, // trailing dot (fully-qualified DNS name)
      `mongodb+srv://u:p@${PROD_HOST.toUpperCase()}/academy_staging`,
      `mongodb://u:p@${PROD_HOST.replace('.', '%2E')}:27017/academy_staging`, // percent-encoded
      `mongodb://u:p%40ss@${PROD_HOST}:27017/academy_staging`, // encoded "@" in the password
      `mongodb://${PROD_HOST}:27017/academy_staging?appName=a@${STAGING_HOST}`, // "@" after the authority
      `mongodb://${STAGING_HOST}\\@${PROD_HOST}/academy_staging`, // backslash: the driver also reads the last "@"
    ];
    for (const uri of spellings) expect(mongoUriParts(uri).hosts, uri).toEqual([PROD_HOST]);
  });

  it('canonicalises IP addresses the way the system resolver reads them', () => {
    for (const spelling of ['127.0.0.1', '127.1', '0x7f.0.0.1', '2130706433', '127.0.0.1:27017', '127.0.0.1.']) expect(canonicalHost(spelling), spelling).toBe('127.0.0.1');
    for (const spelling of ['[::1]:27017', '[0:0:0:0:0:0:0:1]', '::1', '[::1]']) expect(canonicalHost(spelling), spelling).toBe('::1');
    expect(canonicalHost('167772165')).toBe('10.0.0.5');
  });

  it('refuses what it cannot read with certainty, so callers fail closed', () => {
    for (const host of ['mongö.example.net', 'ｍongo.example.net', 'a..b.example.net', '/tmp/mongodb-27017.sock', 'h.example.net#frag', '-bad.example.net', '[::1', 'h:x', '']) {
      expect(canonicalHost(host), host).toBeNull();
    }
    expect(mongoUriParts('mongodb://u:p@/db').unreadable).toBe(true);
    expect(mongoUriParts('mongodb://h.example.net,/db').unreadable).toBe(true);
    expect(mongoUriParts('mongodb://%2Ftmp%2Fmongodb-27017.sock/db').unreadable).toBe(true);
    expect(mongoUriParts('mongodb://u:p@%E0%A4%A/db').unreadable).toBe(true);
    expect(mongoUriParts('mongodb://h/%E0%A4%A').unreadable).toBe(true);
    expect(mongoUriParts('postgres://h/db').unreadable).toBe(true);
  });
});

describe('host fingerprint matching', () => {
  it('a cluster-domain fingerprint covers the SRV name, shard and private-endpoint hosts', () => {
    const fingerprints = [hostFingerprint(PROD_DOMAIN)];
    for (const host of [PROD_HOST, `prod-cluster-shard-00-00.${PROD_DOMAIN}`, `prod-cluster-pl-0.${PROD_DOMAIN}`, `ac-x1-shard-00-02.${PROD_DOMAIN}`, PROD_DOMAIN]) {
      expect(hostMatchesFingerprints(host, fingerprints), host).toBe(true);
    }
    expect(hostMatchesFingerprints(STAGING_HOST, fingerprints)).toBe(false);
  });

  it('matches whole labels only and canonical spellings', () => {
    const fingerprints = [hostFingerprint(PROD_DOMAIN)];
    expect(hostMatchesFingerprints(`prod-cluster.x${PROD_DOMAIN}`, fingerprints)).toBe(false);
    expect(hostMatchesFingerprints(`${PROD_DOMAIN}.evil.example.org`, fingerprints)).toBe(false);
    expect(hostFingerprint(`${PROD_DOMAIN}.`)).toBe(hostFingerprint(PROD_DOMAIN.toUpperCase()));
    expect(hostFingerprint('127.1')).toBe(hostFingerprint('127.0.0.1'));
    // IP addresses match exactly, never by "parent".
    expect(hostMatchesFingerprints('10.0.0.5', [hostFingerprint('0.0.5')])).toBe(false);
  });

  it('deny-list matching is broad on purpose: it can only block', () => {
    const broad = [hostFingerprint('example.net')];
    expect(hostMatchesFingerprints(PROD_HOST, broad)).toBe(true);
    expect(hostMatchesFingerprints(STAGING_HOST, broad)).toBe(true);
    expect(hostMatchesFingerprints('example.org', broad)).toBe(false);
  });

  it('recognises staging and test database names as separate words', () => {
    for (const name of ['academy_staging', 'staging', 'crm-staging-2', 'Academy.Staging']) expect(isStagingDatabaseName(name), name).toBe(true);
    for (const name of ['prod_notstaging', 'stagingdb', 'academy', null]) expect(isStagingDatabaseName(name), String(name)).toBe(false);
    for (const name of ['academy_crm_test', 'academy_crm_e2e', 'test']) expect(isTestDatabaseName(name), name).toBe(true);
    for (const name of ['academy_crm_dev', 'latest', 'academy', null]) expect(isTestDatabaseName(name), String(name)).toBe(false);
  });
});

describe('staging allow-list: exact connection-string hosts; only a verified SRV name extends to its domain', () => {
  const D = STAGING_DOMAIN; // fghij.example.net (the staging cluster's member domain)
  const viaSrv = { seeds: [STAGING_HOST], srv: true };
  const reported = (host: string, config: DeploymentConfig = stagingConfig, reach: { seeds: string[]; srv: boolean } = viaSrv) =>
    hostProblem(config, canonicalHost(host), reach);
  const shared = 'region1.shared-cloud.example'; // fictional shared hosting zone
  const seedA = `vm-staging-a.${shared}`;
  const seedB = `vm-staging-b.${shared}`;
  const otherTenant = `vm-other-tenant.${shared}`;
  const plainConfig: DeploymentConfig = { ...stagingConfig, STAGING_DB_HOST_SHA256: [hostFingerprint(seedA)] };
  const plainUri = `mongodb://u:p@${seedA}:27017/academy_staging?tls=true&replicaSet=rs`;

  it('derives a member domain only from names with at least four labels, on label boundaries', () => {
    expect(memberDomainOf(STAGING_HOST)).toBe(D);
    expect(memberDomainOf('cluster0.abcde.mongodb.net')).toBe('abcde.mongodb.net');
    expect(memberDomainOf('db.example.net')).toBeNull(); // would extend trust to all of example.net
    expect(memberDomainOf('example.net')).toBeNull();
    expect(memberDomainOf('10.0.0.5')).toBeNull();
    expect(isStrictlyUnder(`shard-00-00.${D}`, D)).toBe(true);
    expect(isStrictlyUnder(D, D)).toBe(false);
    expect(isStrictlyUnder(`shard.x${D}`, D)).toBe(false);
    expect(isStrictlyUnder(`${D}.evil.example.org`, D)).toBe(false);
    expect(mongoUriParts(staging.MONGODB_URI).srv).toBe(true);
    expect(mongoUriParts(plainUri).srv).toBe(false);
  });

  it('an exact base-host fingerprint works, in any letter case or with a trailing dot', () => {
    expect(() => parseEnv(staging)).not.toThrow();
    expect(() => parseEnv({ ...staging, MONGODB_URI: `mongodb+srv://u:p@${STAGING_HOST.toUpperCase()}./academy_staging` })).not.toThrow();
    expect(hostProblem(stagingConfig, STAGING_HOST)).toBeNull();
  });

  it('a broad staging fingerprint (domain or parent) authorises nothing', () => {
    for (const broad of [D, 'example.net', 'net']) {
      const config = { ...staging, STAGING_DB_HOST_SHA256: hostFingerprint(broad) };
      expect(() => parseEnv(config), broad).toThrow(/STAGING_DB_HOST_SHA256 must contain its exact name/);
      const deploy: DeploymentConfig = { ...stagingConfig, STAGING_DB_HOST_SHA256: [hostFingerprint(broad)] };
      expect(hostProblem(deploy, STAGING_HOST), broad).not.toBeNull();
      // Nor does it admit members: the SRV name itself is not verified.
      expect(reported(`shard-00-00.${D}`, deploy), broad).toMatch(/neither a declared staging host/);
    }
  });

  it('the missing-fingerprint error describes exact host names, not domains', () => {
    const message = errorMessage(() => parseEnv({ ...staging, STAGING_DB_HOST_SHA256: undefined }));
    expect(message).toMatch(/STAGING_DB_HOST_SHA256: is required when DEPLOY_ENV=staging \(exact fingerprints of the staging host names/);
    expect(message).toMatch(/domain fingerprints are not accepted/);
    expect(message).not.toMatch(/or cluster domain/);
  });

  describe('mongodb+srv: members under the verified SRV name', () => {
    it('accepts SRV targets and reported members under the SRV name\'s domain', () => {
      for (const host of [`shard-00-00.${D}:27017`, `ac-x1-shard-00-02.${D}`, `SHARD-00-01.${D.toUpperCase()}.:27017`, `cluster0-pl-0-lb.${D}`, `a.b.${D}`]) {
        expect(reported(host), host).toBeNull();
      }
    });

    it('rejects invalid SRV targets, fail closed', () => {
      for (const host of [`shard-00-00.unlisted.example.net`, `shard.x${D}`, D, 'example.net', `${D}.evil.example.org`, `shard-00-00.${PROD_DOMAIN}`]) {
        expect(reported(host), host).not.toBeNull();
      }
      expect(reported(`shard..${D}`)).toMatch(/cannot be read/);
      expect(reported(`shärd.${D}`)).toMatch(/cannot be read/);
      expect(reported(`10.0.0.7:27017`)).toMatch(/not IP addresses/);
      expect(reported('localhost:27017')).toMatch(/fully qualified/);
    });

    it('an SRV name that is unverified, too short or not alone extends no trust', () => {
      // Unverified SRV name (not in the allow-list).
      expect(reported('m1.zzzzz.example.org', stagingConfig, { seeds: ['srv.zzzzz.example.org'], srv: true })).toMatch(/neither a declared staging host/);
      // Verified but only three labels: no domain can be derived, members must be listed.
      const short: DeploymentConfig = { ...stagingConfig, STAGING_DB_HOST_SHA256: [hostFingerprint('db.example.net')] };
      expect(reported('m1.example.net', short, { seeds: ['db.example.net'], srv: true })).toMatch(/neither a declared staging host/);
      // An SRV string never has more than one host; anything else is not trusted.
      expect(reported(`shard-00-00.${D}`, stagingConfig, { seeds: [STAGING_HOST, 'x.zzzzz.example.org'], srv: true })).toMatch(/neither a declared staging host/);
    });
  });

  describe('mongodb://: every reported member must be listed exactly', () => {
    it('a mongodb:// seed cannot authorise another reported host under the same parent domain', () => {
      expect(hostProblem(plainConfig, seedA)).toBeNull();
      expect(reported(otherTenant, plainConfig, { seeds: [seedA], srv: false })).toMatch(/every member of a mongodb:\/\/ cluster must be listed exactly/);
      expect(reported(`vm-staging-c.${shared}`, plainConfig, { seeds: [seedA], srv: false })).toMatch(/listed exactly/);
    });

    it('the same check through the real post-connect path', async () => {
      const otherTenantReported = fakeConnection({ me: `${otherTenant}:27017`, hosts: [`${seedA}:27017`, `${otherTenant}:27017`] }, [`${seedA}:27017`]);
      await expect(assertConnectedHostsAllowed(otherTenantReported, plainConfig, plainUri)).rejects.toThrow(/listed exactly/);
      const listed: DeploymentConfig = { ...plainConfig, STAGING_DB_HOST_SHA256: [hostFingerprint(seedA), hostFingerprint(seedB)] };
      const bothListed = fakeConnection({ me: `${seedA}:27017`, hosts: [`${seedA}:27017`, `${seedB}:27017`] }, [`${seedA}:27017`]);
      await expect(assertConnectedHostsAllowed(bothListed, listed, plainUri)).resolves.toBeUndefined();
    });

    it('every non-SRV member is fingerprinted exactly, including Atlas-style shard hosts under one domain', () => {
      const a = `a-shard-00-00.${D}`;
      const b = `a-shard-00-01.${D}`;
      const c = `a-shard-00-02.${D}`;
      const config: DeploymentConfig = { ...stagingConfig, STAGING_DB_HOST_SHA256: [hostFingerprint(a), hostFingerprint(b)] };
      const reach = { seeds: [a, b], srv: false };
      expect(reported(b, config, reach)).toBeNull();
      expect(reported(c, config, reach)).toMatch(/listed exactly/); // same domain, not listed: refused
      expect(reported(c, { ...config, STAGING_DB_HOST_SHA256: [...(config.STAGING_DB_HOST_SHA256 ?? []), hostFingerprint(c)] }, reach)).toBeNull();
    });

    it('servers the driver adds later follow the same rule (topology watch)', () => {
      const plainCheck = topologyChangeCheck(plainConfig, plainUri);
      expect(plainCheck(`${otherTenant}:27017`)).toMatch(/listed exactly/);
      expect(plainCheck(`${seedA}:27017`)).toBeNull();
      const srvCheck = topologyChangeCheck(stagingConfig, staging.MONGODB_URI);
      expect(srvCheck(`shard-00-03.${D}:27017`)).toBeNull();
      expect(srvCheck(`shard-00-03.unlisted.example.net:27017`)).toMatch(/neither a declared staging host/);
    });

    it('validates every seed of a multi-seed URI; an unverified seed expands nothing', () => {
      const onlyA = { ...staging, STAGING_DB_HOST_SHA256: hostFingerprint(seedA) };
      const uri = `mongodb://u:p@${seedA}:27017,${seedB}:27017/academy_staging?tls=true&replicaSet=rs`;
      expect(() => parseEnv({ ...onlyA, MONGODB_URI: uri })).toThrow(/not a declared staging host/);
      expect(() => parseEnv({ ...onlyA, STAGING_DB_HOST_SHA256: `${hostFingerprint(seedA)},${hostFingerprint(seedB)}`, MONGODB_URI: uri })).not.toThrow();
      // Post-connect: an unverified extra seed, and the hosts under it, stay refused.
      expect(reported(seedB, plainConfig, { seeds: [seedA, seedB], srv: false })).toMatch(/listed exactly/);
      expect(reported(`m1.zzzzz.example.org`, plainConfig, { seeds: [seedA, 'seed.zzzzz.example.org'], srv: false })).toMatch(/listed exactly/);
    });
  });

  it('the production deny-list wins over any staging fingerprint and only ever blocks', () => {
    // Production fingerprint of the staging cluster's own domain: staging is refused (fail closed).
    const denied: DeploymentConfig = { ...stagingConfig, PRODUCTION_DB_HOST_SHA256: [hostFingerprint(D)] };
    expect(hostProblem(denied, STAGING_HOST)).toMatch(/production database host/);
    expect(reported(`shard-00-00.${D}`, denied)).toMatch(/production database host/);
    // Even an exactly listed member is refused when it matches the deny-list.
    const deniedListed: DeploymentConfig = { ...plainConfig, PRODUCTION_DB_HOST_SHA256: [hostFingerprint(shared)] };
    expect(reported(seedA, deniedListed, { seeds: [seedA], srv: false })).toMatch(/production database host/);
    // Exact overlap between the lists is a configuration error.
    expect(() => parseEnv({ ...staging, PRODUCTION_DB_HOST_SHA256: `${hostFingerprint(PROD_DOMAIN)},${hostFingerprint(STAGING_HOST)}` })).toThrow(/shares a fingerprint/);
    // A deny-list entry never makes an unlisted host acceptable, through any path.
    const broadDeny: DeploymentConfig = { ...stagingConfig, PRODUCTION_DB_HOST_SHA256: [hostFingerprint('unrelated.example.org')], STAGING_DB_HOST_SHA256: [hostFingerprint('other.fghij.example.net')] };
    expect(hostProblem(broadDeny, STAGING_HOST)).toMatch(/not a declared staging host/);
    expect(reported(`shard-00-00.${D}`, broadDeny)).toMatch(/neither a declared staging host/);
    expect(reported(otherTenant, { ...plainConfig, PRODUCTION_DB_HOST_SHA256: [hostFingerprint(otherTenant)] }, { seeds: [seedA], srv: false })).toMatch(/production database host/);
    // Outside staging, deny-list matches only refuse.
    const dev: DeploymentConfig = { ...testConfig, NODE_ENV: 'development', PRODUCTION_DB_HOST_SHA256: [hostFingerprint(PROD_DOMAIN)] };
    expect(hostProblem(dev, PROD_HOST)).toMatch(/production database host/);
    expect(hostProblem(dev, STAGING_HOST)).toBeNull();
  });

  it('checks run offline and connectivity stays unapproved', async () => {
    const lookups = [vi.spyOn(dns, 'lookup'), vi.spyOn(dns, 'resolveSrv'), vi.spyOn(dns.promises, 'lookup'), vi.spyOn(dns.promises, 'resolveSrv'), vi.spyOn(net, 'connect'), vi.spyOn(net, 'createConnection')];
    try {
      parseEnv(staging);
      assertDatabaseTarget(staging.MONGODB_URI, stagingConfig);
      driverTarget(staging.MONGODB_URI);
      runStagingPreflight(staging);
      await expect(assertConnectedHostsAllowed(fakeConnection({ hosts: [`shard-00-00.${D}:27017`] }), stagingConfig, staging.MONGODB_URI)).resolves.toBeUndefined();
      await expect(assertConnectedHostsAllowed(fakeConnection({ hosts: [`${otherTenant}:27017`] }), plainConfig, plainUri)).rejects.toThrow(/listed exactly/);
      for (const spy of lookups) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of lookups) spy.mockRestore();
    }
    expect(process.env.STAGING_CONNECTIVITY_APPROVED).toBeUndefined();
    expect(process.env.DEPLOY_ENV).toBeUndefined();
    expect(parseEnv(staging).STAGING_CONNECTIVITY_APPROVED).toBe(false);
  });
});

describe('DEPLOY_ENV=staging isolation rules', () => {
  it('accepts a correct staging configuration', () => {
    const env = parseEnv(staging);
    expect(env.DEPLOY_ENV).toBe('staging');
    expect(env.STAGING_CONNECTIVITY_APPROVED).toBe(false);
  });

  it('refuses a production database host, without echoing it or the password', () => {
    const message = errorMessage(() => parseEnv({ ...staging, MONGODB_URI: `mongodb+srv://staging_app:${FAKE_PASSWORD}@${PROD_HOST}/academy_staging` }));
    expect(message).toContain('points at a production database host');
    expect(message).not.toContain(PROD_DOMAIN);
    expect(message).not.toContain(FAKE_PASSWORD);
  });

  it('refuses production hosts in every equivalent form', () => {
    const uris = [
      `mongodb://u:p@db1.${STAGING_DOMAIN}:27017,${PROD_HOST.toUpperCase()}:27017/academy_staging?tls=true`, // second of several hosts
      `mongodb+srv://u:p@${PROD_HOST}./academy_staging`,
      `mongodb://u:p@${PROD_HOST.replace('.', '%2E')}:27017/academy_staging?tls=true`,
      `mongodb://u:p@prod-cluster-shard-00-00.${PROD_DOMAIN}:27017/academy_staging?tls=true`,
      `mongodb://${PROD_HOST}:27017/academy_staging?tls=true&appName=a@${STAGING_HOST}`,
    ];
    for (const uri of uris) expect(() => parseEnv({ ...staging, MONGODB_URI: uri }), uri).toThrow(/production database host/);
  });

  it('refuses any host that is not a declared staging host, even one nobody fingerprinted as production', () => {
    for (const uri of [
      'mongodb+srv://u:p@cluster0.unlisted.example.net/academy_staging', // an undeclared production cluster
      `mongodb+srv://u:p@staging-cluster.x${STAGING_DOMAIN}/academy_staging`, // look-alike domain
      'mongodb+srv://u:p@cluster0.example.net/academy_staging',
    ]) {
      expect(() => parseEnv({ ...staging, MONGODB_URI: uri }), uri).toThrow(/not a declared staging host/);
    }
  });

  it('requires names, fingerprints, production mode, readable hosts, host names and TLS validation', () => {
    expect(() => parseEnv({ ...staging, MONGODB_URI: `mongodb+srv://u:p@${STAGING_HOST}/academy` })).toThrow(/must contain "staging"/);
    expect(() => parseEnv({ ...staging, MONGODB_URI: `mongodb+srv://u:p@${STAGING_HOST}/prod_notstaging` })).toThrow(/must contain "staging"/);
    expect(() => parseEnv({ ...staging, PRODUCTION_DB_HOST_SHA256: undefined })).toThrow(/PRODUCTION_DB_HOST_SHA256: is required/);
    expect(() => parseEnv({ ...staging, PRODUCTION_DB_HOST_SHA256: '' })).toThrow(/PRODUCTION_DB_HOST_SHA256: is required/);
    expect(() => parseEnv({ ...staging, STAGING_DB_HOST_SHA256: undefined })).toThrow(/STAGING_DB_HOST_SHA256: is required/);
    expect(() => parseEnv({ ...staging, PRODUCTION_DB_HOST_SHA256: 'not-a-hash' })).toThrow(/SHA-256 hex/);
    expect(() => parseEnv({ ...staging, NODE_ENV: 'development', MAIL_TRANSPORT: 'outbox' })).toThrow(/NODE_ENV: must be "production"/);
    expect(() => parseEnv({ ...staging, MONGODB_URI: 'mongodb://u:p@/academy_staging' })).toThrow(/cannot be read/);
    expect(() => parseEnv({ ...staging, MONGODB_URI: `mongodb://u:p@db.${STAGING_DOMAIN}#x/academy_staging` })).toThrow(/cannot be read/);
    expect(() => parseEnv({ ...staging, MONGODB_URI: 'mongodb://u:p@10.1.2.3:27017/academy_staging?tls=true' })).toThrow(/not IP addresses/);
    expect(() => parseEnv({ ...staging, MONGODB_URI: 'mongodb://u:p@167838211:27017/academy_staging?tls=true' })).toThrow(/not IP addresses/);
    expect(() => parseEnv({ ...staging, MONGODB_URI: `${staging.MONGODB_URI}&tlsAllowInvalidHostnames=true` })).toThrow(/must not disable TLS/);
    expect(() => parseEnv({ ...staging, MONGODB_URI: `${staging.MONGODB_URI}&tlsInsecure=TRUE` })).toThrow(/must not disable TLS/);
  });

  it('refuses the same fingerprint in both lists', () => {
    expect(() => parseEnv({ ...staging, STAGING_DB_HOST_SHA256: `${hostFingerprint(STAGING_HOST)},${hostFingerprint(PROD_DOMAIN)}` })).toThrow(/shares a fingerprint/);
  });
});

describe('fail-closed deployment identity', () => {
  const production = {
    ...staging,
    DEPLOY_ENV: 'production',
    MONGODB_URI: `mongodb+srv://u:${FAKE_PASSWORD}@${PROD_HOST}/academy`,
    STAGING_DB_HOST_SHA256: undefined,
  };

  it('requires DEPLOY_ENV whenever NODE_ENV=production', () => {
    const { DEPLOY_ENV: _, ...withoutIdentity } = staging;
    expect(() => parseEnv(withoutIdentity)).toThrow(/DEPLOY_ENV: must be "staging" or "production"/);
    expect(() => parseEnv({ ...staging, DEPLOY_ENV: 'development' })).toThrow(/DEPLOY_ENV/);
    expect(() => parseEnv({ ...staging, DEPLOY_ENV: 'test' })).toThrow(/DEPLOY_ENV/);
    expect(() => parseEnv({ ...staging, DEPLOY_ENV: 'Staging' })).toThrow(/DEPLOY_ENV/);
  });

  it('refuses contradictory settings instead of ignoring them', () => {
    const local = { MONGODB_URI: 'mongodb://127.0.0.1:27017/academy_crm_dev', JWT_ACCESS_SECRET: 'x'.repeat(32) };
    expect(() => parseEnv({ ...local, STAGING_CONNECTIVITY_APPROVED: 'true' })).toThrow(/STAGING_CONNECTIVITY_APPROVED: may only be set/);
    expect(() => parseEnv({ ...production, STAGING_CONNECTIVITY_APPROVED: 'true' })).toThrow(/STAGING_CONNECTIVITY_APPROVED/);
    expect(() => parseEnv({ ...local, STAGING_CONNECTIVITY_APPROVED: 'yes' })).toThrow(/STAGING_CONNECTIVITY_APPROVED/);
    expect(() => parseEnv({ ...local, DEPLOY_ENV: 'test' })).toThrow(/DEPLOY_ENV: contradicts NODE_ENV/);
    expect(() => parseEnv({ ...production, STAGING_DB_HOST_SHA256: hostFingerprint(STAGING_HOST) })).toThrow(/STAGING_DB_HOST_SHA256: may only be set/);
  });

  it('DEPLOY_ENV=production accepts only declared production hosts and no staging database', () => {
    expect(() => parseEnv(production)).not.toThrow();
    expect(() => parseEnv({ ...production, PRODUCTION_DB_HOST_SHA256: undefined })).toThrow(/PRODUCTION_DB_HOST_SHA256: is required/);
    expect(() => parseEnv({ ...production, MONGODB_URI: `mongodb+srv://u:p@${STAGING_HOST}/academy` })).toThrow(/every host must match/);
    expect(() => parseEnv({ ...production, MONGODB_URI: `mongodb+srv://u:p@${PROD_HOST}/academy_staging` })).toThrow(/staging database/);
  });

  it('development refuses declared production hosts; plain local development is unaffected', () => {
    const dev = { MONGODB_URI: `mongodb+srv://u:p@${PROD_HOST}/academy`, JWT_ACCESS_SECRET: 'x'.repeat(32), PRODUCTION_DB_HOST_SHA256: hostFingerprint(PROD_DOMAIN) };
    expect(() => parseEnv(dev)).toThrow(/outside DEPLOY_ENV=production/);
    expect(() => parseEnv({ MONGODB_URI: 'mongodb://127.0.0.1:27017/academy_crm_dev', JWT_ACCESS_SECRET: 'x'.repeat(32) })).not.toThrow();
  });

  it('NODE_ENV=test only accepts local test databases', () => {
    const test = { NODE_ENV: 'test', JWT_ACCESS_SECRET: 'x'.repeat(32) };
    expect(() => parseEnv({ ...test, MONGODB_URI: 'mongodb://127.0.0.1:27017/academy_crm_test' })).not.toThrow();
    expect(() => parseEnv({ ...test, MONGODB_URI: 'mongodb://localhost:27017,[::1]:27018,127.1:27019/academy_e2e' })).not.toThrow();
    expect(() => parseEnv({ ...test, MONGODB_URI: `mongodb+srv://u:p@${STAGING_HOST}/academy_crm_test` })).toThrow(/local \(loopback\) hosts/);
    expect(() => parseEnv({ ...test, MONGODB_URI: 'mongodb://127.0.0.1:27017,db.example.net:27017/academy_crm_test' })).toThrow(/loopback/);
    expect(() => parseEnv({ ...test, MONGODB_URI: 'mongodb://localhost:pw@db.example.net/academy_crm_test' })).toThrow(/loopback/);
    expect(() => parseEnv({ ...test, MONGODB_URI: 'mongodb://127.0.0.1:27017/academy_crm_dev' })).toThrow(/"test" or "e2e"/);
  });
});

describe('connection boundary', () => {
  afterEach(() => {
    vi.doUnmock('../src/config/env.js');
    vi.resetModules();
    vi.restoreAllMocks();
  });

  /** Loads mongoose.ts with `overrides` applied to the env singleton, and spies on connection primitives. */
  async function boundaryWith(overrides: Record<string, unknown>) {
    vi.resetModules();
    vi.doMock('../src/config/env.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../src/config/env.js')>();
      return { ...actual, env: { ...actual.env, ...overrides } };
    });
    const module = await import('../src/database/mongoose.js');
    return { ...module, connect: vi.spyOn(mongoose, 'connect'), createConnection: vi.spyOn(mongoose, 'createConnection') };
  }

  it('blocks database connections in staging until approved', () => {
    expect(() => assertConnectivityAllowed({ DEPLOY_ENV: 'staging', STAGING_CONNECTIVITY_APPROVED: false })).toThrow(/connectivity is blocked/);
    expect(() => assertConnectivityAllowed({ DEPLOY_ENV: 'staging', STAGING_CONNECTIVITY_APPROVED: true })).not.toThrow();
    expect(() => assertConnectivityAllowed({ DEPLOY_ENV: undefined, STAGING_CONNECTIVITY_APPROVED: false })).not.toThrow();
  });

  it('connectDatabase refuses unapproved staging before any network activity', async () => {
    const { connectDatabase: connect, connect: connectSpy, createConnection } = await boundaryWith({ ...stagingConfig, STAGING_CONNECTIVITY_APPROVED: false });
    await expect(connect(staging.MONGODB_URI)).rejects.toThrow(/connectivity is blocked/);
    expect(connectSpy).not.toHaveBeenCalled();
    expect(createConnection).not.toHaveBeenCalled();
  });

  it('connectDatabase validates the URI it is given, not just the configured one', async () => {
    const { connectDatabase: connect, connect: connectSpy, createConnection } = await boundaryWith(stagingConfig);
    for (const uri of [
      `mongodb+srv://u:${FAKE_PASSWORD}@${PROD_HOST}/academy_staging`,
      `mongodb://u:${FAKE_PASSWORD}@prod-cluster-shard-00-01.${PROD_DOMAIN}.:27017/academy_staging?tls=true`,
      `mongodb+srv://u:${FAKE_PASSWORD}@${STAGING_HOST}/academy`,
      `mongodb://u:${FAKE_PASSWORD}@10.0.0.5:27017/academy_staging`,
      `mongodb+srv://u:${FAKE_PASSWORD}@cluster0.unlisted.example.net/academy_staging`,
    ]) {
      const error = await connect(uri).then(() => null, (e: Error) => e);
      expect(error?.message, uri).toMatch(/^Refusing to connect to MongoDB/);
      expect(error?.message).not.toContain(FAKE_PASSWORD);
      expect(error?.message).not.toContain(PROD_DOMAIN);
    }
    expect(connectSpy).not.toHaveBeenCalled();
    expect(createConnection).not.toHaveBeenCalled();
  });

  it('refuses a connection string the driver reads differently or rejects', () => {
    // Our parser stops at "?", the driver rejects the unescaped "@" in the options.
    const message = errorMessage(() => assertDatabaseTarget(`mongodb://127.0.0.1:27017/academy_test?appName=x:${FAKE_PASSWORD}@y`, testConfig));
    expect(message).toMatch(/driver rejects the connection string/);
    expect(message).not.toContain(FAKE_PASSWORD);
    expect(() => assertDatabaseTarget(`mongodb+srv://u:p@${STAGING_HOST}:27017/academy_staging`, stagingConfig)).toThrow(/driver rejects/);
    expect(() => assertDatabaseTarget(`mongodb+srv://u:p@${STAGING_HOST}/academy_staging`, stagingConfig)).not.toThrow();
  });

  it('connectDatabase refuses a remote database in tests and inconsistent identities', async () => {
    const { connectDatabase: connect, connect: connectSpy } = await boundaryWith(testConfig);
    await expect(connect(`mongodb+srv://u:p@${STAGING_HOST}/academy_crm_test`)).rejects.toThrow(/loopback/);
    await expect(connect('mongodb://localhost:pw@db.example.net/academy_crm_test')).rejects.toThrow(/loopback/);
    await expect(connect('mongodb://127.0.0.1:27017/academy_crm_dev')).rejects.toThrow(/"test" or "e2e"/);
    expect(connectSpy).not.toHaveBeenCalled();

    expect(() => assertDatabaseTarget('mongodb://127.0.0.1/x', { ...stagingConfig, DEPLOY_ENV: undefined })).toThrow(/DEPLOY_ENV: must be/);
    expect(() => assertDatabaseTarget(`mongodb+srv://u:p@${STAGING_HOST}/academy_staging`, { ...stagingConfig, STAGING_DB_HOST_SHA256: [] })).toThrow(/STAGING_DB_HOST_SHA256/);
  });

  it('opens the application connection with automatic operations held back', async () => {
    const { connectDatabase: connect, connect: connectSpy, createConnection } = await boundaryWith({ NODE_ENV: 'test' });
    try {
      await connect(localTestUri());
      // The probe ran first, then the application connection, both with nothing automatic.
      expect(createConnection.mock.invocationCallOrder[0]).toBeLessThan(connectSpy.mock.invocationCallOrder[0]!);
      for (const options of [(createConnection.mock.calls[0] as unknown[])[1], connectSpy.mock.calls[0]![1]]) {
        expect(options).toMatchObject({ autoCreate: false, autoIndex: false, bufferCommands: false });
      }
      // Released after verification.
      expect(mongoose.connection.config).toMatchObject({ autoCreate: true, bufferCommands: true });
    } finally {
      await mongoose.disconnect();
    }
  });

  it('connection errors are sanitised: no credentials, no nested cause', async () => {
    const { connectDatabase: connect } = await boundaryWith({ NODE_ENV: 'development', DEPLOY_ENV: undefined, PRODUCTION_DB_HOST_SHA256: undefined });
    for (const uri of [`mongodb://user:${FAKE_PASSWORD}@x@127.0.0.1:1/db`, `mongodb://user:${FAKE_PASSWORD}@127.0.0.1:99999/db`]) {
      const error = (await connect(uri).then(() => null, (e: unknown) => e)) as (Error & { cause?: unknown }) | null;
      expect(error).toBeInstanceOf(Error);
      expect(error?.message).toMatch(/^Could not connect to MongoDB/);
      expect(error?.cause).toBeUndefined();
      expect(`${error?.message}${error?.stack}${JSON.stringify(error)}`).not.toContain(FAKE_PASSWORD);
    }
    expect(redactConnectionStrings(`failed: mongodb+srv://u:${FAKE_PASSWORD}@h.example.net/db and mongodb://a:b@c/d`)).toBe(
      'failed: mongodb+srv://<redacted>@h.example.net/db and mongodb://<redacted>@c/d',
    );
  });
});

describe('post-connect host verification', () => {
  it('test mode refuses a cluster that is not local (e.g. a port-forward on 127.0.0.1 to a remote cluster)', async () => {
    const forwarded = fakeConnection({ me: `prod-cluster-shard-00-00.${PROD_DOMAIN}:27017`, hosts: [`prod-cluster-shard-00-00.${PROD_DOMAIN}:27017`] }, ['127.0.0.1:27017']);
    await expect(assertConnectedHostsAllowed(forwarded, testConfig, localTestUri())).rejects.toThrow(/^Refusing to use MongoDB: .*loopback/);
    await expect(assertConnectedHostsAllowed(fakeConnection({ me: '127.0.0.1:27017', hosts: ['127.0.0.1:27017'] }, ['127.0.0.1:27017']), testConfig, localTestUri())).resolves.toBeUndefined();
  });

  it('staging refuses a cluster reporting production or undeclared hosts (SRV record or DNS alias)', async () => {
    const aliasToProduction = fakeConnection({ hosts: [`ac-x1-shard-00-00.${PROD_DOMAIN}:27017`] }, [`${STAGING_HOST}:27017`]);
    await expect(assertConnectedHostsAllowed(aliasToProduction, stagingConfig, staging.MONGODB_URI)).rejects.toThrow(/production database host/);
    const undeclared = fakeConnection({ hosts: ['shard-00-00.unlisted.example.net:27017'] }, []);
    await expect(assertConnectedHostsAllowed(undeclared, stagingConfig, staging.MONGODB_URI)).rejects.toThrow(/neither a declared staging host nor under the domain of the verified SRV name/);
    const unreadable = fakeConnection({ hosts: ['mongö.example.net:27017'] }, []);
    await expect(assertConnectedHostsAllowed(unreadable, stagingConfig, staging.MONGODB_URI)).rejects.toThrow(/cannot be read/);
    await expect(assertConnectedHostsAllowed(fakeConnection({}, []), stagingConfig, staging.MONGODB_URI)).rejects.toThrow(/no host that can be checked/);
    const fine = fakeConnection({ me: `shard-00-00.${STAGING_DOMAIN}:27017`, hosts: [`shard-00-00.${STAGING_DOMAIN}:27017`, `shard-00-01.${STAGING_DOMAIN}:27017`] }, [`shard-00-00.${STAGING_DOMAIN}:27017`]);
    await expect(assertConnectedHostsAllowed(fine, stagingConfig, staging.MONGODB_URI)).resolves.toBeUndefined();
  });

  it('production refuses a cluster reporting a host outside the production fingerprints', async () => {
    const productionConfig: DeploymentConfig = { ...stagingConfig, DEPLOY_ENV: 'production', STAGING_DB_HOST_SHA256: undefined, STAGING_CONNECTIVITY_APPROVED: false };
    await expect(assertConnectedHostsAllowed(fakeConnection({ hosts: [`shard-00-00.${STAGING_DOMAIN}:27017`] }), productionConfig, `mongodb+srv://u:p@${PROD_HOST}/academy`)).rejects.toThrow(/every host must match/);
    await expect(assertConnectedHostsAllowed(fakeConnection({ hosts: [`shard-00-00.${PROD_DOMAIN}:27017`] }), productionConfig, `mongodb+srv://u:p@${PROD_HOST}/academy`)).resolves.toBeUndefined();
  });

  it('checks the real local replica set', async () => {
    const connection = await mongoose.createConnection(localTestUri()).asPromise();
    try {
      await expect(assertConnectedHostsAllowed(connection, testConfig, localTestUri())).resolves.toBeUndefined();
      const memberIsProduction: DeploymentConfig = { ...testConfig, NODE_ENV: 'development', PRODUCTION_DB_HOST_SHA256: [hostFingerprint('127.0.0.1')] };
      await expect(assertConnectedHostsAllowed(connection, memberIsProduction, localTestUri())).rejects.toThrow(/production database host/);
    } finally {
      await connection.close();
    }
  });

  it('closes the connection when the driver later adds a forbidden server', async () => {
    await connectDatabase(localTestUri());
    try {
      expect(mongoose.connection.readyState).toBe(mongoose.ConnectionStates.connected);
      mongoose.connection.getClient().emit('serverOpening', { address: `prod-cluster-shard-00-03.${PROD_DOMAIN}:27017` } as never);
      await vi.waitFor(() => expect(mongoose.connection.readyState).toBe(mongoose.ConnectionStates.disconnected));
    } finally {
      await disconnectDatabase();
    }
  });
});

describe('no connection path bypasses the boundary', () => {
  const root = path.resolve(import.meta.dirname, '..');
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? files(full) : /\.(c|m)?[jt]s$/.test(entry.name) ? [full] : [];
    });
  const relative = (file: string) => path.relative(root, file).replaceAll('\\', '/');
  // Connection primitives (error classes such as mongoose.mongo.MongoServerError are fine anywhere).
  const PRIMITIVES = /\b(mongoose\.connect|createConnection|openUri|MongoClient|from ['"]mongodb['"]|require\(['"]mongodb['"]\))/;

  it('only src/database opens connections or touches the driver, each in exactly one sanctioned way', () => {
    const offenders = files(path.join(root, 'src'))
      .filter((file) => !['src/database/mongoose.ts', 'src/database/driverUri.ts'].includes(relative(file)))
      .filter((file) => PRIMITIVES.test(readFileSync(file, 'utf8')))
      .map(relative);
    expect(offenders).toEqual([]);

    const boundary = readFileSync(path.join(root, 'src/database/mongoose.ts'), 'utf8');
    expect(boundary.match(/mongoose\.connect\(/g)).toHaveLength(1);
    expect(boundary.match(/mongoose\.createConnection\(/g)).toHaveLength(1);
    expect(boundary).not.toMatch(/openUri|MongoClient|from ['"]mongodb['"]/);
    const body = boundary.slice(boundary.indexOf('export async function connectDatabase'));
    const order = ['assertConnectivityAllowed()', 'assertDatabaseTarget(uri)', 'holdAutomaticOperations()', 'verifyOnProbe(uri', 'mongoose.connect(uri, { ...HELD', 'assertConnectedHostsAllowed(mongoose.connection, env, uri)', 'watchTopology(env, uri)', 'releaseAutomaticOperations()'].map((call) => body.indexOf(call));
    expect(order.every((index) => index > 0), JSON.stringify(order)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);

    const parser = readFileSync(path.join(root, 'src/database/driverUri.ts'), 'utf8');
    expect(parser.match(/new mongoose\.mongo\.MongoClient\(/g)).toHaveLength(1);
    expect(parser).not.toMatch(/\.connect\(|createConnection|openUri/);
  });

  it('tests open direct connections only to validated local test databases', () => {
    const direct = files(path.join(root, 'tests'))
      .flatMap((file) => readFileSync(file, 'utf8').split('\n').map((line) => ({ file: relative(file), line })))
      .filter(({ line }) => /await mongoose\.(createConnection|connect)\(|new (mongoose\.mongo\.)?MongoClient\(/.test(line));
    expect(direct.length).toBeGreaterThan(0);
    for (const { file, line } of direct) {
      expect(line, file).toMatch(/createConnection\(localTestUri\(/);
    }
  });

  it('no package script talks to a database directly', () => {
    const { scripts } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    for (const [name, command] of Object.entries(scripts)) {
      expect(command, name).not.toMatch(/\bmongosh\b|\bmongo\s|mongodb(\+srv)?:\/\//);
    }
  });
});

describe('offline staging preflight', () => {
  const statusOf = (checks: ReturnType<typeof runStagingPreflight>, id: string) => checks.find((c) => c.id === id)?.status;

  it('passes every automatic check for a correct candidate and lists manual items', () => {
    const checks = runStagingPreflight(staging);
    expect(checks.filter((c) => c.status === 'FAIL')).toEqual([]);
    expect(checks.filter((c) => c.status === 'MANUAL').length).toBeGreaterThanOrEqual(7);
  });

  it('fails when the candidate targets production, is approved too early, or uses unsafe settings', () => {
    const checks = runStagingPreflight({
      ...staging,
      MONGODB_URI: `mongodb+srv://u:${FAKE_PASSWORD}@${PROD_HOST}/academy`,
      STAGING_CONNECTIVITY_APPROVED: 'true',
      FRONTEND_URL: 'http://crm-staging.example.com',
      TRUST_PROXY: '0',
    });
    for (const id of ['config.valid', 'db.name', 'db.not-production', 'db.staging-host', 'connectivity.blocked', 'http.frontend-https', 'proxy.trust']) {
      expect(statusOf(checks, id), id).toBe('FAIL');
    }
    const printed = JSON.stringify(checks);
    expect(printed).not.toContain(FAKE_PASSWORD);
    expect(printed).not.toContain(PROD_DOMAIN);
  });

  it('fails shard hosts of the production domain, undeclared hosts, IP hosts, driver disagreement and disabled TLS validation', () => {
    const shard = runStagingPreflight({ ...staging, MONGODB_URI: `mongodb://u:p@prod-cluster-shard-00-00.${PROD_DOMAIN}.:27017/academy_staging?tls=true` });
    expect(statusOf(shard, 'db.not-production')).toBe('FAIL');
    expect(statusOf(runStagingPreflight({ ...staging, MONGODB_URI: 'mongodb+srv://u:p@cluster0.unlisted.example.net/academy_staging' }), 'db.staging-host')).toBe('FAIL');
    expect(statusOf(runStagingPreflight({ ...staging, STAGING_DB_HOST_SHA256: undefined }), 'db.allowlist')).toBe('FAIL');
    const ip = runStagingPreflight({ ...staging, MONGODB_URI: 'mongodb://u:p@10.1.2.3:27017/academy_staging?tls=true&tlsAllowInvalidCertificates=true' });
    expect(statusOf(ip, 'db.hostnames')).toBe('FAIL');
    expect(statusOf(ip, 'db.tls-validation')).toBe('FAIL');
    expect(statusOf(runStagingPreflight({ ...staging, MONGODB_URI: `mongodb+srv://u:p@${STAGING_HOST}:27017/academy_staging` }), 'db.driver-parse')).toBe('FAIL');
  });

  it('fails a local development file (the current .env shape)', () => {
    const checks = runStagingPreflight({
      MONGODB_URI: `mongodb+srv://u:${FAKE_PASSWORD}@${PROD_HOST}/db?retryWrites=truemongodb://127.0.0.1:27017/db`,
      JWT_ACCESS_SECRET: 'x'.repeat(64),
    });
    expect(statusOf(checks, 'db.single-uri')).toBe('FAIL');
    expect(statusOf(checks, 'deploy.identity')).toBe('FAIL');
    expect(JSON.stringify(checks)).not.toContain(FAKE_PASSWORD);
  });
});
