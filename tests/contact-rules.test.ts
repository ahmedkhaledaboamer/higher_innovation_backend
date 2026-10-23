import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { ContactLock, contactLockKey } from '../src/database/contactLock.model.js';
import { Lead } from '../src/modules/leads/lead.model.js';
import { Student } from '../src/modules/students/student.model.js';
import { logger } from '../src/utils/logger.js';
import { isUaeCountry, normalizePhone } from '../src/utils/phone.js';
import { studentBody } from './helpers/academy.js';
import { useTestDatabase } from './helpers/db.js';
import { delayDuplicateChecks } from './helpers/delayDuplicateChecks.js';
import { signedInAs } from './helpers/factories.js';
import { leadBody } from './helpers/leads.js';

/**
 * Approved D37 follow-up rules:
 *   D53 country-aware phone canonicalisation (UAE only when the country says so),
 *   D54 restore rejected (409) when it would duplicate an active record of the same type,
 *   D55 allowDuplicate on contact edits for Owner/Admin only, still serialised by contact locks,
 *   D56 cross-type lead/student matches are non-blocking warnings within the caller's read scope.
 */
useTestDatabase({ roles: true });

const app = createApp();
type Actor = Awaited<ReturnType<typeof signedInAs>>;
let owner: Actor;
let admin: Actor;
let salesA: Actor;
let salesB: Actor;
let marketing: Actor;

const delayed = delayDuplicateChecks();

beforeEach(async () => {
  owner = await signedInAs(app, 'OWNER');
  admin = await signedInAs(app, 'ADMIN');
  salesA = await signedInAs(app, 'SALES');
  salesB = await signedInAs(app, 'SALES');
  marketing = await signedInAs(app, 'MARKETING');
});

const createLead = (actor: Actor, body: object) => request(app).post('/api/v1/leads').set(actor.auth).send(body);
const createStudent = (actor: Actor, body: object) => request(app).post('/api/v1/students').set(actor.auth).send(body);
const patchLead = (actor: Actor, id: string, body: object) => request(app).patch(`/api/v1/leads/${id}`).set(actor.auth).send(body);
const patchStudent = (actor: Actor, id: string, body: object) =>
  request(app).patch(`/api/v1/students/${id}`).set(actor.auth).send(body);
const archiveLead = (id: string) => request(app).post(`/api/v1/leads/${id}/archive`).set(admin.auth);
const restoreLead = (id: string) => request(app).post(`/api/v1/leads/${id}/restore`).set(admin.auth);
const archiveStudent = (id: string) => request(app).post(`/api/v1/students/${id}/archive`).set(admin.auth);
const restoreStudent = (id: string) => request(app).post(`/api/v1/students/${id}/restore`).set(admin.auth);
const statuses = (results: Array<{ status: number }>) => results.map((r) => r.status).sort();
const lockWrites = async (key: string) => (await ContactLock.findById(key).lean())?.writes ?? 0;
const key = (entity: 'lead' | 'student', kind: 'email' | 'phone', value: string) => contactLockKey(entity, kind, value);

/* ------------------------------------------------------------------------------------------------ */
/* D53: phone canonicalisation                                                                      */
/* ------------------------------------------------------------------------------------------------ */

