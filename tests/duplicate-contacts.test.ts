import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { ContactLock, contactLockKey } from '../src/database/contactLock.model.js';
import { Lead } from '../src/modules/leads/lead.model.js';
import { Student } from '../src/modules/students/student.model.js';
import { studentBody } from './helpers/academy.js';
import { useTestDatabase } from './helpers/db.js';
import { delayDuplicateChecks } from './helpers/delayDuplicateChecks.js';
import { signedInAs } from './helpers/factories.js';
import { leadBody } from './helpers/leads.js';

/**
 * D37: concurrent creates, conversions and contact changes must not produce unintended duplicate
 * contacts, while allowDuplicate (managers) keeps working for shared family contacts.
 *
 * Determinism: a hook delays every duplicate-check query (the `$or` email/phone lookup on leads and
 * students). Without locking, every concurrent request would pass its check during that delay and
 * insert; so these assertions fail on the pre-fix code and pass only if the lock serialises them.
 */
useTestDatabase({ roles: true });

const app = createApp();
type Actor = Awaited<ReturnType<typeof signedInAs>>;
let admin: Actor;
let sales: Actor;

const delayedChecks = delayDuplicateChecks();

beforeEach(async () => {
  admin = await signedInAs(app, 'ADMIN');
  sales = await signedInAs(app, 'SALES');
});

const createLead = (actor: Actor, body: object) => request(app).post('/api/v1/leads').set(actor.auth).send(body);
const createStudent = (actor: Actor, body: object) => request(app).post('/api/v1/students').set(actor.auth).send(body);
const convert = (actor: Actor, id: string, body: object = {}) =>
  request(app).post(`/api/v1/leads/${id}/convert`).set(actor.auth).send(body);

const statuses = (results: Array<{ status: number }>) => results.map((r) => r.status).sort();

describe('D37: simultaneous lead creation', () => {
  it('creates exactly one lead when the same email arrives several times at once', async () => {
    const email = 'same.person@example.com';
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => createLead(admin, leadBody({ email, phone: `+20100${String(5_550_000 + n)}` }))),
    );

    expect(delayedChecks.count).toBeGreaterThanOrEqual(5); // the checks really overlapped
    expect(statuses(results)).toEqual([201, 409, 409, 409, 409]);
    for (const res of results.filter((r) => r.status === 409)) {
      expect(res.body.code).toBe('DUPLICATE_LEAD');
    }
    expect(await Lead.countDocuments({ email })).toBe(1);
  });

  it('treats differently formatted copies of one phone number as the same contact', async () => {
    const results = await Promise.all(
      ['+971 50 123 4567', '00971501234567', '+971-50-123-4567'].map((phone) => createLead(admin, leadBody({ email: null, phone }))),
    );
    expect(statuses(results)).toEqual([201, 409, 409]);
    expect(await Lead.countDocuments({ phoneNormalized: '+971501234567' })).toBe(1);
  });

  it('lets managers create intended duplicates at the same time (allowDuplicate is serialised, not blocked)', async () => {
    const phone = '+20 100 777 0000';
    const results = await Promise.all(
      [1, 2, 3].map(() => createLead(admin, leadBody({ email: null, phone, allowDuplicate: true }))),
    );
    expect(statuses(results)).toEqual([201, 201, 201]);
    expect(await Lead.countDocuments({ phoneNormalized: '+201007770000' })).toBe(3);
  });
});

