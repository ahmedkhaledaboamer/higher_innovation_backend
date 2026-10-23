import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { errorHandler } from '../src/middlewares/errorHandler.js';
import { validate } from '../src/middlewares/validate.js';
import { ApiError } from '../src/utils/ApiError.js';
import { sendCreated } from '../src/utils/response.js';

/**
 * A minimal app that exercises the shared middleware the way feature modules will:
 * validate -> controller -> (throw) -> errorHandler.
 */
function buildApp() {
  const app = express();
  app.use(express.json());

  app.post(
    '/items/:id',
    validate({
      params: z.object({ id: z.coerce.number().int().positive() }),
      query: z.object({ notify: z.enum(['true', 'false']).default('false') }),
      body: z.object({ name: z.string().trim().min(2), email: z.email() }),
    }),
    (req, res) => {
      sendCreated(res, { params: req.params, query: req.query, body: req.body });
    },
  );

  app.get('/api-error', () => {
    throw ApiError.conflict('Email already registered', 'EMAIL_TAKEN');
  });

  app.get('/async-error', async () => {
    await Promise.resolve();
    throw ApiError.forbidden();
  });

  app.get('/bug', () => {
    throw new Error('something exploded');
  });

  app.use(errorHandler);
  return app;
}

const app = buildApp();

describe('validate middleware', () => {
  it('passes parsed, coerced and stripped values to the handler', async () => {
    const res = await request(app)
      .post('/items/42')
      .send({ name: '  Ahmed  ', email: 'ahmed@example.com', role: 'Owner' });

    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({
      params: { id: 42 },
      query: { notify: 'false' },
      // trimmed, and the unexpected "role" field is dropped
      body: { name: 'Ahmed', email: 'ahmed@example.com' },
    });
  });

  it('returns 400 with every invalid field listed', async () => {
    const res = await request(app).post('/items/abc?notify=maybe').send({ name: 'A', email: 'nope' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, code: 'VALIDATION_ERROR', message: 'Validation failed' });
    // params fail first; Zod reports all issues for that part of the request
    expect(res.body.errors).toEqual([{ path: 'id', message: expect.any(String) }]);
  });

  it('reports all body problems at once', async () => {
    const res = await request(app).post('/items/1').send({ name: 'A', email: 'nope' });

    expect(res.status).toBe(400);
    const paths = res.body.errors.map((e: { path: string }) => e.path);
    expect(paths).toEqual(['name', 'email']);
  });
});

describe('errorHandler', () => {
  it('uses the status, message and code of an ApiError', async () => {
    const res = await request(app).get('/api-error');
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ success: false, message: 'Email already registered', code: 'EMAIL_TAKEN' });
  });

  it('catches errors thrown from async handlers (Express 5)', async () => {
    const res = await request(app).get('/async-error');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('turns unexpected errors into a 500', async () => {
    const res = await request(app).get('/bug');
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ success: false, code: 'INTERNAL_ERROR' });
  });
});
