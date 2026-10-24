/**
 * Serverless entry (Vercel picks a root index.ts before src/app.ts). It loads the app lazily so a
 * startup failure — usually missing or invalid environment variables — answers with a readable 503
 * instead of Vercel's generic FUNCTION_INVOCATION_FAILED page. Only variable NAMES are returned,
 * never values or messages; full detail goes to the function log.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

type Handler = (req: IncomingMessage, res: ServerResponse) => unknown;

let loading: Promise<Handler> | undefined;

/** Names from "Invalid environment configuration:\n  - NAME: message" (see src/config/envSchema.ts). */
function invalidVariables(error: unknown): string[] {
  const text = error instanceof Error ? error.message : '';
  if (!text.startsWith('Invalid environment configuration')) return [];
  return [...text.matchAll(/^\s+- ([A-Z0-9_.()]+):/gm)].map((match) => match[1]);
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    loading ??= import('./src/app.js').then((module) => module.default as unknown as Handler);
    const app = await loading;
    await app(req, res);
  } catch (error) {
    loading = undefined;
    console.error('API failed to start:', error);
    const variables = invalidVariables(error);
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        success: false,
        code: 'SERVICE_UNAVAILABLE',
        message: variables.length
          ? 'The API is not configured: set these environment variables in the hosting settings, then redeploy.'
          : 'The API failed to start. See the function logs for details.',
        ...(variables.length ? { invalidEnvironmentVariables: variables } : {}),
      }),
    );
  }
}
