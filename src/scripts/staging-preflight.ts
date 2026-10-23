/**
 * Offline staging preflight (never connects to anything, never prints setting values).
 *
 *   npm run preflight:staging                         # checks the current process environment
 *   npm run preflight:staging -- --env-file <path>    # checks a candidate env file instead
 *
 * Exit code 0 when every automatic check passes; 1 otherwise. MANUAL items must be confirmed by a person.
 */
import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import { runStagingPreflight } from '../config/stagingPreflight.js';

const fileFlag = process.argv.indexOf('--env-file');
const source: Record<string, string | undefined> =
  fileFlag !== -1 && process.argv[fileFlag + 1] ? parse(readFileSync(process.argv[fileFlag + 1]!, 'utf8')) : { ...process.env };

const checks = runStagingPreflight(source);
for (const { id, status, detail } of checks) console.log(`${status.padEnd(6)} ${id.padEnd(22)} ${detail}`);
const failed = checks.filter((c) => c.status === 'FAIL').length;
console.log(`\n${failed === 0 ? 'Automatic checks passed.' : `${failed} automatic check(s) failed.`} Confirm the MANUAL items before any connectivity test.`);
process.exit(failed === 0 ? 0 : 1);
