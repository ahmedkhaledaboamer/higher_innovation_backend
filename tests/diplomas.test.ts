import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { Diploma } from '../src/modules/diplomas/diploma.model.js';
import { Enrollment } from '../src/modules/enrollments/enrollment.model.js';
import type { RoleKey } from '../src/modules/roles/permissions.js';
import { createCourse, createStudent } from './helpers/academy.js';
import { useTestDatabase } from './helpers/db.js';
import { signedInAs } from './helpers/factories.js';

useTestDatabase({ roles: true });

const app = createApp();
const MISSING_ID = '665f1c2e9b3e4a0012345678';
let admin: Awaited<ReturnType<typeof signedInAs>>;

beforeEach(async () => {
  admin = await signedInAs(app, 'ADMIN');
});

const post = (body: object) => request(app).post('/api/v1/diplomas').set(admin.auth).send(body);
const patch = (id: string, body: object) => request(app).patch(`/api/v1/diplomas/${id}`).set(admin.auth).send(body);
const list = (query = '') => request(app).get(`/api/v1/diplomas${query}`).set(admin.auth);
const diplomaBody = (overrides: Record<string, unknown> = {}) => ({
  name: `Diploma ${Math.random().toString(36).slice(2, 8)}`,
  level: 'PROFESSIONAL',
  ...overrides,
});

describe('POST /diplomas', () => {
  it('creates a diploma with an ordered course list (frontend courseIds[])', async () => {
    const [c1, c2] = [await createCourse(app, admin, { code: 'DA-101' }), await createCourse(app, admin, { code: 'ML-201' })];
    const res = await post({
      name: 'Data Analytics Diploma',
      level: 'ADVANCED',
      duration: '9 months',
      price: 42000,
      description: 'Analytics from spreadsheets to ML',
      courseIds: [c2.id, c1.id],
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      name: 'Data Analytics Diploma',
      level: 'ADVANCED',
      price: 42000,
      currency: 'AED',
      status: 'UPCOMING',
      courseIds: [c2.id, c1.id],
      courses: [
        { id: c2.id, code: 'ML-201', archived: false },
        { id: c1.id, code: 'DA-101', archived: false },
      ],
      coursesCount: 2,
      archived: false,
      createdBy: { id: admin.id },
    });
  });

  it('validates payload and course references', async () => {
    const course = await createCourse(app, admin);
    const archived = await createCourse(app, admin);
    await request(app).post(`/api/v1/courses/${archived.id}/archive`).set(admin.auth);

    const validation: Array<[object, string[]]> = [
      [{}, ['level', 'name']],
      [diplomaBody({ level: 'MASTER' }), ['level']],
      [diplomaBody({ price: 10.5 }), ['price']],
      [diplomaBody({ status: 'ARCHIVED' }), ['status']],
      [diplomaBody({ courseIds: ['nope'] }), ['courseIds.0']],
      [diplomaBody({ courseIds: [course.id, course.id] }), ['courseIds']],
    ];
    for (const [body, paths] of validation) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.errors.map((e: { path: string }) => e.path).sort()).toEqual([...paths].sort());
    }

    const missing = await post(diplomaBody({ courseIds: [course.id, MISSING_ID] }));
    expect(missing.status).toBe(400);
    expect(missing.body).toMatchObject({ code: 'COURSE_NOT_FOUND', errors: [{ path: 'courseIds.1', message: 'Course not found' }] });

    const withArchived = await post(diplomaBody({ courseIds: [archived.id] }));
    expect(withArchived.status).toBe(409);
    expect(withArchived.body.code).toBe('COURSE_ARCHIVED');
    expect(await Diploma.countDocuments()).toBe(0);
  });

  it('keeps names unique ignoring case and ignores server-managed fields', async () => {
    await post(diplomaBody({ name: 'Business Diploma' }));
    expect((await post(diplomaBody({ name: 'business DIPLOMA' }))).body.code).toBe('DIPLOMA_NAME_TAKEN');

    const res = await post(diplomaBody({ archivedAt: new Date().toISOString(), createdBy: MISSING_ID, courses: [MISSING_ID] }));
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ archived: false, courseIds: [], createdBy: { id: admin.id } });
  });
});

describe('many-to-many and course lifecycle', () => {
  it('a course can belong to several diplomas, and diplomas can be filtered by course', async () => {
    const shared = await createCourse(app, admin);
    const only = await createCourse(app, admin);
    const a = (await post(diplomaBody({ name: 'Alpha Diploma', courseIds: [shared.id, only.id] }))).body.data;
    const b = (await post(diplomaBody({ name: 'Beta Diploma', courseIds: [shared.id] }))).body.data;

    const withShared = await list(`?course=${shared.id}&sortBy=name&sortDir=asc`);
    expect(withShared.body.data.map((d: { id: string }) => d.id)).toEqual([a.id, b.id]);
    expect((await list(`?course=${only.id}`)).body.data.map((d: { id: string }) => d.id)).toEqual([a.id]);
  });

  it('keeps an archived course listed (flagged) but refuses to add newly archived ones', async () => {
    const kept = await createCourse(app, admin);
    const toAdd = await createCourse(app, admin);
    const diploma = (await post(diplomaBody({ courseIds: [kept.id] }))).body.data;

    await request(app).post(`/api/v1/courses/${kept.id}/archive`).set(admin.auth);
    await request(app).post(`/api/v1/courses/${toAdd.id}/archive`).set(admin.auth);

    const fetched = (await request(app).get(`/api/v1/diplomas/${diploma.id}`).set(admin.auth)).body.data;
    expect(fetched.courses).toEqual([expect.objectContaining({ id: kept.id, archived: true })]);

    // Re-saving with the already-included archived course is fine; adding another archived one is not.
    expect((await patch(diploma.id, { courseIds: [kept.id], description: 'Still listed' })).status).toBe(200);
    const added = await patch(diploma.id, { courseIds: [kept.id, toAdd.id] });
    expect(added.status).toBe(409);
    expect(added.body.errors).toEqual([{ path: 'courseIds.1', message: 'Archived courses cannot be added' }]);
  });

  it('replaces the course list on update, and never enrolls or charges anyone', async () => {
    const [c1, c2, c3] = [await createCourse(app, admin), await createCourse(app, admin), await createCourse(app, admin)];
    await createStudent(app, admin);
    const diploma = (await post(diplomaBody({ courseIds: [c1.id, c2.id] }))).body.data;

    const updated = await patch(diploma.id, { courseIds: [c3.id, c1.id], status: 'ACTIVE', price: 30000 });
    expect(updated.body.data).toMatchObject({ courseIds: [c3.id, c1.id], status: 'ACTIVE', price: 30000 });
    expect(await Enrollment.countDocuments()).toBe(0);

    expect((await patch(diploma.id, {})).status).toBe(400);
    expect((await patch(MISSING_ID, { price: 1 })).status).toBe(404);
  });
});

