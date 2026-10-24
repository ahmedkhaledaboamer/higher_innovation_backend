/**
 * Entry point. On a normal host (`npm run dev`, `npm start`) it boots the long-running server in
 * main.ts. On Vercel (VERCEL is set) it only exposes the serverless handler: main.ts would call
 * listen() and process.exit(), which a serverless function must never do.
 */
export { default } from './serverless.js';

if (!process.env.VERCEL) {
  await import('./main.js');
}
