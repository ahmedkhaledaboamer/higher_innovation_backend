import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Starts an in-memory MongoDB and sets MONGODB_URI for every test file.
    globalSetup: ['tests/globalSetup.ts'],
    // Set before any app module loads. Tests never read .env (see src/config/env.ts).
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      CORS_ORIGINS: 'http://localhost:5173',
      RATE_LIMIT_MAX: '10000',
      AUTH_RATE_LIMIT_MAX: '10',
      // Test-only secret; real deployments must set their own.
      JWT_ACCESS_SECRET: 'test-secret-that-is-at-least-32-characters-long',
      // Fast hashing keeps the suite quick; production requires >= 10.
      BCRYPT_ROUNDS: '4',
      MAIL_TRANSPORT: 'outbox',
      FRONTEND_URL: 'http://localhost:5173',
    },
    // Test files share one database; run them one at a time to keep them independent.
    fileParallelism: false,
    testTimeout: 15_000,
    // The first run downloads the mongod binary (~70 MB).
    hookTimeout: 120_000,
  },
});
