import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { TrainerAssignment } from '../src/modules/assignments/assignment.model.js';
import { Trainer } from '../src/modules/trainers/trainer.model.js';
import { assign, createCourse, createTrainer, trainerBody } from './helpers/academy.js';
import { useTestDatabase } from './helpers/db.js';
import { createUser, login, signedInAs } from './helpers/factories.js';

useTestDatabase({ roles: true });

const app = createApp();
const MISSING_ID = '665f1c2e9b3e4a0012345678';
let admin: Awaited<ReturnType<typeof signedInAs>>;

beforeEach(async () => {
  admin = await signedInAs(app, 'ADMIN');
});

const post = (body: object) => request(app).post('/api/v1/trainers').set(admin.auth).send(body);
const patch = (id: string, body: object) => request(app).patch(`/api/v1/trainers/${id}`).set(admin.auth).send(body);
const list = (query = '') => request(app).get(`/api/v1/trainers${query}`).set(admin.auth);
const names = (res: request.Response) => res.body.data.map((t: { fullName: string }) => t.fullName);

describe('POST /trainers', () => {
  it('creates a trainer profile with a sequential code and no credentials', async () => {
    const res = await post(
      trainerBody({
        fullName: 'Dr. Amina Farouk',
        email: 'Amina@Example.com',
        title: 'Lead Data Science Instructor',
        experienceYears: 15,
        weeklyCapacityHours: 20,
        joinDate: '2019-09-01',
        city: 'Dubai',
        country: 'United Arab Emirates',
        password: 'Should-be-ignored-1',
      }),
    );
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      code: 'TR-1001',
      fullName: 'Dr. Amina Farouk',
      email: 'amina@example.com',
      status: 'ACTIVE',
      experienceYears: 15,
      weeklyCapacityHours: 20,
      joinDate: '2019-09-01',
      user: null,
      openAssignments: 0,
      archived: false,
      bio: '',
    });
    expect(JSON.stringify(res.body)).not.toMatch(/password/i);
    const stored = await Trainer.findById(res.body.data.id).lean();
    expect(stored).not.toHaveProperty('password');
    expect(stored).not.toHaveProperty('passwordHash');
    expect((await post(trainerBody())).body.data.code).toBe('TR-1002');
  });

  it('validates the payload and keeps emails unique', async () => {
    const cases: Array<[object, string[]]> = [
      [{}, ['email', 'fullName']],
      [trainerBody({ email: 'nope' }), ['email']],
      [trainerBody({ status: 'RETIRED' }), ['status']],
      [trainerBody({ experienceYears: -1, weeklyCapacityHours: 200 }), ['experienceYears', 'weeklyCapacityHours']],
      [trainerBody({ joinDate: '01/09/2019' }), ['joinDate']],
      [trainerBody({ userId: 'x' }), ['userId']],
    ];
    for (const [body, paths] of cases) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.errors.map((e: { path: string }) => e.path).sort()).toEqual([...paths].sort());
    }
    await post(trainerBody({ email: 'same@example.com' }));
    expect((await post(trainerBody({ email: 'SAME@example.com' }))).body.code).toBe('TRAINER_EMAIL_TAKEN');
  });

  it('links only existing, non-inactive TRAINER-role users, one profile each', async () => {
    const trainerUser = await createUser({ role: 'TRAINER' });
    const linked = await post(trainerBody({ userId: trainerUser.id }));
    expect(linked.status).toBe(201);
    expect(linked.body.data.user).toMatchObject({ id: trainerUser.id, email: trainerUser.email });

    const cases: Array<[string, number, string]> = [
      [trainerUser.id, 409, 'TRAINER_USER_TAKEN'],
      [MISSING_ID, 400, 'USER_NOT_FOUND'],
      [(await createUser({ role: 'SALES' })).id, 400, 'USER_ROLE_NOT_TRAINER'],
      [(await createUser({ role: 'TRAINER', status: 'INACTIVE' })).id, 400, 'USER_INACTIVE'],
    ];
    for (const [userId, status, code] of cases) {
      const res = await post(trainerBody({ userId }));
      expect(res.status, code).toBe(status);
      expect(res.body.code).toBe(code);
    }
  });

  it('ignores server-managed fields', async () => {
    const res = await post(trainerBody({ code: 'TR-0001', openAssignments: 7, archivedAt: new Date().toISOString(), createdBy: MISSING_ID }));
    expect(res.body.data).toMatchObject({ code: 'TR-1001', openAssignments: 0, archived: false, createdBy: { id: admin.id } });
  });
});

