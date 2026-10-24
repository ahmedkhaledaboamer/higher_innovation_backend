/**
 * Request handler for serverless hosting (Vercel). There is no listen() and no long-lived process,
 * so nothing here may exit the process or throw while the module loads:
 *
 * - Everything that reads the environment is imported lazily, on the first request. A missing or
 *   invalid setting then answers 503 with the variable NAMES (never values or messages) instead of
 *   Vercel's generic FUNCTION_INVOCATION_FAILED page; full detail goes to the function log.
 * - MongoDB is connected with the same checks main.ts runs at boot, then reused while the instance
 *   stays warm. A failure is not cached: the next request tries again.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

type Handler = (req: IncomingMessage, res: ServerResponse) => unknown;

let ready: Promise<Handler> | undefined;

async function start(): Promise<Handler> {
  const [{ createApp }, database] = await Promise.all([import('./createApp.js'), import('./database/mongoose.js')]);
  await database.connectDatabase();
  await database.pingDatabase();
  await database.assertTransactionSupport();
  await database.assertServerVersion();
  console.info('API ready (serverless): connected to MongoDB');
  return createApp() as unknown as Handler;
}

/** Names from "Invalid environment configuration:\n  - NAME: message" (see config/envSchema.ts). */
function invalidVariables(error: unknown): string[] {
  const text = error instanceof Error ? error.message : '';
  if (!text.startsWith('Invalid environment configuration')) return [];
  return [...text.matchAll(/^\s+- ([A-Za-z0-9_.()]+):/gm)].map((match) => match[1] ?? '').filter(Boolean);
}

function unavailable(res: ServerResponse, variables: string[]): void {
  res.statusCode = 503;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(
    JSON.stringify({
      success: false,
      code: 'SERVICE_UNAVAILABLE',
      message: variables.length
        ? 'The API is not configured: set these environment variables in the hosting settings, then redeploy.'
        : 'The API could not start (configuration or database connection). See the function logs for details.',
      ...(variables.length ? { invalidEnvironmentVariables: variables } : {}),
    }),
  );
}

export default async function serverlessHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let app: Handler;
  try {
    ready ??= start();
    app = await ready;
  } catch (error) {
    ready = undefined;
    console.error('API failed to start:', error);
    unavailable(res, invalidVariables(error));
    return;
  }
  await app(req, res);
}
