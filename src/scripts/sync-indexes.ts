/**
 * Builds/updates MongoDB indexes to match the schemas:  npm run db:indexes
 * Production does not build indexes automatically, so run this on every deploy.
 */
import { connectDatabase, disconnectDatabase } from '../database/mongoose.js';
import { syncAllIndexes } from '../database/setup.js';
import { logger } from '../utils/logger.js';

try {
  await connectDatabase();
  const collections = await syncAllIndexes();
  logger.info({ collections }, 'Indexes synchronised');
  await disconnectDatabase();
  process.exit(0);
} catch (error) {
  logger.error({ err: error }, 'Index sync failed');
  await disconnectDatabase().catch(() => undefined);
  process.exit(1);
}
