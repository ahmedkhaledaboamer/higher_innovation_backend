import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/createApp.js';
import { Lead } from '../src/modules/leads/lead.model.js';
import { LeadNote } from '../src/modules/leads/leadNote.model.js';
import { useTestDatabase } from './helpers/db.js';
import { createUser, type Session, signedInAs } from './helpers/factories.js';
import { insertLead, leadBody } from './helpers/leads.js';

useTestDatabase({ roles: true });

const app = createApp();
const MISSING_ID = '665f1c2e9b3e4a0012345678';

let admin: Awaited<ReturnType<typeof signedInAs>>;
beforeEach(async () => {
  admin = await signedInAs(app, 'ADMIN');
});

const api = (session: Session) => ({
  list: (query = '') => request(app).get(`/api/v1/leads${query}`).set(session.auth),
  get: (id: string) => request(app).get(`/api/v1/leads/${id}`).set(session.auth),
  create: (body: object) => request(app).post('/api/v1/leads').set(session.auth).send(body),
  update: (id: string, body: object) => request(app).patch(`/api/v1/leads/${id}`).set(session.auth).send(body),
  status: (id: string, body: object) => request(app).patch(`/api/v1/leads/${id}/status`).set(session.auth).send(body),
  assign: (id: string, body: object) => request(app).patch(`/api/v1/leads/${id}/assign`).set(session.auth).send(body),
  archive: (id: string) => request(app).post(`/api/v1/leads/${id}/archive`).set(session.auth),
  restore: (id: string) => request(app).post(`/api/v1/leads/${id}/restore`).set(session.auth),
  addNote: (id: string, body: object) => request(app).post(`/api/v1/leads/${id}/notes`).set(session.auth).send(body),
  notes: (id: string, query = '') => request(app).get(`/api/v1/leads/${id}/notes${query}`).set(session.auth),
});

describe('POST /leads', () => {
  it('creates a lead with defaults and sequential references', async () => {
    const body = leadBody({
      phone: '+20 (100) 555-0101',
      utm: { source: 'facebook', medium: 'cpc', campaign: 'autumn-intake' },
      tags: ['HOT', 'HOT', 'VIP'],
    });

    const first = await api(admin).create(body);
    expect(first.status).toBe(201);
    expect(first.body.data).toMatchObject({
      reference: 'LD-1001',
      fullName: body.fullName,
      email: body.email,
      phone: '+20 (100) 555-0101',
      source: 'FACEBOOK_ADS',
      status: 'NEW',
      priority: 'MEDIUM',
      tags: ['HOT', 'VIP'],
      assignedTo: null,
      notesCount: 0,
      archived: false,
      utm: { source: 'facebook', medium: 'cpc', campaign: 'autumn-intake', term: null, content: null },
      createdBy: { id: admin.id, email: admin.email },
    });
    expect(first.body.data.phoneNormalized).toBeUndefined();

    const second = await api(admin).create(leadBody());
    expect(second.body.data.reference).toBe('LD-1002');
  });

  it('validates the payload', async () => {
    const cases: Array<[object, string[]]> = [
      // Field checks first; the "email or phone" rule runs once the fields themselves are valid.
      [{}, ['fullName', 'source']],
      [{ fullName: 'Ali Omar', source: 'WEBSITE' }, ['phone']],
      [{ ...leadBody(), email: 'not-an-email' }, ['email']],
      [{ ...leadBody(), source: 'TIKTOK' }, ['source']],
      [{ ...leadBody(), budget: -5 }, ['budget']],
      [{ ...leadBody(), nextFollowUpAt: 'next tuesday' }, ['nextFollowUpAt']],
      [{ ...leadBody(), status: 'REGISTERED' }, ['status']],
      [{ ...leadBody(), priority: 'CRITICAL', tags: ['FAMOUS'] }, ['priority', 'tags.0']],
      [{ ...leadBody(), assignedTo: 'abc' }, ['assignedTo']],
    ];
    for (const [body, paths] of cases) {
      const res = await api(admin).create(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(res.body.errors.map((e: { path: string }) => e.path).sort()).toEqual([...paths].sort());
    }
    expect(await Lead.countDocuments()).toBe(0);
  });

  it('ignores protected fields sent by the client', async () => {
    const res = await api(admin).create(
      leadBody({
        reference: 'LD-HACKED',
        notesCount: 99,
        archivedAt: new Date().toISOString(),
        createdBy: MISSING_ID,
        statusChangedAt: '2020-01-01T00:00:00Z',
        phoneNormalized: '+1',
      }),
    );
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ reference: 'LD-1001', notesCount: 0, archived: false, statusChangedAt: null });
    expect(res.body.data.createdBy.id).toBe(admin.id);
  });

  it('rejects duplicates by email or normalised phone, unless a manager overrides', async () => {
    const original = await api(admin).create(leadBody({ email: 'mona@example.com', phone: '+20 100 123 4567' }));

    const sameEmail = await api(admin).create(leadBody({ email: 'MONA@example.com' }));
    expect(sameEmail.status).toBe(409);
    expect(sameEmail.body).toMatchObject({ code: 'DUPLICATE_LEAD' });
    expect(sameEmail.body.errors).toEqual([{ path: 'email', message: `Matches lead ${original.body.data.reference}` }]);

    const samePhone = await api(admin).create(leadBody({ phone: '00201001234567' }));
    expect(samePhone.status).toBe(409);
    expect(samePhone.body.errors[0].path).toBe('phone');

    const override = await api(admin).create(leadBody({ email: 'mona@example.com', allowDuplicate: true }));
    expect(override.status).toBe(201);

    // Archived leads do not block new ones.
    await api(admin).archive(original.body.data.id);
    await api(admin).archive(override.body.data.id);
    expect((await api(admin).create(leadBody({ email: 'mona@example.com' }))).status).toBe(201);
  });

  it('validates the assignee on create', async () => {
    const sales = await createUser({ role: 'SALES' });
    const res = await api(admin).create(leadBody({ assignedTo: sales.id }));
    expect(res.status).toBe(201);
    expect(res.body.data.assignedTo).toEqual({ id: sales.id, name: 'Test User', email: sales.email });

    const missing = await api(admin).create(leadBody({ assignedTo: MISSING_ID }));
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe('ASSIGNEE_NOT_FOUND');
  });
});