describe('D53 normalizePhone', () => {
  it('recognises the UAE only from an explicit country value', () => {
    for (const value of ['United Arab Emirates', 'united arab emirates', 'UAE', 'U.A.E.', 'AE', 'The United Arab Emirates', 'الإمارات العربية المتحدة']) {
      expect(isUaeCountry(value), value).toBe(true);
    }
    for (const value of [null, undefined, '', 'Egypt', 'Saudi Arabia', 'Emirates Palace', 'Dubai']) {
      expect(isUaeCountry(value), String(value)).toBe(false);
    }
  });

  it('turns UAE local numbers into +971 only when the country is the UAE', () => {
    const uae = 'United Arab Emirates';
    expect(normalizePhone('050 123 4567', uae)).toBe('+971501234567'); // mobile
    expect(normalizePhone('04-123 4567', uae)).toBe('+97141234567'); // Dubai landline
    expect(normalizePhone('(050) 123.4567', uae)).toBe('+971501234567'); // punctuation
    expect(normalizePhone('  0501234567  ', uae)).toBe('+971501234567'); // whitespace
    expect(normalizePhone('971501234567', uae)).toBe('+971501234567'); // code without +
    expect(normalizePhone('971 0 50 123 4567', uae)).toBe('+971501234567'); // stray trunk 0
    expect(normalizePhone('+971 0 50 123 4567', uae)).toBe('+971501234567');
    expect(normalizePhone('00971 50 123 4567', uae)).toBe('+971501234567');
    expect(normalizePhone('+971 50 123 4567', uae)).toBe('+971501234567'); // no double prefix
  });

  it('keeps foreign international numbers on UAE records unchanged', () => {
    expect(normalizePhone('+20 100 123 4567', 'UAE')).toBe('+201001234567');
    expect(normalizePhone('0044 20 7946 0958', 'UAE')).toBe('+442079460958');
  });

  it('never assumes the UAE for other or unknown countries (historic behaviour)', () => {
    expect(normalizePhone('0501234567', 'Egypt')).toBe('0501234567');
    expect(normalizePhone('0501234567', null)).toBe('0501234567');
    expect(normalizePhone('0501234567')).toBe('0501234567');
    expect(normalizePhone('+20 (100) 123-4567', 'Egypt')).toBe('+201001234567');
    expect(normalizePhone('00201001234567', undefined)).toBe('+201001234567');
  });

  it('rejects UAE-context numbers it cannot read unambiguously', () => {
    for (const value of ['501234567', '050123', '05012345678901', '9715012', '0']) {
      expect(() => normalizePhone(value, 'UAE'), value).toThrow(/valid UAE number/);
    }
    expect(normalizePhone('', 'UAE')).toBeNull();
    expect(normalizePhone('---', 'UAE')).toBeNull();
  });
});

describe('D53 through the API', () => {
  it('stores the canonical form and detects duplicates across formats', async () => {
    const res = await createLead(admin, leadBody({ email: null, phone: '050 123 4567', country: 'United Arab Emirates' }));
    expect(res.status).toBe(201);
    expect(res.body.data.phone).toBe('050 123 4567'); // what the user typed is kept
    expect((await Lead.findById(res.body.data.id).lean())!.phoneNormalized).toBe('+971501234567');

    const dup = await createLead(admin, leadBody({ email: null, phone: '+971 50 123 4567' }));
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('DUPLICATE_LEAD');

    // Same digits with no country or another country are a different value: not a duplicate.
    expect((await createLead(admin, leadBody({ email: null, phone: '0501234567' }))).status).toBe(201);
    expect((await createLead(admin, leadBody({ email: null, phone: '0501234567', country: 'Egypt' }))).status).toBe(409);
  });

  it('rejects an ambiguous UAE number with 400 VALIDATION_ERROR on "phone"', async () => {
    const res = await createStudent(admin, studentBody({ email: null, phone: '501234567', country: 'UAE' }));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(res.body.errors).toEqual([{ path: 'phone', message: expect.stringMatching(/valid UAE number/) }]);
  });

  it('re-canonicalises when only the country changes, and checks the new value', async () => {
    const taken = await createLead(admin, leadBody({ email: null, phone: '+971 55 222 3333' }));
    expect(taken.status).toBe(201);
    const lead = (await createLead(admin, leadBody({ email: null, phone: '055 222 3333' }))).body.data; // no country yet
    const res = await patchLead(admin, lead.id, { country: 'United Arab Emirates' });
    expect(res.status).toBe(409); // now the same number as the first lead
    expect((await Lead.findById(lead.id).lean())!.phoneNormalized).toBe('0552223333'); // unchanged
  });

  it('serialises simultaneous local and international spellings of one UAE number', async () => {
    const results = await Promise.all([
      createStudent(admin, studentBody({ email: null, phone: '056 777 8888', country: 'UAE' })),
      createStudent(admin, studentBody({ email: null, phone: '+971 56 777 8888' })),
    ]);
    expect(delayed.count).toBeGreaterThanOrEqual(2);
    expect(statuses(results)).toEqual([201, 409]);
    expect(await Student.countDocuments({ phoneNormalized: '+971567778888' })).toBe(1);
  });

  it('finds +971 records when staff search the local form', async () => {
    await createLead(admin, leadBody({ fullName: 'Search Me', email: null, phone: '050 999 1212', country: 'UAE' }));
    const res = await request(app).get('/api/v1/leads').query({ search: '050 999 1212' }).set(admin.auth);
    expect(res.body.data.map((l: { fullName: string }) => l.fullName)).toContain('Search Me');
  });
});

/* ------------------------------------------------------------------------------------------------ */
/* D54: restore conflicts                                                                           */
/* ------------------------------------------------------------------------------------------------ */

