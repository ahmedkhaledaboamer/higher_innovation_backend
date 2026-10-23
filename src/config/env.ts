import { config as loadDotenv } from 'dotenv';
import { parseEnv } from './envSchema.js';

/**
 * Environment configuration.
 *
 * Every setting the app reads comes through here, validated once at startup.
 * If something is missing or malformed the process refuses to boot with a
 * readable list of problems instead of failing later at a random call site.
 */

// Tests never read .env: they start their own in-memory MongoDB (tests/globalSetup.ts),
// so they can never touch the development database by accident.
// Variables already set in the real environment always win over the file.
if (process.env.NODE_ENV !== 'test') {
  loadDotenv({ path: '.env', quiet: true });
}


export { type Env, parseEnv } from './envSchema.js';

export const env = parseEnv(process.env);

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