describe('GET /leads/:id', () => {
  it('returns a lead, 404 for an unknown id and 400 for a malformed id', async () => {
    const created = await api(admin).create(leadBody());

    expect((await api(admin).get(created.body.data.id)).body.data.reference).toBe('LD-1001');

    const missing = await api(admin).get(MISSING_ID);
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('LEAD_NOT_FOUND');

    const malformed = await api(admin).get('not-an-id');
    expect(malformed.status).toBe(400);
    expect(malformed.body.errors).toEqual([{ path: 'id', message: 'Invalid id' }]);
  });
});

describe('PATCH /leads/:id', () => {
  it('updates permitted fields and ignores protected ones', async () => {
    const sales = await createUser({ role: 'SALES' });
    const created = await api(admin).create(leadBody());
    const id = created.body.data.id;

    const res = await api(admin).update(id, {
      fullName: 'Mona Adel',
      city: 'Cairo',
      priority: 'HIGH',
      budget: 15000,
      nextFollowUpAt: '2026-11-01T10:00:00Z',
      // None of these may change through this endpoint:
      status: 'QUALIFIED',
      assignedTo: sales.id,
      reference: 'LD-9999',
      notesCount: 50,
      archivedAt: new Date().toISOString(),
      createdBy: sales.id,
    });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      fullName: 'Mona Adel',
      city: 'Cairo',
      priority: 'HIGH',
      budget: 15000,
      nextFollowUpAt: '2026-11-01T10:00:00.000Z',
      status: 'NEW',
      assignedTo: null,
      reference: 'LD-1001',
      notesCount: 0,
      archived: false,
    });
    expect(res.body.data.createdBy.id).toBe(admin.id);
  });

  it('clears optional fields with null or empty string, but keeps at least one contact method', async () => {
    const created = await api(admin).create(leadBody({ city: 'Giza' }));
    const id = created.body.data.id;

    const cleared = await api(admin).update(id, { city: '', email: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data).toMatchObject({ city: null, email: null });

    const noContact = await api(admin).update(id, { phone: null });
    expect(noContact.status).toBe(400);
    expect(noContact.body.errors[0].path).toBe('phone');
  });

  it('rejects empty bodies, invalid values and duplicate contact details', async () => {
    const a = await api(admin).create(leadBody({ email: 'a@example.com' }));
    const b = await api(admin).create(leadBody());

    expect((await api(admin).update(b.body.data.id, {})).status).toBe(400);
    expect((await api(admin).update(b.body.data.id, { source: 'TV' })).status).toBe(400);

    const duplicate = await api(admin).update(b.body.data.id, { email: 'a@example.com' });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe('DUPLICATE_LEAD');

    // Re-saving a lead's own email is not a duplicate.
    expect((await api(admin).update(a.body.data.id, { email: 'a@example.com', city: 'Alex' })).status).toBe(200);
  });

  it('returns 404 for a nonexistent lead', async () => {
    expect((await api(admin).update(MISSING_ID, { city: 'Cairo' })).status).toBe(404);
  });
});

