import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/createApp.js';
import { Campaign } from '../src/modules/campaigns/campaign.model.js';
import type { RoleKey } from '../src/modules/roles/permissions.js';
import { createCourse } from './helpers/academy.js';
import { useTestDatabase } from './helpers/db.js';
import { createUser, type Session, signedInAs } from './helpers/factories.js';
import { insertLead } from './helpers/leads.js';

useTestDatabase({ roles: true });

const app = createApp();
const MISSING_ID = '665f1c2e9b3e4a0012345678';
let admin: Awaited<ReturnType<typeof signedInAs>>;

beforeEach(async () => {
  admin = await signedInAs(app, 'ADMIN');
});

const body = (overrides: Record<string, unknown> = {}) => ({
  name: `Campaign ${Math.random().toString(36).slice(2, 7)}`,
  platform: 'FACEBOOK_ADS',
  ...overrides,
});
const post = (data: object, session: Session = admin) => request(app).post('/api/v1/campaigns').set(session.auth).send(data);
const patch = (id: string, data: object) => request(app).patch(`/api/v1/campaigns/${id}`).set(admin.auth).send(data);
const setStatus = (id: string, status: string) =>
  request(app).patch(`/api/v1/campaigns/${id}/status`).set(admin.auth).send({ status });
const list = (query = '') => request(app).get(`/api/v1/campaigns${query}`).set(admin.auth);

describe('POST /campaigns', () => {
  it('creates a campaign with a sequential code, AED amounts and empty metrics', async () => {
    const course = await createCourse(app, admin);
    const marketing = await createUser({ role: 'MARKETING' });
    const res = await post({
      name: 'Autumn Intake 2026',
      platform: 'INSTAGRAM_ADS',
      objective: 'Fill the data analytics cohort',
      courseId: course.id,
      ownerId: marketing.id,
      budget: 25000,
      spent: 4000,
      startDate: '2026-09-01',
      endDate: '2026-10-31',
      utm: { source: 'instagram', medium: 'paid_social', campaign: 'autumn-intake-2026' },
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      code: 'CMP-1001',
      name: 'Autumn Intake 2026',
      platform: 'INSTAGRAM_ADS',
      course: { id: course.id },
      owner: { id: marketing.id },
      budget: 25000,
      spent: 4000,
      currency: 'AED',
      status: 'DRAFT',
      statusChangedAt: null,
      utm: { source: 'instagram', medium: 'paid_social', campaign: 'autumn-intake-2026', term: null, content: null },
      metrics: { leads: 0, qualifiedLeads: 0, registeredStudents: 0, conversionRate: 0, costPerLead: null, budgetUsed: 0.16 },
      archived: false,
      createdBy: { id: admin.id },
    });
    expect((await post(body())).body.data.code).toBe('CMP-1002');
  });

  it('validates the payload and references', async () => {
    const cases: Array<[object, string[]]> = [
      [{}, ['name', 'platform']],
      [body({ platform: 'TV' }), ['platform']],
      [body({ budget: 99.5 }), ['budget']],
      [body({ spent: -1 }), ['spent']],
      [body({ status: 'COMPLETED' }), ['status']],
      [body({ startDate: '2026-10-01', endDate: '2026-09-01' }), ['endDate']],
      [body({ courseId: 'x', ownerId: 'y' }), ['courseId', 'ownerId']],
    ];
    for (const [data, paths] of cases) {
      const res = await post(data);
      expect(res.status, JSON.stringify(data)).toBe(400);
      expect(res.body.errors.map((e: { path: string }) => e.path).sort()).toEqual([...paths].sort());
    }

    const archivedCourse = await createCourse(app, admin);
    await request(app).post(`/api/v1/courses/${archivedCourse.id}/archive`).set(admin.auth);
    const refCases: Array<[object, number, string]> = [
      [body({ courseId: MISSING_ID }), 400, 'COURSE_NOT_FOUND'],
      [body({ courseId: archivedCourse.id }), 409, 'COURSE_ARCHIVED'],
      [body({ ownerId: MISSING_ID }), 400, 'OWNER_NOT_FOUND'],
      [body({ ownerId: (await createUser({ role: 'SALES' })).id }), 400, 'OWNER_ROLE_NOT_ALLOWED'],
      [body({ ownerId: (await createUser({ role: 'MARKETING', status: 'SUSPENDED' })).id }), 400, 'OWNER_INACTIVE'],
    ];
    for (const [data, status, code] of refCases) {
      const res = await post(data);
      expect(res.status, code).toBe(status);
      expect(res.body.code).toBe(code);
    }
    expect(await Campaign.countDocuments()).toBe(0);
  });

  it('keeps UTM campaign values unique (case-insensitive), also under concurrent creates', async () => {
    await post(body({ utm: { campaign: 'Spring-Promo' } }));
    const dup = await post(body({ utm: { campaign: 'spring-promo' } }));
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('CAMPAIGN_UTM_TAKEN');
    // Campaigns without a UTM campaign value never conflict.
    expect((await post(body())).status).toBe(201);
    expect((await post(body())).status).toBe(201);

    const results = await Promise.all([1, 2, 3, 4].map(() => post(body({ utm: { campaign: 'race-value' } }))));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.body.code === 'CAMPAIGN_UTM_TAKEN')).toHaveLength(3);
  });

  it('ignores server-managed fields', async () => {
    const res = await post(body({ code: 'CMP-1', archivedAt: new Date().toISOString(), createdBy: MISSING_ID, metrics: { leads: 99 } }));
    expect(res.body.data).toMatchObject({ code: 'CMP-1001', archived: false, createdBy: { id: admin.id }, metrics: { leads: 0 } });
  });
});

