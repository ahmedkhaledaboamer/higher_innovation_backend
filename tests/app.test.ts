import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { useTestDatabase } from './helpers/db.js';

useTestDatabase();

const app = createApp();

describe('GET /api/v1/health', () => {
  it('reports the process as alive', async () => {
    const res = await request(app).get('/api/v1/health');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, data: { status: 'ok' } });
    expect(typeof res.body.data.uptimeSeconds).toBe('number');
  });

  it('returns a request id header, reusing a safe incoming one', async () => {
    const generated = await request(app).get('/api/v1/health');
    expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);

    const reused = await request(app).get('/api/v1/health').set('X-Request-Id', 'trace-123');
    expect(reused.headers['x-request-id']).toBe('trace-123');

    const rejected = await request(app).get('/api/v1/health').set('X-Request-Id', 'bad id <script>');
    expect(rejected.headers['x-request-id']).not.toBe('bad id <script>');
  });
});

describe('GET /api/v1/health/ready', () => {
  it('reports ready when MongoDB answers (real in-memory mongod)', async () => {
    const res = await request(app).get('/api/v1/health/ready');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      data: { status: 'ok', checks: { database: { status: 'up' } } },
    });
  });
});

describe('security middleware', () => {
  it('sets Helmet security headers and hides the framework', async () => {
    const res = await request(app).get('/api/v1/health');

    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBeDefined();
    expect(res.headers['strict-transport-security']).toBeDefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('allows the configured frontend origin with credentials', async () => {
    const res = await request(app).get('/api/v1/health').set('Origin', 'http://localhost:5173');

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('rejects an unknown origin with 403', async () => {
    const res = await request(app).get('/api/v1/health').set('Origin', 'https://evil.example.com');

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ success: false, code: 'CORS_ORIGIN_DENIED' });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('adds rate-limit headers to API routes', async () => {
    const res = await request(app).get('/api/v1/does-not-exist');
    expect(res.headers['ratelimit-policy']).toBeDefined();
  });
});

describe('error handling', () => {
  it('answers unknown routes with a JSON 404', async () => {
    const res = await request(app).get('/api/v1/does-not-exist');

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({
      success: false,
      code: 'ROUTE_NOT_FOUND',
      message: 'Route GET /api/v1/does-not-exist not found',
    });
    expect(res.body.requestId).toBeDefined();
  });

  it('answers malformed JSON with 400 INVALID_JSON', async () => {
    const res = await request(app)
      .post('/api/v1/health')
      .set('Content-Type', 'application/json')
      .send('{"broken": ');

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, code: 'INVALID_JSON' });
  });

  it('answers oversized bodies with 413', async () => {
    const res = await request(app)
      .post('/api/v1/health')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ blob: 'x'.repeat(200 * 1024) }));

    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({ success: false, code: 'PAYLOAD_TOO_LARGE' });
  });
});

describe('API docs', () => {
  it('serves the OpenAPI document', async () => {
    const res = await request(app).get('/api/docs.json');

    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.1.0');
    expect(res.body.paths['/health']).toBeDefined();
    expect(Object.keys(res.body.paths)).toEqual(
      expect.arrayContaining([
        '/auth/login',
        '/auth/refresh',
        '/auth/reset-password',
        '/users',
        '/users/{id}/role',
        '/roles',
        '/leads',
        '/leads/{id}/assign',
        '/leads/{id}/notes',
        '/courses',
        '/students',
        '/students/{id}/enrollments',
        '/enrollments/{id}/status',
        '/leads/{id}/convert',
        '/trainers',
        '/trainers/me',
        '/trainer-assignments/{id}/end',
        '/diplomas',
        '/campaigns',
        '/campaigns/{id}/status',
        '/leads/{id}/campaign',
        '/dashboard/summary',
        '/reports/leads/summary',
        '/reports/leads/timeseries',
        '/reports/leads/breakdown',
        '/reports/campaigns',
        '/reports/academy',
      ]),
    );
    // Generated from the Zod schemas the routes actually validate with.
    expect(res.body.paths['/auth/login'].post.requestBody.content['application/json'].schema.required).toEqual([
      'email',
      'password',
    ]);
  });

  it('serves Swagger UI', async () => {
    const res = await request(app).get('/api/docs/');

    expect(res.status).toBe(200);
    expect(res.text).toContain('swagger-ui');
  });
});
