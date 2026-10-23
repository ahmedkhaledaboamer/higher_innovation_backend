import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

// This file deliberately never connects to MongoDB: that is a real "database down" state.
const app = createApp();

describe('GET /api/v1/health/ready when the database is not connected', () => {
  it('returns 503 so load balancers stop routing traffic here', async () => {
    const res = await request(app).get('/api/v1/health/ready');

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      success: false,
      message: 'Service is not ready',
      data: { status: 'unavailable', checks: { database: { status: 'down' } } },
    });
  });

  it('keeps liveness at 200, because the process itself is fine', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
  });
});