describe('PATCH /campaigns/:id', () => {
  it('edits fields but not status, and validates against stored values', async () => {
    const id = (await post(body({ startDate: '2026-09-01' }))).body.data.id;
    const res = await patch(id, { spent: 1200, budget: 6000, status: 'RUNNING', objective: '' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ spent: 1200, budget: 6000, status: 'DRAFT', objective: null });
    expect((await patch(id, { endDate: '2026-08-01' })).body.errors[0].path).toBe('endDate');
    expect((await patch(id, {})).status).toBe(400);
    expect((await patch(MISSING_ID, { spent: 1 })).status).toBe(404);
  });

  it('refuses a UTM value used by another campaign but allows keeping its own', async () => {
    await post(body({ utm: { campaign: 'taken' } }));
    const id = (await post(body({ utm: { campaign: 'mine' } }))).body.data.id;
    expect((await patch(id, { utm: { campaign: 'TAKEN' } })).body.code).toBe('CAMPAIGN_UTM_TAKEN');
    expect((await patch(id, { utm: { campaign: 'MINE', source: 'fb' } })).status).toBe(200);
  });
});

describe('status transitions', () => {
  it('follows the transition table and records when the status changed', async () => {
    const id = (await post(body())).body.data.id;
    for (const status of ['SCHEDULED', 'DRAFT', 'RUNNING', 'PAUSED', 'RUNNING', 'COMPLETED']) {
      const res = await setStatus(id, status);
      expect(res.status, status).toBe(200);
      expect(res.body.data.status).toBe(status);
    }
    expect((await Campaign.findById(id).lean())!.statusChangedAt).toBeInstanceOf(Date);
  });

  it('rejects disallowed transitions, invalid values and changes to a COMPLETED campaign', async () => {
    const id = (await post(body())).body.data.id;
    const bad = await setStatus(id, 'PAUSED');
    expect(bad.status).toBe(409);
    expect(bad.body.code).toBe('INVALID_STATUS_TRANSITION');
    expect(bad.body.errors[0].message).toContain('SCHEDULED, RUNNING');
    expect((await setStatus(id, 'ARCHIVED')).status).toBe(400);

    await setStatus(id, 'RUNNING');
    await setStatus(id, 'COMPLETED');
    for (const status of ['RUNNING', 'PAUSED', 'DRAFT']) {
      expect((await setStatus(id, status)).body.code, status).toBe('INVALID_STATUS_TRANSITION');
    }
    // Same status is a no-op.
    expect((await setStatus(id, 'COMPLETED')).status).toBe(200);
  });

  it('applies only one of two concurrent transitions', async () => {
    const id = (await post(body({ status: 'RUNNING' }))).body.data.id;
    const results = await Promise.all([setStatus(id, 'PAUSED'), setStatus(id, 'COMPLETED')]);
    const codes = results.map((r) => r.status).sort();
    // Either the second request saw the new status (409 INVALID_STATUS_TRANSITION or CONFLICT),
    // or the other order happened (RUNNING → PAUSED → COMPLETED is allowed). Never both from RUNNING.
    const final = (await Campaign.findById(id).lean())!.status;
    if (codes[1] === 409) {
      expect(['PAUSED', 'COMPLETED']).toContain(final);
    } else {
      expect(final).toBe('COMPLETED');
    }
  });
});