describe('PATCH /leads/:id/status', () => {
  it('moves through the pipeline and records when the status changed', async () => {
    const id = (await api(admin).create(leadBody())).body.data.id;

    const contacted = await api(admin).status(id, { status: 'CONTACTED' });
    expect(contacted.status).toBe(200);
    expect(contacted.body.data.status).toBe('CONTACTED');
    expect(contacted.body.data.statusChangedAt).toEqual(expect.any(String));

    const lost = await api(admin).status(id, { status: 'LOST', lostReason: 'Chose another academy' });
    expect(lost.body.data).toMatchObject({ status: 'LOST', lostReason: 'Chose another academy' });

    const reopened = await api(admin).status(id, { status: 'MEETING_SCHEDULED' });
    expect(reopened.body.data).toMatchObject({ status: 'MEETING_SCHEDULED', lostReason: null });
  });

  it('rejects invalid statuses, REGISTERED, and lostReason without LOST', async () => {
    const id = (await api(admin).create(leadBody())).body.data.id;

    expect((await api(admin).status(id, { status: 'WON' })).status).toBe(400);
    const registered = await api(admin).status(id, { status: 'REGISTERED' });
    expect(registered.status).toBe(400);
    expect(registered.body.errors[0].message).toMatch(/converting the lead/);
    const reason = await api(admin).status(id, { status: 'CONTACTED', lostReason: 'x' });
    expect(reason.body.errors[0].path).toBe('lostReason');
  });

  it('refuses to change a converted (REGISTERED) lead', async () => {
    const lead = await insertLead(admin.id, { status: 'REGISTERED' });
    const res = await api(admin).status(lead.id, { status: 'NEW' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('LEAD_CONVERTED');
  });
});

describe('PATCH /leads/:id/assign', () => {
  it('assigns, reassigns and unassigns, recording who did it', async () => {
    const salesA = await createUser({ role: 'SALES' });
    const salesB = await createUser({ role: 'SALES' });
    const id = (await api(admin).create(leadBody())).body.data.id;

    const assigned = await api(admin).assign(id, { assignedTo: salesA.id });
    expect(assigned.status).toBe(200);
    expect(assigned.body.data.assignedTo.id).toBe(salesA.id);
    expect(assigned.body.data.assignedAt).toEqual(expect.any(String));

    expect((await api(admin).assign(id, { assignedTo: salesB.id })).body.data.assignedTo.id).toBe(salesB.id);
    const stored = await Lead.findById(id).lean();
    expect(stored!.assignedBy!.toString()).toBe(admin.id);

    const unassigned = await api(admin).assign(id, { assignedTo: null });
    expect(unassigned.body.data).toMatchObject({ assignedTo: null, assignedAt: null });
  });

  it('only accepts existing, active users whose role works leads', async () => {
    const id = (await api(admin).create(leadBody())).body.data.id;
    const suspended = await createUser({ role: 'SALES', status: 'SUSPENDED' });
    const invited = await createUser({ role: 'SALES', status: 'INVITED', password: null });
    const marketing = await createUser({ role: 'MARKETING' });
    const viewer = await createUser({ role: 'VIEWER' });
    const owner = await createUser({ role: 'OWNER' });

    const cases: Array<[unknown, number, string]> = [
      [MISSING_ID, 400, 'ASSIGNEE_NOT_FOUND'],
      [suspended.id, 400, 'ASSIGNEE_INACTIVE'],
      [invited.id, 400, 'ASSIGNEE_INACTIVE'],
      [marketing.id, 400, 'ASSIGNEE_ROLE_NOT_ALLOWED'],
      [viewer.id, 400, 'ASSIGNEE_ROLE_NOT_ALLOWED'],
      ['bad-id', 400, 'VALIDATION_ERROR'],
      [undefined, 400, 'VALIDATION_ERROR'],
    ];
    for (const [assignedTo, status, code] of cases) {
      const res = await api(admin).assign(id, assignedTo === undefined ? {} : { assignedTo });
      expect(res.status, String(assignedTo)).toBe(status);
      expect(res.body.code).toBe(code);
    }
    expect((await Lead.findById(id).lean())!.assignedTo).toBeNull();

    // Managers can take a lead themselves.
    expect((await api(admin).assign(id, { assignedTo: owner.id })).status).toBe(200);
  });

  it('returns 404 for a nonexistent lead', async () => {
    const sales = await createUser({ role: 'SALES' });
    expect((await api(admin).assign(MISSING_ID, { assignedTo: sales.id })).status).toBe(404);
  });
});

describe('archive and restore', () => {
  it('hides archived leads, makes them read-only, and restores them', async () => {
    const id = (await api(admin).create(leadBody())).body.data.id;
    const sales = await createUser({ role: 'SALES' });

    const archived = await api(admin).archive(id);
    expect(archived.status).toBe(200);
    expect(archived.body.data.archived).toBe(true);
    expect(await Lead.countDocuments()).toBe(1); // still stored

    expect((await api(admin).list()).body.data).toHaveLength(0);
    expect((await api(admin).list('?archived=true')).body.data.map((l: { id: string }) => l.id)).toEqual([id]);
    expect((await api(admin).get(id)).status).toBe(200);

    for (const res of [
      await api(admin).update(id, { city: 'Cairo' }),
      await api(admin).status(id, { status: 'CONTACTED' }),
      await api(admin).assign(id, { assignedTo: sales.id }),
      await api(admin).addNote(id, { body: 'Called' }),
    ]) {
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('LEAD_ARCHIVED');
    }
    expect((await api(admin).archive(id)).body.code).toBe('LEAD_ALREADY_ARCHIVED');

    const restored = await api(admin).restore(id);
    expect(restored.body.data.archived).toBe(false);
    expect((await api(admin).restore(id)).body.code).toBe('LEAD_NOT_ARCHIVED');
    expect((await api(admin).update(id, { city: 'Cairo' })).status).toBe(200);
  });

  it('has no hard-delete endpoint', async () => {
    const id = (await api(admin).create(leadBody())).body.data.id;
    expect((await request(app).delete(`/api/v1/leads/${id}`).set(admin.auth)).status).toBe(404);
    expect(await Lead.countDocuments()).toBe(1);
  });

  it('returns 404 when archiving a nonexistent lead', async () => {
    expect((await api(admin).archive(MISSING_ID)).status).toBe(404);
    expect((await api(admin).restore(MISSING_ID)).status).toBe(404);
  });
});

describe('notes', () => {
  it('adds notes, keeps notesCount in sync, and lists pinned notes first', async () => {
    const id = (await api(admin).create(leadBody())).body.data.id;

    const first = await api(admin).addNote(id, { body: '  Asked about weekend classes  ' });
    expect(first.status).toBe(201);
    expect(first.body.data).toMatchObject({
      leadId: id,
      body: 'Asked about weekend classes',
      pinned: false,
      author: { id: admin.id },
    });
    await api(admin).addNote(id, { body: 'Prefers WhatsApp', pinned: true });
    await api(admin).addNote(id, { body: 'Sent brochure' });

    expect((await api(admin).get(id)).body.data.notesCount).toBe(3);

    const list = await api(admin).notes(id, '?limit=2');
    expect(list.status).toBe(200);
    expect(list.body.data.map((n: { body: string }) => n.body)).toEqual(['Prefers WhatsApp', 'Sent brochure']);
    expect(list.body.meta).toEqual({ page: 1, limit: 2, total: 3, totalPages: 2 });
  });

  it('validates notes and the lead id', async () => {
    const id = (await api(admin).create(leadBody())).body.data.id;
    expect((await api(admin).addNote(id, { body: '   ' })).status).toBe(400);
    expect((await api(admin).addNote(id, { body: 'x'.repeat(5001) })).status).toBe(400);
    expect((await api(admin).addNote(MISSING_ID, { body: 'Hello' })).status).toBe(404);
    expect((await api(admin).notes(MISSING_ID)).status).toBe(404);
    expect((await api(admin).notes('nope')).status).toBe(400);
    expect(await LeadNote.countDocuments()).toBe(0);
  });
});

describe('GET /leads (list)', () => {
  async function seedList() {
    const salesA = await createUser({ role: 'SALES', firstName: 'Amr' });
    const salesB = await createUser({ role: 'SALES', firstName: 'Bassem' });
    const at = (iso: string) => new Date(iso);
    await insertLead(admin.id, {
      fullName: 'Ahmed Samir', email: 'ahmed@example.com', phone: '+20 100 111 2222', status: 'NEW',
      source: 'FACEBOOK_ADS', priority: 'HIGH', tags: ['HOT'], country: 'Egypt', assignedTo: salesA.id,
      createdAt: at('2026-09-01T10:00:00Z'), nextFollowUpAt: at('2026-10-01T09:00:00Z'), reference: 'LD-2001',
    });
    await insertLead(admin.id, {
      fullName: 'mona adel', email: 'mona@example.com', status: 'CONTACTED', source: 'GOOGLE_ADS',
      priority: 'LOW', tags: ['VIP', 'RETURNING'], country: 'Saudi Arabia', assignedTo: salesB.id,
      createdAt: at('2026-09-15T10:00:00Z'), reference: 'LD-2002',
    });
    await insertLead(admin.id, {
      fullName: 'Zeinab Fathy', email: 'zeinab@example.com', status: 'LOST', source: 'REFERRAL',
      country: 'egypt', createdAt: at('2026-10-01T10:00:00Z'), reference: 'LD-2003',
    });
    await insertLead(admin.id, {
      fullName: 'Archived Person', status: 'NEW', archivedAt: new Date(), reference: 'LD-2004',
    });
    return { salesA, salesB };
  }
  const names = (res: request.Response) => res.body.data.map((l: { fullName: string }) => l.fullName);

  it('paginates and sorts (newest first by default; names case-insensitively)', async () => {
    await seedList();

    const page1 = await api(admin).list('?limit=2');
    expect(page1.body.meta).toEqual({ page: 1, limit: 2, total: 3, totalPages: 2 });
    expect(names(page1)).toEqual(['Zeinab Fathy', 'mona adel']);
    expect(names(await api(admin).list('?limit=2&page=2'))).toEqual(['Ahmed Samir']);
    expect(names(await api(admin).list('?sortBy=fullName&sortDir=asc'))).toEqual(['Ahmed Samir', 'mona adel', 'Zeinab Fathy']);

    expect((await api(admin).list('?sortBy=passwordHash')).status).toBe(400);
    expect((await api(admin).list('?limit=500')).status).toBe(400);
    expect((await api(admin).list('?page=0')).status).toBe(400);
  });

  it('searches name, email, reference and phone digits', async () => {
    await seedList();
    expect(names(await api(admin).list('?search=MONA'))).toEqual(['mona adel']);
    expect(names(await api(admin).list('?search=zeinab%40example'))).toEqual(['Zeinab Fathy']);
    expect(names(await api(admin).list('?search=LD-2001'))).toEqual(['Ahmed Samir']);
    expect(names(await api(admin).list('?search=111-2222'))).toEqual(['Ahmed Samir']);
    // Regex characters are matched literally.
    expect(names(await api(admin).list('?search=.*'))).toEqual([]);
  });

  it('filters by status, source, priority, tags, country, assignee, dates and follow-ups', async () => {
    const { salesA } = await seedList();
    const sorted = async (query: string) => names(await api(admin).list(`${query}&sortBy=fullName&sortDir=asc`)).sort();

    expect(await sorted('?status=NEW,CONTACTED')).toEqual(['Ahmed Samir', 'mona adel']);
    expect(await sorted('?status=NEW&status=LOST')).toEqual(['Ahmed Samir', 'Zeinab Fathy']);
    expect(await sorted('?source=GOOGLE_ADS')).toEqual(['mona adel']);
    expect(await sorted('?priority=HIGH')).toEqual(['Ahmed Samir']);
    expect(await sorted('?tags=VIP')).toEqual(['mona adel']);
    expect(await sorted('?country=EGYPT')).toEqual(['Ahmed Samir', 'Zeinab Fathy']);
    expect(await sorted(`?assignedTo=${salesA.id}`)).toEqual(['Ahmed Samir']);
    expect(await sorted('?assignedTo=unassigned')).toEqual(['Zeinab Fathy']);
    expect(await sorted(`?assignedTo=${salesA.id},unassigned`)).toEqual(['Ahmed Samir', 'Zeinab Fathy']);
    expect(await sorted('?createdFrom=2026-09-10&createdTo=2026-09-30')).toEqual(['mona adel']);
    expect(await sorted('?followUpBefore=2026-10-02')).toEqual(['Ahmed Samir']);
    expect(await sorted('?archived=true')).toEqual(['Archived Person']);
  });

  it('rejects invalid filter values and never treats query keys as operators', async () => {
    await seedList();
    for (const query of ['?status=WON', '?assignedTo=someone', '?createdFrom=yesterday', '?archived=maybe']) {
      expect((await api(admin).list(query)).status, query).toBe(400);
    }
    // "status[$ne]=NEW" is not parsed as a MongoDB operator: it is an unknown key and ignored.
    const injected = await api(admin).list('?status[$ne]=NEW&assignedTo[$exists]=false');
    expect(injected.status).toBe(200);
    expect(injected.body.meta.total).toBe(3);
  });
});
