/**
 * Vercel function: every request is routed here by vercel.json. See src/serverless.ts — it loads the
 * configuration lazily and answers 503 with the names of missing settings instead of crashing.
 */
export { default } from '../src/serverless.js';