describe('archive and restore', () => {
  it('archives, makes the campaign read-only, and restores it with its status', async () => {
    const id = (await post(body({ status: 'RUNNING' }))).body.data.id;
    const archived = await request(app).post(`/api/v1/campaigns/${id}/archive`).set(admin.auth);
    expect(archived.body.data).toMatchObject({ archived: true, status: 'RUNNING' });
    expect((await list()).body.meta.total).toBe(0);
    expect((await list('?archived=true')).body.meta.total).toBe(1);
    expect((await patch(id, { spent: 1 })).body.code).toBe('CAMPAIGN_ARCHIVED');
    expect((await setStatus(id, 'PAUSED')).body.code).toBe('CAMPAIGN_ARCHIVED');
    expect((await request(app).post(`/api/v1/campaigns/${id}/archive`).set(admin.auth)).body.code).toBe('CAMPAIGN_ALREADY_ARCHIVED');

    const restored = await request(app).post(`/api/v1/campaigns/${id}/restore`).set(admin.auth);
    expect(restored.body.data).toMatchObject({ archived: false, status: 'RUNNING' });
    expect((await request(app).post(`/api/v1/campaigns/${id}/restore`).set(admin.auth)).body.code).toBe('CAMPAIGN_NOT_ARCHIVED');
    expect((await request(app).post(`/api/v1/campaigns/${MISSING_ID}/archive`).set(admin.auth)).status).toBe(404);
    expect((await request(app).delete(`/api/v1/campaigns/${id}`).set(admin.auth)).status).toBe(404);
  });
});

describe('GET /campaigns (list)', () => {
  it('paginates, searches, filters and sorts', async () => {
    const course = await createCourse(app, admin);
    const owner = await createUser({ role: 'MARKETING' });
    await post(body({ name: 'Alpha Facebook', platform: 'FACEBOOK_ADS', status: 'RUNNING', budget: 300, startDate: '2026-09-01', courseId: course.id }));
    await post(body({ name: 'beta Google', platform: 'GOOGLE_ADS', status: 'SCHEDULED', budget: 100, startDate: '2026-11-01', ownerId: owner.id }));
    await post(body({ name: 'Gamma TikTok', platform: 'TIKTOK', budget: 200, utm: { campaign: 'gamma-q4' } }));
    const names = (res: request.Response) => res.body.data.map((c: { name: string }) => c.name);

    expect((await list('?limit=2')).body.meta).toEqual({ page: 1, limit: 2, total: 3, totalPages: 2 });
    expect(names(await list('?sortBy=name&sortDir=asc'))).toEqual(['Alpha Facebook', 'beta Google', 'Gamma TikTok']);
    expect(names(await list('?sortBy=budget&sortDir=desc'))).toEqual(['Alpha Facebook', 'Gamma TikTok', 'beta Google']);
    expect(names(await list('?search=GOOGLE'))).toEqual(['beta Google']);
    expect(names(await list('?search=gamma-q'))).toEqual(['Gamma TikTok']);
    expect(names(await list('?search=CMP-1001'))).toEqual(['Alpha Facebook']);
    expect(names(await list('?status=RUNNING,SCHEDULED&sortBy=name&sortDir=asc'))).toEqual(['Alpha Facebook', 'beta Google']);
    expect(names(await list('?platform=TIKTOK'))).toEqual(['Gamma TikTok']);
    expect(names(await list(`?course=${course.id}`))).toEqual(['Alpha Facebook']);
    expect(names(await list(`?owner=${owner.id}`))).toEqual(['beta Google']);
    expect(names(await list('?startFrom=2026-10-01'))).toEqual(['beta Google']);
    for (const bad of ['?status=ARCHIVED', '?platform=TV', '?sortBy=leads', '?course=1', '?archived=0']) {
      expect((await list(bad)).status, bad).toBe(400);
    }
  });
});

