/**
 * Prints SHA-256 fingerprints for PRODUCTION_DB_HOST_SHA256 / STAGING_DB_HOST_SHA256, offline:
 *
 *   npm run fingerprint:hosts            then paste host names or a connection string, one per line,
 *                                        and finish with Ctrl+D (Ctrl+Z then Enter on Windows)
 *
 * Input is read from standard input (not arguments), so names and credentials do not end up in shell
 * history or process listings. Output contains only hashes and label counts: never host names,
 * database names or credentials. Hosts are canonicalised exactly as the isolation checks do.
 */
import { createInterface } from 'node:readline';
import { canonicalHost, hostFingerprint, isIpLiteral, mongoUriParts } from '../config/mongoUri.js';

const lines: string[] = [];
for await (const line of createInterface({ input: process.stdin, terminal: false })) {
  if (line.trim()) lines.push(line.trim());
}

let index = 0;
for (const line of lines) {
  const hosts = /^mongodb(\+srv)?:\/\//.test(line) ? mongoUriParts(line).hosts : [canonicalHost(line)];
  for (const host of hosts) {
    index += 1;
    if (!host) {
      console.log(`#${index}: cannot be read (refused by the isolation checks too)`);
      continue;
    }
    const labels = host.split('.');
    const exactNote = isIpLiteral(host) ? 'IP address: deny-list only' : `${labels.length} labels: STAGING_DB_HOST_SHA256 or PRODUCTION_DB_HOST_SHA256`;
    console.log(`#${index}: exact host (${exactNote}): ${hostFingerprint(host)}`);
    if (isIpLiteral(host)) continue;
    for (let i = 1; labels.length - i >= 2; i += 1) {
      console.log(`    parent domain (${labels.length - i} labels, PRODUCTION_DB_HOST_SHA256 only): ${hostFingerprint(labels.slice(i).join('.'))}`);
    }
  }
}
if (index === 0) console.log('No input. Paste host names or a connection string, then end input.');