describe('PATCH /trainers/:id', () => {
  it('updates fields, links and unlinks a user', async () => {
    const trainer = await createTrainer(app, admin);
    const user = await createUser({ role: 'TRAINER' });
    const res = await patch(trainer.id, { status: 'ON_LEAVE', city: 'Abu Dhabi', userId: user.id, openAssignments: 3 });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'ON_LEAVE', city: 'Abu Dhabi', user: { id: user.id }, openAssignments: 0 });
    expect((await patch(trainer.id, { userId: null })).body.data.user).toBeNull();
  });

  it('rejects empty bodies, duplicate emails and unknown trainers', async () => {
    const a = await createTrainer(app, admin, { email: 'a.trainer@example.com' });
    const b = await createTrainer(app, admin);
    expect((await patch(b.id, {})).status).toBe(400);
    expect((await patch(b.id, { email: 'a.trainer@example.com' })).body.code).toBe('TRAINER_EMAIL_TAKEN');
    expect((await patch(a.id, { email: 'a.trainer@example.com' })).status).toBe(200);
    expect((await patch(MISSING_ID, { city: 'Dubai' })).status).toBe(404);
    expect((await request(app).get('/api/v1/trainers/bad').set(admin.auth)).status).toBe(400);
  });
});

describe('archive and restore', () => {
  it('ends open assignments (kept as history), blocks edits and new assignments, and restores without reopening', async () => {
    const trainer = await createTrainer(app, admin);
    const course = await createCourse(app, admin);
    const assignmentId = (await assign(app, admin, { trainerId: trainer.id, courseId: course.id })).body.data.id;

    const archived = await request(app).post(`/api/v1/trainers/${trainer.id}/archive`).set(admin.auth);
    expect(archived.status).toBe(200);
    expect(archived.body.data).toMatchObject({ archived: true, openAssignments: 0 });

    const assignment = await TrainerAssignment.findById(assignmentId).lean();
    expect(assignment).toMatchObject({ status: 'CANCELLED', isOpen: false, endedReason: 'TRAINER_ARCHIVED' });
    expect((await request(app).get(`/api/v1/courses/${course.id}`).set(admin.auth)).status).toBe(200);
    const { Course } = await import('../src/modules/courses/course.model.js');
    expect((await Course.findById(course.id).lean())!.openAssignments).toBe(0);

    expect(names(await list())).toEqual([]);
    expect((await list('?archived=true')).body.meta.total).toBe(1);
    expect((await patch(trainer.id, { city: 'Dubai' })).body.code).toBe('TRAINER_ARCHIVED');
    expect((await assign(app, admin, { trainerId: trainer.id, courseId: course.id })).body.code).toBe('TRAINER_ARCHIVED');
    expect((await request(app).post(`/api/v1/trainers/${trainer.id}/archive`).set(admin.auth)).body.code).toBe('TRAINER_ALREADY_ARCHIVED');

    const restored = await request(app).post(`/api/v1/trainers/${trainer.id}/restore`).set(admin.auth);
    expect(restored.body.data).toMatchObject({ archived: false, openAssignments: 0 });
    expect((await TrainerAssignment.findById(assignmentId).lean())!.isOpen).toBe(false);
    expect((await request(app).post(`/api/v1/trainers/${trainer.id}/restore`).set(admin.auth)).body.code).toBe('TRAINER_NOT_ARCHIVED');
    expect((await request(app).delete(`/api/v1/trainers/${trainer.id}`).set(admin.auth)).status).toBe(404);
  });

  it('returns 404 for unknown trainers', async () => {
    expect((await request(app).post(`/api/v1/trainers/${MISSING_ID}/archive`).set(admin.auth)).status).toBe(404);
    expect((await request(app).post(`/api/v1/trainers/${MISSING_ID}/restore`).set(admin.auth)).status).toBe(404);
  });
});

