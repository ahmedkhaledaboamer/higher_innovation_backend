import { randomUUID } from 'node:crypto';
import { pinoHttp } from 'pino-http';
import { logger } from '../utils/logger.js';

// Accept a caller-supplied request id only if it looks like an id, so clients
// cannot inject arbitrary text into our logs.
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Logs one line per request (method, url, status, duration) and gives every
 * request an id. The id is echoed back in the `X-Request-Id` header and in error
 * bodies, so a user-reported error can be matched to its log line.
 */
export const requestLogger = pinoHttp({
  logger,
  genReqId(req, res) {
    const incoming = req.headers['x-request-id'];
    const id = typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
    res.setHeader('X-Request-Id', id);
    return id;
  },
  customLogLevel(_req, res, error) {
    if (error || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  // Keep request logs small: no bodies, and only the headers worth having.
  serializers: {
    req(req) {
      return { id: req.id, method: req.method, url: req.url, remoteAddress: req.remoteAddress };
    },
    res(res) {
      return { statusCode: res.statusCode };
    },
  },
  autoLogging: {
    // Load balancers poll the health check constantly; don't flood the logs with it.
    ignore: (req) => req.url?.startsWith('/api/v1/health') ?? false,
  },
});
