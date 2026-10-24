/**
 * Serverless entry point (hosts such as Vercel look for src/app.ts). It only re-exports the handler,
 * which loads configuration lazily, so a bad setting can never crash the function at import time.
 * The Express app itself is built by createApp.ts.
 */
export { default } from './serverless.js';
