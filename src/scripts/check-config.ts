/**
 * Offline configuration check: validates an env file with the API's own rules without connecting to
 * anything and without printing any value. Defaults to ./.env.
 *
 *   npm run config:check                       # checks .env
 *   npm run config:check -- --env-file <path>  # checks another file
 */
import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import { parseEnv } from '../config/envSchema.js';

const flag = process.argv.indexOf('--env-file');
const file = flag !== -1 && process.argv[flag + 1] ? process.argv[flag + 1]! : '.env';
const values = parse(readFileSync(file, 'utf8'));
try {
  const env = parseEnv(values);
  console.log(`${file}: OK (NODE_ENV=${env.NODE_ENV}${env.DEPLOY_ENV ? `, DEPLOY_ENV=${env.DEPLOY_ENV}` : ''})`);
} catch (error) {
  // Messages name settings only; values are never included.
  console.log(`${file}: INVALID\n${(error as Error).message}`);
  process.exit(1);
}