describe('D54 restore', () => {
  it('restores normally when there is no conflict', async () => {
    const lead = (await createLead(admin, leadBody())).body.data;
    await archiveLead(lead.id);
    const res = await restoreLead(lead.id);
    expect(res.status).toBe(200);
    expect(res.body.data.archived).toBe(false);
  });

  it('rejects restoring a lead whose email is now used by an active lead, and changes nothing', async () => {
    const email = 'restore.conflict@example.com';
    const old = (await createLead(admin, leadBody({ email }))).body.data;
    await archiveLead(old.id);
    expect((await createLead(admin, leadBody({ email }))).status).toBe(201); // allowed: the old one is archived
    const writesBefore = await lockWrites(key('lead', 'email', email));

    const res = await restoreLead(old.id);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DUPLICATE_LEAD');
    expect(res.body.message).toMatch(/cannot be restored/);

    const stored = await Lead.findById(old.id).lean();
    expect(stored!.archivedAt).not.toBeNull(); // still archived
    expect(await lockWrites(key('lead', 'email', email))).toBe(writesBefore); // aborted lock write rolled back
  });

  it('with two archived duplicates, restores only the first', async () => {
    const phone = '+20 100 555 6060';
    const a = (await createLead(admin, leadBody({ email: null, phone }))).body.data;
    await archiveLead(a.id);
    const b = (await createLead(admin, leadBody({ email: null, phone }))).body.data;
    await archiveLead(b.id);

    expect((await restoreLead(a.id)).status).toBe(200);
    expect((await restoreLead(b.id)).body.code).toBe('DUPLICATE_LEAD');
    expect(await Lead.countDocuments({ phoneNormalized: '+201005556060', archivedAt: null })).toBe(1);
  });

  it('restore versus create of the same contact: exactly one ends up active', async () => {
    const email = 'race.restore.create@example.com';
    const old = (await createLead(admin, leadBody({ email }))).body.data;
    await archiveLead(old.id);

    const results = await Promise.all([restoreLead(old.id), createLead(admin, leadBody({ email }))]);
    expect(delayed.count).toBeGreaterThanOrEqual(2);
    // Whichever request wins, the other is refused.
    expect(statuses(results)).toEqual(results[0]!.status === 200 ? [200, 409] : [201, 409]);
    expect(results.filter((r) => r.status === 409)).toHaveLength(1);
    expect(await Lead.countDocuments({ email, archivedAt: null })).toBe(1);
  });

  it('restore versus an edit that takes the same contact: exactly one wins', async () => {
    const email = 'race.restore.edit@example.com';
    const old = (await createLead(admin, leadBody({ email }))).body.data;
    await archiveLead(old.id);
    const other = (await createLead(admin, leadBody())).body.data;

    const results = await Promise.all([restoreLead(old.id), patchLead(admin, other.id, { email })]);
    expect(results.filter((r) => r.status === 409)).toHaveLength(1);
    expect(await Lead.countDocuments({ email, archivedAt: null })).toBe(1);
  });

  it('applies the same rule to students (409 DUPLICATE_STUDENT, student stays archived)', async () => {
    const email = 'student.restore@example.com';
    const old = (await createStudent(admin, studentBody({ email }))).body.data;
    expect((await archiveStudent(old.id)).status).toBe(200);
    expect((await createStudent(admin, studentBody({ email }))).status).toBe(201);

    const res = await restoreStudent(old.id);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DUPLICATE_STUDENT');
    expect((await Student.findById(old.id).lean())!.archivedAt).not.toBeNull();
  });

  it('student restore versus create: exactly one ends up active', async () => {
    const phone = '+20 122 404 0404';
    const old = (await createStudent(admin, studentBody({ email: null, phone }))).body.data;
    await archiveStudent(old.id);
    const results = await Promise.all([restoreStudent(old.id), createStudent(admin, studentBody({ email: null, phone }))]);
    expect(results.filter((r) => r.status === 409)).toHaveLength(1);
    expect(await Student.countDocuments({ phoneNormalized: '+201224040404', archivedAt: null })).toBe(1);
  });
});

/* ------------------------------------------------------------------------------------------------ */
/* D55: allowDuplicate on edits                                                                     */
/* ------------------------------------------------------------------------------------------------ */

