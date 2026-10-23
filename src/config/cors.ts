import type { CorsOptions } from 'cors';
import { ApiError } from '../utils/ApiError.js';
import { env } from './env.js';

const allowedOrigins = new Set(env.CORS_ORIGINS);

/**
 * Only the configured frontend origins may call the API from a browser.
 * `credentials: true` is required because the refresh token travels in an
 * httpOnly cookie (Phase 2), and that in turn forbids a wildcard origin.
 */
export const corsOptions: CorsOptions = {
  origin(origin, callback) {
    // Requests without an Origin header (curl, server-to-server, health probes)
    // are not subject to CORS; authentication still protects them.
    if (!origin || allowedOrigins.has(origin)) {
      callback(null, true);
      return;
    }
    callback(ApiError.forbidden('Origin not allowed by CORS policy', 'CORS_ORIGIN_DENIED'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
  exposedHeaders: ['X-Request-Id', 'RateLimit', 'RateLimit-Policy', 'Retry-After'],
  maxAge: 600,
};