describe('D37: simultaneous student creation and conversion', () => {
  it('creates exactly one student for the same email under concurrency', async () => {
    const email = 'one.student@example.com';
    const results = await Promise.all([1, 2, 3, 4].map(() => createStudent(admin, studentBody({ email, phone: null }))));
    expect(statuses(results)).toEqual([201, 409, 409, 409]);
    expect(await Student.countDocuments({ email })).toBe(1);
  });

  it('converts only one of two different leads that share a contact; the other lead stays unconverted', async () => {
    const email = 'shared.convert@example.com';
    const first = (await createLead(admin, leadBody({ email, assignedTo: sales.id }))).body.data;
    const second = (await createLead(admin, leadBody({ email, allowDuplicate: true, assignedTo: sales.id }))).body.data;

    const results = await Promise.all([convert(admin, first.id), convert(admin, second.id)]);
    expect(statuses(results)).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.body.code).toBe('DUPLICATE_STUDENT');
    expect(await Student.countDocuments({ email })).toBe(1);

    // The losing transaction was rolled back completely: its lead claim did not persist.
    const loserId = results[0]!.status === 409 ? first.id : second.id;
    const loser = await Lead.findById(loserId).lean();
    expect(loser).toMatchObject({ status: 'NEW', convertedStudent: null, convertedAt: null });
  });

  it('allows only one of a conversion and a direct student creation racing on the same phone', async () => {
    const phone = '+20 122 888 1111';
    const lead = (await createLead(admin, leadBody({ email: null, phone, assignedTo: sales.id }))).body.data;

    const results = await Promise.all([convert(admin, lead.id), createStudent(admin, studentBody({ email: null, phone }))]);
    expect(statuses(results)).toEqual([201, 409]);
    expect(await Student.countDocuments({ phoneNormalized: '+201228881111' })).toBe(1);
  });

  it('a manager may still convert into a shared contact with allowDuplicate', async () => {
    const phone = '+20 122 999 2222';
    await createStudent(admin, studentBody({ email: null, phone }));
    const lead = (await createLead(admin, leadBody({ email: null, phone }))).body.data;

    expect((await convert(admin, lead.id)).body.code).toBe('DUPLICATE_STUDENT');
    expect((await convert(sales, lead.id, { allowDuplicate: true })).status).toBe(404); // not their lead
    const res = await convert(admin, lead.id, { allowDuplicate: true });
    expect(res.status).toBe(201);
    expect(await Student.countDocuments({ phoneNormalized: '+201229992222' })).toBe(2);
  });
});

describe('D37: simultaneous contact changes', () => {
  it('lets only one of two students take the same new phone at once', async () => {
    const a = (await createStudent(admin, studentBody())).body.data;
    const b = (await createStudent(admin, studentBody())).body.data;
    const phone = '+20 122 555 0001';

    const results = await Promise.all(
      [a, b].map((student) => request(app).patch(`/api/v1/students/${student.id}`).set(admin.auth).send({ phone })),
    );
    expect(statuses(results)).toEqual([200, 409]);
    expect(await Student.countDocuments({ phoneNormalized: '+201225550001' })).toBe(1);
  });

  it('lets only one of two leads take the same new email at once', async () => {
    const a = (await createLead(admin, leadBody())).body.data;
    const b = (await createLead(admin, leadBody())).body.data;
    const email = 'moved.here@example.com';

    const results = await Promise.all(
      [a, b].map((lead) => request(app).patch(`/api/v1/leads/${lead.id}`).set(admin.auth).send({ email })),
    );
    expect(statuses(results)).toEqual([200, 409]);
    expect(await Lead.countDocuments({ email })).toBe(1);
  });
});

describe('D37: rollback and lock bookkeeping', () => {
  it('keeps no trace of aborted attempts: lock counters count committed writes only', async () => {
    const email = 'counted@example.com';
    const results = await Promise.all([1, 2, 3].map(() => createLead(admin, leadBody({ email, phone: null }))));
    expect(statuses(results)).toEqual([201, 409, 409]);

    // Two attempts were aborted after writing the lock; their increments were rolled back.
    const lock = await ContactLock.findById(contactLockKey('lead', 'email', email)).lean();
    expect(lock?.writes).toBe(1);
    expect(await Lead.countDocuments({ email })).toBe(1);
  });

  it('stores no contact data in lock keys', async () => {
    await createLead(admin, leadBody({ email: 'private.person@example.com', phone: '+20 100 246 8024' }));
    const ids = (await ContactLock.find().lean()).map((lock) => String(lock._id));
    expect(ids.length).toBeGreaterThanOrEqual(2);
    expect(ids.join(' ')).not.toMatch(/private\.person|example\.com|1002468024/);
    for (const id of ids) expect(id).toMatch(/^(lead|student):(email|phone):[0-9a-f]{64}$/);
  });

  it('never writes a lock for a request rejected before its transaction', async () => {
    const res = await createLead(sales, leadBody({ email: 'nope@example.com', allowDuplicate: true }));
    expect(res.status).toBe(403);
    expect(await ContactLock.countDocuments({ _id: contactLockKey('lead', 'email', 'nope@example.com') })).toBe(0);
  });
});