describe('GET /trainers (list)', () => {
  it('paginates, sorts, searches and filters', async () => {
    const course = await createCourse(app, admin);
    const amina = await createTrainer(app, admin, { fullName: 'Amina Farouk', specialization: 'Data & Analytics', status: 'ACTIVE' });
    await createTrainer(app, admin, { fullName: 'basel Haddad', specialization: 'Design', status: 'ON_LEAVE', title: 'UX Lead' });
    await createTrainer(app, admin, { fullName: 'Carla Mansour', specialization: 'data & analytics', status: 'INACTIVE' });
    await assign(app, admin, { trainerId: amina.id, courseId: course.id });

    const page = await list('?limit=2');
    expect(page.body.meta).toEqual({ page: 1, limit: 2, total: 3, totalPages: 2 });
    expect(names(page)).toEqual(['Amina Farouk', 'basel Haddad']);
    expect(names(await list('?sortBy=code&sortDir=desc'))).toEqual(['Carla Mansour', 'basel Haddad', 'Amina Farouk']);
    expect(names(await list('?search=ux lead'))).toEqual(['basel Haddad']);
    expect(names(await list('?search=TR-1001'))).toEqual(['Amina Farouk']);
    expect(names(await list('?status=ACTIVE,ON_LEAVE'))).toEqual(['Amina Farouk', 'basel Haddad']);
    expect(names(await list('?specialization=DATA %26 ANALYTICS'))).toEqual(['Amina Farouk', 'Carla Mansour']);
    expect(names(await list(`?course=${course.id}`))).toEqual(['Amina Farouk']);
    expect((await list()).body.data[0].openAssignments).toBe(1);
    for (const bad of ['?status=RETIRED', '?course=x', '?sortBy=email', '?archived=no']) {
      expect((await list(bad)).status, bad).toBe(400);
    }
  });
});

describe('permissions', () => {
  it('Owner/Admin write; HR and Viewer read; others cannot list trainers', async () => {
    const trainer = await createTrainer(app, admin);
    for (const role of ['OWNER', 'ADMIN'] as const) {
      const actor = role === 'ADMIN' ? admin : await signedInAs(app, role);
      expect((await request(app).post('/api/v1/trainers').set(actor.auth).send(trainerBody())).status, role).toBe(201);
    }
    for (const role of ['HR', 'VIEWER'] as const) {
      const actor = await signedInAs(app, role);
      expect((await request(app).get('/api/v1/trainers').set(actor.auth)).status, role).toBe(200);
      expect((await request(app).get(`/api/v1/trainers/${trainer.id}`).set(actor.auth)).status, role).toBe(200);
      expect((await request(app).post('/api/v1/trainers').set(actor.auth).send(trainerBody())).status, role).toBe(403);
      expect((await request(app).patch(`/api/v1/trainers/${trainer.id}`).set(actor.auth).send({ city: 'X City' })).status).toBe(403);
      expect((await request(app).post(`/api/v1/trainers/${trainer.id}/archive`).set(actor.auth)).status).toBe(403);
    }
    for (const role of ['SALES', 'MARKETING', 'TRAINER'] as const) {
      const actor = await signedInAs(app, role);
      expect((await request(app).get('/api/v1/trainers').set(actor.auth)).status, role).toBe(403);
      expect((await request(app).get(`/api/v1/trainers/${trainer.id}`).set(actor.auth)).status, role).toBe(403);
    }
    expect((await request(app).get('/api/v1/trainers')).status).toBe(401);
  });

  it('GET /trainers/me returns the caller\'s own profile only', async () => {
    const user = await createUser({ role: 'TRAINER' });
    const session = await login(app, user.email);
    const missing = await request(app).get('/api/v1/trainers/me').set(session.auth);
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('TRAINER_PROFILE_NOT_FOUND');

    const profile = await createTrainer(app, admin, { userId: user.id });
    const me = await request(app).get('/api/v1/trainers/me').set(session.auth);
    expect(me.body.data.id).toBe(profile.id);

    for (const role of ['SALES', 'VIEWER', 'HR'] as const) {
      const actor = await signedInAs(app, role);
      expect((await request(app).get('/api/v1/trainers/me').set(actor.auth)).status, role).toBe(403);
    }
  });
});
