import { pingDatabase } from '../../database/mongoose.js';
import { logger } from '../../utils/logger.js';

export interface LivenessReport {
  status: 'ok';
  uptimeSeconds: number;
  timestamp: string;
}

export interface ReadinessReport {
  status: 'ok' | 'unavailable';
  checks: { database: { status: 'up' | 'down'; latencyMs: number } };
  timestamp: string;
}

export const healthService = {
  /** The process is running and able to answer HTTP. Does not touch dependencies. */
  getLiveness(): LivenessReport {
    return {
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  },

  /** The process can do real work: currently that means MongoDB answers a ping. */
  async getReadiness(): Promise<ReadinessReport> {
    const startedAt = performance.now();
    let databaseUp = true;

    try {
      await pingDatabase();
    } catch (error) {
      databaseUp = false;
      logger.warn({ err: error }, 'Readiness check: database is unreachable');
    }

    return {
      status: databaseUp ? 'ok' : 'unavailable',
      checks: {
        database: {
          status: databaseUp ? 'up' : 'down',
          latencyMs: Math.round(performance.now() - startedAt),
        },
      },
      timestamp: new Date().toISOString(),
    };
  },
};