describe('archive, restore and list', () => {
  it('archives and restores; archived diplomas are read-only', async () => {
    const diploma = (await post(diplomaBody())).body.data;
    expect((await request(app).post(`/api/v1/diplomas/${diploma.id}/archive`).set(admin.auth)).body.data.archived).toBe(true);
    expect((await list()).body.meta.total).toBe(0);
    expect((await list('?archived=true')).body.meta.total).toBe(1);
    expect((await patch(diploma.id, { price: 1 })).body.code).toBe('DIPLOMA_ARCHIVED');
    expect((await request(app).post(`/api/v1/diplomas/${diploma.id}/archive`).set(admin.auth)).body.code).toBe('DIPLOMA_ALREADY_ARCHIVED');
    expect((await request(app).post(`/api/v1/diplomas/${diploma.id}/restore`).set(admin.auth)).body.data.archived).toBe(false);
    expect((await request(app).post(`/api/v1/diplomas/${diploma.id}/restore`).set(admin.auth)).body.code).toBe('DIPLOMA_NOT_ARCHIVED');
    expect((await request(app).post(`/api/v1/diplomas/${MISSING_ID}/archive`).set(admin.auth)).status).toBe(404);
    expect((await request(app).delete(`/api/v1/diplomas/${diploma.id}`).set(admin.auth)).status).toBe(404);
  });

  it('paginates, searches, filters and sorts', async () => {
    await post(diplomaBody({ name: 'Alpha Diploma', level: 'BEGINNER', status: 'ACTIVE', price: 100 }));
    await post(diplomaBody({ name: 'beta Diploma', level: 'ADVANCED', status: 'CLOSED', price: 300 }));
    await post(diplomaBody({ name: 'Gamma Program', level: 'ADVANCED', status: 'UPCOMING', price: 200 }));
    const names = (res: request.Response) => res.body.data.map((d: { name: string }) => d.name);

    expect((await list('?limit=2')).body.meta).toEqual({ page: 1, limit: 2, total: 3, totalPages: 2 });
    expect(names(await list('?sortBy=name&sortDir=asc'))).toEqual(['Alpha Diploma', 'beta Diploma', 'Gamma Program']);
    expect(names(await list('?sortBy=price&sortDir=desc'))).toEqual(['beta Diploma', 'Gamma Program', 'Alpha Diploma']);
    expect(names(await list('?search=diploma&sortBy=name&sortDir=asc'))).toEqual(['Alpha Diploma', 'beta Diploma']);
    expect(names(await list('?level=ADVANCED&status=CLOSED'))).toEqual(['beta Diploma']);
    for (const bad of ['?status=OPEN', '?level=X', '?course=1', '?sortBy=level']) {
      expect((await list(bad)).status, bad).toBe(400);
    }
  });
});

describe('permissions', () => {
  it('everyone with courses:read can read; only Owner/Admin can change', async () => {
    const diploma = (await post(diplomaBody())).body.data;
    const expected: Record<RoleKey, { read: number; write: number }> = {
      OWNER: { read: 200, write: 201 },
      ADMIN: { read: 200, write: 201 },
      MARKETING: { read: 200, write: 403 },
      SALES: { read: 200, write: 403 },
      TRAINER: { read: 200, write: 403 },
      VIEWER: { read: 200, write: 403 },
      HR: { read: 403, write: 403 },
    };
    for (const [role, codes] of Object.entries(expected) as Array<[RoleKey, { read: number; write: number }]>) {
      const actor = role === 'ADMIN' ? admin : await signedInAs(app, role);
      expect((await request(app).get('/api/v1/diplomas').set(actor.auth)).status, `${role} list`).toBe(codes.read);
      expect((await request(app).get(`/api/v1/diplomas/${diploma.id}`).set(actor.auth)).status, `${role} get`).toBe(codes.read);
      expect((await request(app).post('/api/v1/diplomas').set(actor.auth).send(diplomaBody())).status, `${role} create`).toBe(codes.write);
      if (codes.write === 403) {
        expect((await request(app).patch(`/api/v1/diplomas/${diploma.id}`).set(actor.auth).send({ price: 1 })).status).toBe(403);
        expect((await request(app).post(`/api/v1/diplomas/${diploma.id}/archive`).set(actor.auth)).status).toBe(403);
      }
    }
    expect((await request(app).get('/api/v1/diplomas')).status).toBe(401);
  });
});
