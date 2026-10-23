import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

/**
 * Host names, database name and options of a MongoDB connection string, read without the driver and
 * without any network access. Credentials are dropped and never returned.
 *
 *   mongodb+srv://<user>:<password>@cluster0.<id>.example.net/academy_staging?retryWrites=true
 *     → { hosts: ['cluster0.<id>.example.net'], database: 'academy_staging', … }
 *   mongodb://127.0.0.1:27017,127.0.0.1:27018/db?replicaSet=rs0
 *     → { hosts: ['127.0.0.1', '127.0.0.1'], database: 'db', … }
 *
 * Hosts are canonicalised (see canonicalHost) so equivalent spellings compare equal. Anything that
 * cannot be read is reported as `unreadable` so callers fail closed. The connection boundary also
 * compares the result with the driver's own parse (src/database/driverUri.ts), and
 * tests/mongo-uri-differential.test.ts compares the two on a broad set of URIs.
 */
export interface MongoUriParts {
  hosts: string[];
  database: string | null;
  /** Lower-cased option names → raw values. */
  options: Record<string, string>;
  unreadable: boolean;
  /** mongodb+srv:// (the single host is an SRV name the driver resolves to its targets). */
  srv: boolean;
}

export function mongoUriParts(uri: string): MongoUriParts {
  const scheme = uri.match(/^mongodb(\+srv)?:\/\//);
  if (!scheme) return { hosts: [], database: null, options: {}, unreadable: true, srv: false };
  const rest = uri.slice(scheme[0].length);

  // The authority (credentials + hosts) ends at the first "/" or "?": "@" or ":" later in the path or
  // query must not be mistaken for the credentials separator. Like the driver, the hosts follow the
  // last "@" of the authority.
  const authorityEnd = firstIndex(rest, ['/', '?']);
  const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
  const afterAuthority = authorityEnd === -1 ? '' : rest.slice(authorityEnd);
  const hostPart = authority.includes('@') ? authority.slice(authority.lastIndexOf('@') + 1) : authority;

  let unreadable = false;
  const hosts = hostPart
    .split(',')
    .map((raw) => {
      const host = canonicalHost(raw);
      if (host === null) unreadable = true;
      return host;
    })
    .filter((host): host is string => Boolean(host));
  if (hosts.length === 0) unreadable = true;

  const [path, query = ''] = splitOnce(afterAuthority.startsWith('/') ? afterAuthority.slice(1) : afterAuthority, '?');
  let database: string | null = null;
  try {
    database = decodeURIComponent(path) || null;
  } catch {
    unreadable = true;
  }
  const options: Record<string, string> = {};
  for (const pair of query.split('&').filter(Boolean)) {
    const [key, value = ''] = splitOnce(pair, '=');
    options[key.toLowerCase()] = value;
  }
  return { hosts, database, options, unreadable, srv: Boolean(scheme[1]) };
}

const LABEL = /^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?$/;

/**
 * Canonical form of a host as written in a connection string or reported by a server ("host",
 * "host:port", "[v6]:port"), or null when it cannot be read with certainty:
 * - percent-decoded, lower case, port and IPv6 brackets removed, trailing dots removed;
 * - IP addresses in canonical form (127.1, 0x7f.0.0.1 and 2130706433 all become 127.0.0.1; IPv6 is
 *   compressed), since the system resolver accepts those spellings;
 * - only ASCII letters, digits, "-", "_" and non-empty labels: non-ASCII names (IDN, fullwidth
 *   look-alikes), socket paths and anything else unusual are refused rather than interpreted.
 */
export function canonicalHost(raw: string): string | null {
  let host = raw.trim();
  if (!host) return null;
  try {
    host = decodeURIComponent(host);
  } catch {
    return null;
  }
  if (/[^\x21-\x7e]/.test(host)) return null;
  host = host.toLowerCase();

  if (host.startsWith('[')) {
    const match = host.match(/^\[([0-9a-f:.]+)\](:\d*)?$/);
    if (!match || isIP(match[1]!) !== 6) return null;
    return new URL(`http://[${match[1]}]`).hostname.slice(1, -1);
  }
  // Unbracketed IPv6, as a server may report it without a port.
  if (isIP(host) === 6) return new URL(`http://[${host}]`).hostname.slice(1, -1);

  host = host.replace(/:\d*$/, '').replace(/\.+$/, '');
  if (!host || host.includes(':')) return null;
  let parsed: string;
  try {
    parsed = new URL(`http://${host}`).hostname;
  } catch {
    return null;
  }
  // The URL parser only rewrites numeric IPv4 forms here; any other change means the input was unusual.
  if (isIP(parsed) === 4) return parsed;
  if (parsed !== host) return null;
  return host.split('.').every((label) => LABEL.test(label)) ? host : null;
}

function firstIndex(value: string, chars: string[]): number {
  const indices = chars.map((c) => value.indexOf(c)).filter((i) => i !== -1);
  return indices.length ? Math.min(...indices) : -1;
}

function splitOnce(value: string, separator: string): [string, string] {
  const index = value.indexOf(separator);
  return index === -1 ? [value, ''] : [value.slice(0, index), value.slice(index + 1)];
}

/**
 * SHA-256 fingerprint (lower-case hex) of the canonical form of a host or domain name, as used by
 * PRODUCTION_DB_HOST_SHA256 and STAGING_DB_HOST_SHA256. Lets the owner declare hosts without writing
 * their names into configuration. Not a secret: short host names can be guessed from their hash.
 * Generate with `npm run fingerprint:hosts` (reads standard input, prints hashes only).
 */
export function hostFingerprint(host: string): string {
  return createHash('sha256').update(canonicalHost(host) ?? host.toLowerCase()).digest('hex');
}

/**
 * Production deny-list matching: true when the host, or any parent domain of it with at least two
 * labels, has a fingerprint in `fingerprints`. Matching is by whole labels only ("x-abcde.example.net"
 * is not under "abcde.example.net"); IP addresses only match exactly. Fingerprinting an Atlas cluster
 * domain such as "<id>.mongodb.net" therefore covers the SRV name, shard hosts and private-endpoint
 * hosts under it. Broad matching is only ever used to refuse (or, for DEPLOY_ENV=production, to
 * narrow which hosts are accepted), never to authorise a staging host: see hostHasExactFingerprint.
 */
export function hostMatchesFingerprints(host: string, fingerprints: readonly string[]): boolean {
  if (fingerprints.length === 0) return false;
  if (fingerprints.includes(hostFingerprint(host))) return true;
  if (isIP(host)) return false;
  const labels = host.split('.');
  for (let i = 1; labels.length - i >= 2; i += 1) {
    if (fingerprints.includes(hostFingerprint(labels.slice(i).join('.')))) return true;
  }
  return false;
}

/** Staging allow-list matching: the canonical host itself has a fingerprint in the list. No parents. */
export const hostHasExactFingerprint = (host: string, fingerprints: readonly string[]): boolean => fingerprints.includes(hostFingerprint(host));

/**
 * The domain under which a cluster reached through the SRV name `srvHost` may report its members: the
 * name without its first label ("cluster0.<id>.example.net" → "<id>.example.net"). This is the MongoDB
 * driver's own SRV rule (SRV targets must share the SRV name's parent domain), made stricter: the parent
 * must keep at least three labels, so a name such as "db.example.net" never extends trust to all of
 * "example.net". Only ever applied to mongodb+srv:// names: the driver has no such rule for mongodb://
 * seeds, so their members must be listed exactly. Null when no safe relationship exists (IP address,
 * fewer than four labels).
 */
export function memberDomainOf(srvHost: string): string | null {
  if (isIP(srvHost)) return null;
  const labels = srvHost.split('.');
  return labels.length >= 4 ? labels.slice(1).join('.') : null;
}

/** True when `host` is strictly beneath `domain`, on a label boundary. */
export const isStrictlyUnder = (host: string, domain: string): boolean => host.length > domain.length + 1 && host.endsWith(`.${domain}`);

export const isIpLiteral = (host: string): boolean => isIP(host) !== 0;

/** Canonical loopback hosts (canonicalHost has already turned 127.1 etc. into dotted form). */
export const isLoopbackHost = (host: string): boolean => host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);

/** "staging" as a separate segment of the database name: academy_staging, staging-crm, crm.staging. */
export const isStagingDatabaseName = (name: string | null): boolean => Boolean(name && /(^|[_.-])staging($|[_.-])/i.test(name));

/** "test" or "e2e" as a separate segment: the only databases the test suites may use (and wipe). */
export const isTestDatabaseName = (name: string | null): boolean => Boolean(name && /(^|[_.-])(test|e2e)($|[_.-])/i.test(name));

/** Replaces credentials in any MongoDB connection string inside `text` (for error messages and logs). */
export function redactConnectionStrings(text: string): string {
  return text.replace(/(mongodb(?:\+srv)?:\/\/)[^\s"'`]*@/gi, '$1<redacted>@');
}
