import { pino } from 'pino';
import { env } from '../config/env.js';

/**
 * Paths that must never reach the logs. Pino replaces their values with "[REDACTED]".
 * Covers request headers that carry credentials and common secret-bearing body fields.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.currentPassword',
  '*.newPassword',
  '*.passwordHash',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
];

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  base: { service: 'academy-crm-api' },
  timestamp: pino.stdTimeFunctions.isoTime,
  // Human-readable output while developing locally; raw JSON (for log collectors) everywhere else.
  // Never on serverless hosts (VERCEL): pino-pretty is a dev dependency and transports need worker
  // threads, so loading it there crashes the function before the API can start.
  ...(env.NODE_ENV === 'development' && !process.env.VERCEL
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname,service' },
        },
      }
    : {}),
});
