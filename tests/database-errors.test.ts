import express from 'express';
import mongoose, { Schema } from 'mongoose';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { errorHandler } from '../src/middlewares/errorHandler.js';
import { sendCreated, sendSuccess } from '../src/utils/response.js';
import { useTestDatabase } from './helpers/db.js';

useTestDatabase();

/** A throwaway model that behaves like real feature models will (unique email, required name). */
const Contact = mongoose.model(
  'TestContact',
  new Schema(
    {
      name: { type: String, required: true, minlength: 2 },
      email: { type: String, required: true, unique: true, lowercase: true },
    },
    { timestamps: true },
  ),
);

const app = express();
app.use(express.json());
app.post('/contacts', async (req, res) => {
  sendCreated(res, await Contact.create(req.body));
});
app.get('/contacts/:id', async (req, res) => {
  const contact = await Contact.findById(req.params.id).orFail();
  sendSuccess(res, contact);
});
app.use(errorHandler);

beforeAll(async () => {
  // Unique indexes are what actually prevent duplicates; make sure it exists before testing it.
  await Contact.syncIndexes();
});

describe('Mongoose/MongoDB errors through the error handler (real mongod)', () => {
  it('returns documents with `id` and without `_id` / `__v`', async () => {
    const res = await request(app).post('/contacts').send({ name: 'Mona', email: 'Mona@Example.com' });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ name: 'Mona', email: 'mona@example.com' });
    expect(res.body.data.id).toMatch(/^[0-9a-f]{24}$/);
    expect(res.body.data._id).toBeUndefined();
    expect(res.body.data.__v).toBeUndefined();
  });

  it('maps a duplicate key to 409 without echoing the value', async () => {
    await request(app).post('/contacts').send({ name: 'Mona', email: 'mona@example.com' });
    const res = await request(app).post('/contacts').send({ name: 'Other', email: 'mona@example.com' });

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'UNIQUE_CONSTRAINT', message: 'A record with this email already exists' });
    expect(JSON.stringify(res.body)).not.toContain('mona@example.com');
  });

  it('maps schema validation failures to 400 with each field', async () => {
    const res = await request(app).post('/contacts').send({ name: 'M' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.errors.map((e: { path: string }) => e.path).sort()).toEqual(['email', 'name']);
  });

  it('maps a malformed ObjectId to 400 INVALID_ID', async () => {
    const res = await request(app).get('/contacts/not-an-id');

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_ID', message: 'Invalid value for "_id"' });
  });

  it('maps a missing document to 404', async () => {
    const res = await request(app).get(`/contacts/${new mongoose.Types.ObjectId().toString()}`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });
});
