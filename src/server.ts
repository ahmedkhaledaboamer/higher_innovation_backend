import { createApp } from './app.js';
import { env } from './config/env.js';
import {
  assertServerVersion,
  assertTransactionSupport,
  connectDatabase,
  disconnectDatabase,
  pingDatabase,
} from './database/mongoose.js';
import { logger } from './utils/logger.js';

/**
 * Process entry point: connect to MongoDB, start HTTP, and shut down cleanly.
 */
async function main(): Promise<void> {
  // Connect and ping up front so a wrong MONGODB_URI fails at boot, not on the first request.
  await connectDatabase();
  await pingDatabase();
  await assertTransactionSupport();
  await assertServerVersion();
  logger.info('Connected to MongoDB');

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info(`API listening on http://localhost:${env.PORT} (${env.NODE_ENV})`);
    if (env.API_DOCS_ENABLED) {
      logger.info(`API docs at http://localhost:${env.PORT}/api/docs`);
    }
  });

  let shuttingDown = false;

  // Stop accepting new connections, let in-flight requests finish, then close the DB connection.
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} received, shutting down`);

    // Do not wait forever for slow or keep-alive clients.
    const forceExit = setTimeout(() => {
      logger.error('Graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, 10_000);
    forceExit.unref();

    server.close(async (error) => {
      await disconnectDatabase();
      if (error) {
        logger.error({ err: error }, 'Error while closing HTTP server');
        process.exit(1);
      }
      logger.info('Shutdown complete');
      process.exit(0);
    });
    server.closeIdleConnections();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// A rejected promise nobody handled means the app is in an unknown state: log it and exit
// so the process manager restarts a clean instance.
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled promise rejection');
  process.exit(1);
});

process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'Uncaught exception');
  process.exit(1);
});

main().catch(async (error: unknown) => {
  logger.fatal({ err: error }, 'Failed to start the API');
  await disconnectDatabase().catch(() => undefined);
  process.exit(1);
});