describe('metrics', () => {
  it('derives counts from attributed, non-archived leads', async () => {
    const id = (await post(body({ status: 'RUNNING', budget: 10000, spent: 3000 }))).body.data.id;
    const other = (await post(body({ status: 'RUNNING' }))).body.data.id;
    for (const status of ['NEW', 'NEW', 'QUALIFIED', 'PAYMENT_PENDING', 'REGISTERED', 'LOST']) {
      await insertLead(admin.id, { campaign: id, status });
    }
    await insertLead(admin.id, { campaign: id, status: 'NEW', archivedAt: new Date() }); // excluded
    await insertLead(admin.id, { campaign: other, status: 'NEW' });
    await insertLead(admin.id, { status: 'NEW' }); // no campaign

    const detail = (await request(app).get(`/api/v1/campaigns/${id}`).set(admin.auth)).body.data.metrics;
    expect(detail).toMatchObject({
      leads: 6,
      qualifiedLeads: 3,
      registeredStudents: 1,
      lostLeads: 1,
      conversionRate: 0.1667,
      costPerLead: 500,
      budgetUsed: 0.3,
    });
    expect(detail.byStatus).toMatchObject({ NEW: 2, QUALIFIED: 1, PAYMENT_PENDING: 1, REGISTERED: 1, LOST: 1, CONTACTED: 0 });

    const listed = (await list('?sortBy=createdAt&sortDir=asc')).body.data;
    expect(listed.map((c: { metrics: { leads: number } }) => c.metrics.leads)).toEqual([6, 1]);
  });
});

describe('permissions', () => {
  it('matches the role matrix on every endpoint, with 403 for existing and nonexistent ids alike', async () => {
    const existing = (await post(body())).body.data.id;
    const matrix: Record<RoleKey, { read: number; write: number }> = {
      OWNER: { read: 200, write: 201 },
      ADMIN: { read: 200, write: 201 },
      MARKETING: { read: 200, write: 201 },
      VIEWER: { read: 200, write: 403 },
      SALES: { read: 403, write: 403 },
      HR: { read: 403, write: 403 },
      TRAINER: { read: 403, write: 403 },
    };
    for (const [role, expected] of Object.entries(matrix) as Array<[RoleKey, { read: number; write: number }]>) {
      const actor = role === 'ADMIN' ? admin : await signedInAs(app, role);
      const a = actor.auth;
      expect((await request(app).get('/api/v1/campaigns').set(a)).status, `${role} list`).toBe(expected.read);
      expect((await request(app).get(`/api/v1/campaigns/${existing}`).set(a)).status, `${role} get`).toBe(expected.read);
      expect((await post(body(), actor)).status, `${role} create`).toBe(expected.write);

      const writeOk = expected.write === 201;
      const id = writeOk ? (await post(body(), actor)).body.data.id : existing;
      expect((await request(app).patch(`/api/v1/campaigns/${id}`).set(a).send({ spent: 5 })).status, `${role} edit`).toBe(writeOk ? 200 : 403);
      expect((await request(app).patch(`/api/v1/campaigns/${id}/status`).set(a).send({ status: 'RUNNING' })).status, `${role} activate`).toBe(writeOk ? 200 : 403);
      expect((await request(app).patch(`/api/v1/campaigns/${id}/status`).set(a).send({ status: 'PAUSED' })).status, `${role} pause`).toBe(writeOk ? 200 : 403);
      expect((await request(app).post(`/api/v1/campaigns/${id}/archive`).set(a)).status, `${role} archive`).toBe(writeOk ? 200 : 403);
      expect((await request(app).post(`/api/v1/campaigns/${id}/restore`).set(a)).status, `${role} restore`).toBe(writeOk ? 200 : 403);

      if (expected.read === 403) {
        // Unauthorized callers cannot tell real ids from fake ones.
        const real = await request(app).get(`/api/v1/campaigns/${existing}`).set(a);
        const fake = await request(app).get(`/api/v1/campaigns/${MISSING_ID}`).set(a);
        expect(fake.status).toBe(real.status);
        expect(fake.body.code).toBe(real.body.code);
      }
    }
    expect((await request(app).get('/api/v1/campaigns')).status).toBe(401);
    expect((await request(app).get(`/api/v1/campaigns/${existing}`)).status).toBe(401);
  });
});