describe('D55 allowDuplicate on contact edits', () => {
  it('lets Owner and Admin keep a duplicate on purpose; without the flag it is 409', async () => {
    const phone = '+20 100 808 0808';
    await createLead(admin, leadBody({ email: null, phone }));
    for (const actor of [owner, admin]) {
      const lead = (await createLead(admin, leadBody())).body.data;
      expect((await patchLead(actor, lead.id, { phone })).body.code).toBe('DUPLICATE_LEAD');
      const res = await patchLead(actor, lead.id, { phone, allowDuplicate: true });
      expect(res.status).toBe(200);
    }
    expect(await Lead.countDocuments({ phoneNormalized: '+201008080808' })).toBe(3);
  });

  it('refuses the flag from other roles with 403 FORBIDDEN_FIELD, even on their own records', async () => {
    const lead = (await createLead(salesA, leadBody())).body.data; // Sales owns what it creates
    const res = await patchLead(salesA, lead.id, { fullName: 'Renamed', allowDuplicate: true });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN_FIELD');
    expect((await Lead.findById(lead.id).lean())!.fullName).not.toBe('Renamed');

    // Explicit false is fine (it is the default).
    expect((await patchLead(salesA, lead.id, { fullName: 'Renamed', allowDuplicate: false })).status).toBe(200);

    // Marketing cannot edit leads at all: the route check answers first.
    expect((await patchLead(marketing, lead.id, { allowDuplicate: true, fullName: 'x' })).status).toBe(403);

    const student = (await createStudent(salesA, studentBody())).body.data;
    const studentRes = await patchStudent(salesA, student.id, { city: 'Cairo', allowDuplicate: true });
    expect(studentRes.status).toBe(403);
    expect(studentRes.body.code).toBe('FORBIDDEN_FIELD');
  });

  it('is not a field update by itself', async () => {
    const lead = (await createLead(admin, leadBody())).body.data;
    const res = await patchLead(admin, lead.id, { allowDuplicate: true });
    expect(res.status).toBe(400);
  });

  it('still validates and is still scoped', async () => {
    const lead = (await createLead(admin, leadBody())).body.data;
    expect((await patchLead(admin, lead.id, { email: 'not-an-email', allowDuplicate: true })).status).toBe(400);
    const other = (await createLead(salesB, leadBody())).body.data;
    expect((await patchLead(salesA, other.id, { fullName: 'Xavier' })).status).toBe(404); // another salesperson's lead
  });

  it('keeps contact-lock serialisation for concurrent authorised duplicates', async () => {
    const phone = '+20 100 909 0909';
    await createLead(admin, leadBody({ email: null, phone }));
    const a = (await createLead(admin, leadBody())).body.data;
    const b = (await createLead(admin, leadBody())).body.data;
    const writesBefore = await lockWrites(key('lead', 'phone', '+201009090909'));

    const results = await Promise.all([
      patchLead(admin, a.id, { phone, allowDuplicate: true }),
      patchLead(owner, b.id, { phone, allowDuplicate: true }),
    ]);
    expect(statuses(results)).toEqual([200, 200]);
    expect(await lockWrites(key('lead', 'phone', '+201009090909'))).toBe(writesBefore + 2); // both took the lock
  });

  it('only the flagged edit escapes the duplicate check; a concurrent unflagged one is still refused', async () => {
    const phone = '+20 122 919 1919';
    await createStudent(admin, studentBody({ email: null, phone }));
    const a = (await createStudent(admin, studentBody())).body.data;
    const b = (await createStudent(admin, studentBody())).body.data;
    const results = await Promise.all([
      patchStudent(admin, a.id, { phone, allowDuplicate: true }),
      patchStudent(admin, b.id, { phone }),
    ]);
    expect(results[0]!.status).toBe(200);
    expect(results[1]!.status).toBe(409);
  });

  it('logs the override with ids only (no contact data)', async () => {
    const info = vi.spyOn(logger, 'info');
    const phone = '+20 100 717 1717';
    await createLead(admin, leadBody({ email: null, phone }));
    const lead = (await createLead(admin, leadBody())).body.data;
    await patchLead(admin, lead.id, { phone, allowDuplicate: true });

    const call = info.mock.calls.find(([entry]) => (entry as { event?: string }).event === 'duplicate_contact_allowed');
    expect(call?.[0]).toEqual({ event: 'duplicate_contact_allowed', entity: 'lead', action: 'update', actorId: admin.id, recordId: lead.id });
    expect(JSON.stringify(call)).not.toMatch(/717|@/);
  });
});

/* ------------------------------------------------------------------------------------------------ */
/* D56: cross-type warnings                                                                         */
/* ------------------------------------------------------------------------------------------------ */

