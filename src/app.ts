import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import * as helmetModule from 'helmet';
import swaggerUi from 'swagger-ui-express';
import { corsOptions } from './config/cors.js';
import { env } from './config/env.js';
import { openApiDocument } from './docs/openapi.js';
import { errorHandler } from './middlewares/errorHandler.js';
import { notFound } from './middlewares/notFound.js';
import { apiRateLimiter } from './middlewares/rateLimiter.js';
import { requestLogger } from './middlewares/requestLogger.js';
import { v1Router } from './routes/index.js';

// helmet ships separate CJS and ESM typings; reading `default` from the namespace is callable under
// both (Vercel's builder type-checks this file as CommonJS, where a default import is the module object).
const helmet = helmetModule.default;

/**
 * Builds the Express application without starting a server.
 * server.ts calls listen(); tests pass the app straight to Supertest.
 *
 * Middleware order matters: a request passes through these top to bottom.
 */
export function createApp(): Express {
  const app = express();

  app.set('trust proxy', env.TRUST_PROXY);
  app.disable('x-powered-by');

  // 1. Request id + access log first, so every later failure is traceable.
  app.use(requestLogger);

  // 2. Security: headers, cross-origin policy, abuse protection.
  app.use(helmet());
  app.use(cors(corsOptions));
  app.use('/api', apiRateLimiter);

  // 3. Body and cookie parsing, with a size cap to reject oversized payloads early.
  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));
  app.use(cookieParser());

  // 4. Routes.
  app.use('/api/v1', v1Router);

  if (env.API_DOCS_ENABLED) {
    app.get('/api/docs.json', (_req, res) => {
      res.json(openApiDocument);
    });
    app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openApiDocument));
  }

  // 5. Nothing matched -> 404; any error anywhere -> one JSON error format.
  app.use(notFound);
  app.use(errorHandler);

  return app;
}