describe('D56 cross-type warnings', () => {
  it('warns (without blocking) when a new lead matches a student by email', async () => {
    const email = 'cross.email@example.com';
    const student = (await createStudent(admin, studentBody({ email }))).body.data;
    const studentBefore = await Student.findById(student.id).lean();

    const res = await createLead(admin, leadBody({ email }));
    expect(res.status).toBe(201);
    expect(res.body.warnings).toEqual([
      {
        code: 'CONTACT_MATCHES_STUDENT',
        message: expect.any(String),
        fields: ['email'],
        matches: [{ id: student.id, studentNumber: student.studentNumber }],
      },
    ]);
    // The student was not touched, linked or merged.
    expect(await Student.findById(student.id).lean()).toEqual(studentBefore);
  });

  it('warns on a phone-only match when a new student matches a lead', async () => {
    const lead = (await createLead(admin, leadBody({ email: null, phone: '+20 100 313 1313' }))).body.data;
    const res = await createStudent(admin, studentBody({ email: null, phone: '00201003131313' }));
    expect(res.status).toBe(201);
    expect(res.body.warnings).toEqual([
      { code: 'CONTACT_MATCHES_LEAD', message: expect.any(String), fields: ['phone'], matches: [{ id: lead.id, reference: lead.reference }] },
    ]);
  });

  it('ignores archived records of the other type', async () => {
    const email = 'cross.archived@example.com';
    const student = (await createStudent(admin, studentBody({ email }))).body.data;
    await archiveStudent(student.id);
    const res = await createLead(admin, leadBody({ email }));
    expect(res.status).toBe(201);
    expect(res.body).not.toHaveProperty('warnings');
  });

  it('shows nothing to callers who cannot read the other type', async () => {
    const email = 'cross.marketing@example.com';
    await createStudent(admin, studentBody({ email }));
    const res = await createLead(marketing, leadBody({ email })); // Marketing has no student access
    expect(res.status).toBe(201);
    expect(res.body).not.toHaveProperty('warnings');
  });

  it('limits Sales to matches inside their own scope', async () => {
    const email = 'cross.sales@example.com';
    await createStudent(admin, studentBody({ email, advisor: salesB.id })); // advised by someone else
    const hidden = await createLead(salesA, leadBody({ email }));
    expect(hidden.status).toBe(201);
    expect(hidden.body).not.toHaveProperty('warnings');

    const mine = (await createStudent(salesA, studentBody({ phone: '+20 122 616 1616', email: null }))).body.data; // advised by salesA
    const visible = await createLead(salesA, leadBody({ email: null, phone: '+20 122 616 1616' }));
    expect(visible.body.warnings[0]).toMatchObject({ code: 'CONTACT_MATCHES_STUDENT', matches: [{ id: mine.id }] });
  });

  it('does not replace the same-type rule: a same-type duplicate is still 409', async () => {
    const email = 'cross.both@example.com';
    await createStudent(admin, studentBody({ email }));
    await createLead(admin, leadBody({ email }));
    const res = await createLead(admin, leadBody({ email }));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DUPLICATE_LEAD');
  });

  it('warns on contact-changing edits, and only for the values that changed', async () => {
    const email = 'cross.edit@example.com';
    await createLead(admin, leadBody({ email }));
    const student = (await createStudent(admin, studentBody())).body.data;
    const res = await patchStudent(admin, student.id, { email });
    expect(res.status).toBe(200);
    expect(res.body.warnings[0]).toMatchObject({ code: 'CONTACT_MATCHES_LEAD', fields: ['email'] });

    const unchanged = await patchStudent(admin, student.id, { city: 'Giza' });
    expect(unchanged.body).not.toHaveProperty('warnings');
  });

  it('on conversion, warns about other leads with the contact but not the converted lead itself', async () => {
    const email = 'cross.convert@example.com';
    const lead = (await createLead(admin, leadBody({ email }))).body.data;
    const res1 = await request(app).post(`/api/v1/leads/${lead.id}/convert`).set(admin.auth).send({});
    expect(res1.status).toBe(201);
    expect(res1.body).not.toHaveProperty('warnings');

    const phone = '+20 100 525 2525';
    const first = (await createLead(admin, leadBody({ email: null, phone }))).body.data;
    await createLead(admin, leadBody({ email: null, phone, allowDuplicate: true }));
    const res2 = await request(app).post(`/api/v1/leads/${first.id}/convert`).set(admin.auth).send({});
    expect(res2.status).toBe(201);
    expect(res2.body.warnings[0]).toMatchObject({ code: 'CONTACT_MATCHES_LEAD', fields: ['phone'] });
    expect(res2.body.warnings[0].matches.map((m: { id: string }) => m.id)).not.toContain(first.id);
  });
});
