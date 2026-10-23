import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { Course } from '../src/modules/courses/course.model.js';
import { courseBody, createCourse, createStudent, enroll } from './helpers/academy.js';
import { useTestDatabase } from './helpers/db.js';
import { signedInAs } from './helpers/factories.js';

useTestDatabase({ roles: true });

const app = createApp();
const MISSING_ID = '665f1c2e9b3e4a0012345678';
let admin: Awaited<ReturnType<typeof signedInAs>>;

beforeEach(async () => {
  admin = await signedInAs(app, 'ADMIN');
});

const post = (body: object) => request(app).post('/api/v1/courses').set(admin.auth).send(body);
const patch = (id: string, body: object) => request(app).patch(`/api/v1/courses/${id}`).set(admin.auth).send(body);
const list = (query = '') => request(app).get(`/api/v1/courses${query}`).set(admin.auth);
const codes = (res: request.Response) => res.body.data.map((c: { code: string }) => c.code);

describe('POST /courses', () => {
  it('creates a course with defaults and normalised code', async () => {
    const res = await post({
      code: ' da-101 ',
      name: 'Data Analytics',
      level: 'INTERMEDIATE',
      price: 18500,
      seats: 30,
      duration: '16 weeks · 2 evenings/week',
      hours: 96,
      startDate: '2026-11-01',
      endDate: '2027-02-28',
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      code: 'DA-101',
      name: 'Data Analytics',
      level: 'INTERMEDIATE',
      price: 18500,
      seats: 30,
      enrolledCount: 0,
      seatsAvailable: 30,
      status: 'DRAFT',
      enrollable: false,
      archived: false,
      description: '',
      startDate: '2026-11-01T00:00:00.000Z',
      createdBy: { id: admin.id },
    });
  });

  it('validates the payload', async () => {
    const cases: Array<[object, string[]]> = [
      [{}, ['code', 'level', 'name', 'price']],
      [courseBody({ code: 'x' }), ['code']],
      [courseBody({ code: 'DA 101!' }), ['code']],
      [courseBody({ level: 'EXPERT' }), ['level']],
      [courseBody({ price: -1 }), ['price']],
      [courseBody({ price: 99.5 }), ['price']],
      [courseBody({ seats: 0 }), ['seats']],
      [courseBody({ status: 'ARCHIVED' }), ['status']],
      [courseBody({ startDate: 'soon' }), ['startDate']],
      [courseBody({ startDate: '2026-12-01', endDate: '2026-11-01' }), ['endDate']],
    ];
    for (const [body, paths] of cases) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.errors.map((e: { path: string }) => e.path).sort()).toEqual([...paths].sort());
    }
    expect(await Course.countDocuments()).toBe(0);
  });

  it('keeps codes unique, case-insensitively', async () => {
    await post(courseBody({ code: 'AI-210' }));
    const duplicate = await post(courseBody({ code: 'ai-210' }));
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe('COURSE_CODE_TAKEN');
  });

  it('ignores server-managed fields', async () => {
    const res = await post(
      courseBody({ enrolledCount: 25, archivedAt: new Date().toISOString(), createdBy: MISSING_ID, seatsAvailable: 1 }),
    );
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ enrolledCount: 0, archived: false, createdBy: { id: admin.id } });
  });
});

describe('GET /courses/:id', () => {
  it('returns 404 for unknown and 400 for malformed ids', async () => {
    const course = await createCourse(app, admin);
    expect((await request(app).get(`/api/v1/courses/${course.id}`).set(admin.auth)).body.data.code).toBe(course.code);
    expect((await request(app).get(`/api/v1/courses/${MISSING_ID}`).set(admin.auth)).body.code).toBe('COURSE_NOT_FOUND');
    expect((await request(app).get('/api/v1/courses/nope').set(admin.auth)).status).toBe(400);
  });
});

describe('PATCH /courses/:id', () => {
  it('updates fields and ignores enrolledCount', async () => {
    const course = await createCourse(app, admin, { seats: 20 });
    const res = await patch(course.id, { name: 'Renamed', price: 9000, seats: 25, enrolledCount: 99, description: 'New' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ name: 'Renamed', price: 9000, seats: 25, enrolledCount: 0, description: 'New' });
  });

  it('checks dates against the stored values', async () => {
    const course = await createCourse(app, admin, { startDate: '2026-11-01' });
    const res = await patch(course.id, { endDate: '2026-10-01' });
    expect(res.status).toBe(400);
    expect(res.body.errors[0].path).toBe('endDate');
  });

  it('refuses seats below the enrolled count and DRAFT once students are enrolled', async () => {
    const course = await createCourse(app, admin, { seats: 5 });
    for (let i = 0; i < 2; i += 1) {
      const student = await createStudent(app, admin);
      expect((await enroll(app, admin, student.id, { courseId: course.id })).status).toBe(201);
    }

    const seats = await patch(course.id, { seats: 1 });
    expect(seats.status).toBe(409);
    expect(seats.body).toMatchObject({ code: 'SEATS_BELOW_ENROLLED', errors: [{ path: 'seats', message: 'Must be at least 2' }] });
    expect((await patch(course.id, { seats: 2 })).status).toBe(200);

    const draft = await patch(course.id, { status: 'DRAFT' });
    expect(draft.status).toBe(409);
    expect(draft.body.code).toBe('COURSE_HAS_ENROLLMENTS');
    expect((await Course.findById(course.id).lean())!.status).toBe('ACTIVE');
  });

  it('rejects empty bodies, duplicate codes and unknown courses', async () => {
    const a = await createCourse(app, admin, { code: 'AA-1' });
    const b = await createCourse(app, admin);
    expect((await patch(b.id, {})).status).toBe(400);
    expect((await patch(b.id, { code: 'aa-1' })).body.code).toBe('COURSE_CODE_TAKEN');
    expect((await patch(a.id, { code: 'AA-1', name: 'Same code is fine' })).status).toBe(200);
    expect((await patch(MISSING_ID, { name: 'Nobody' })).status).toBe(404);
  });
});

describe('archive and restore', () => {
  it('hides archived courses, makes them read-only and closes enrollment', async () => {
    const course = await createCourse(app, admin);
    const student = await createStudent(app, admin);

    const archived = await request(app).post(`/api/v1/courses/${course.id}/archive`).set(admin.auth);
    expect(archived.body.data).toMatchObject({ archived: true, enrollable: false });
    expect(codes(await list())).toEqual([]);
    expect(codes(await list('?archived=true'))).toEqual([course.code]);

    expect((await patch(course.id, { name: 'New name' })).body.code).toBe('COURSE_ARCHIVED');
    expect((await enroll(app, admin, student.id, { courseId: course.id })).body.code).toBe('COURSE_ARCHIVED');
    expect((await request(app).post(`/api/v1/courses/${course.id}/archive`).set(admin.auth)).body.code).toBe(
      'COURSE_ALREADY_ARCHIVED',
    );

    const restored = await request(app).post(`/api/v1/courses/${course.id}/restore`).set(admin.auth);
    expect(restored.body.data.archived).toBe(false);
    expect((await request(app).post(`/api/v1/courses/${course.id}/restore`).set(admin.auth)).body.code).toBe(
      'COURSE_NOT_ARCHIVED',
    );
    expect((await request(app).delete(`/api/v1/courses/${course.id}`).set(admin.auth)).status).toBe(404);
  });

  it('returns 404 for unknown courses', async () => {
    expect((await request(app).post(`/api/v1/courses/${MISSING_ID}/archive`).set(admin.auth)).status).toBe(404);
    expect((await request(app).post(`/api/v1/courses/${MISSING_ID}/restore`).set(admin.auth)).status).toBe(404);
  });
});

describe('GET /courses (list)', () => {
  async function seed() {
    await createCourse(app, admin, { code: 'WEB-1', name: 'Web Development', level: 'BEGINNER', status: 'ACTIVE', price: 9000, startDate: '2026-11-01' });
    await createCourse(app, admin, { code: 'AI-2', name: 'applied AI', level: 'ADVANCED', status: 'UPCOMING', price: 20000, startDate: '2027-01-15' });
    await createCourse(app, admin, { code: 'HR-3', name: 'HR Basics', level: 'FOUNDATION', status: 'DRAFT', price: 5000 });
    const full = await createCourse(app, admin, { code: 'FULL-4', name: 'Tiny Class', level: 'BEGINNER', status: 'ACTIVE', seats: 1, price: 100 });
    const student = await createStudent(app, admin);
    await enroll(app, admin, student.id, { courseId: full.id });
  }

  it('paginates and sorts', async () => {
    await seed();
    const page = await list('?limit=2&sortBy=code&sortDir=asc');
    expect(page.body.meta).toEqual({ page: 1, limit: 2, total: 4, totalPages: 2 });
    expect(codes(page)).toEqual(['AI-2', 'FULL-4']);
    expect(codes(await list('?sortBy=name&sortDir=asc'))).toEqual(['AI-2', 'HR-3', 'FULL-4', 'WEB-1']);
    expect(codes(await list('?sortBy=price&sortDir=desc'))).toEqual(['AI-2', 'WEB-1', 'HR-3', 'FULL-4']);
    expect((await list('?sortBy=enrolledCount')).status).toBe(400);
  });

  it('searches and filters', async () => {
    await seed();
    const sorted = async (query: string) => codes(await list(`${query}&sortBy=code&sortDir=asc`));
    expect(await sorted('?search=ai')).toEqual(['AI-2']);
    expect(await sorted('?search=web-')).toEqual(['WEB-1']);
    expect(await sorted('?status=ACTIVE,UPCOMING')).toEqual(['AI-2', 'FULL-4', 'WEB-1']);
    expect(await sorted('?level=BEGINNER')).toEqual(['FULL-4', 'WEB-1']);
    expect(await sorted('?startFrom=2026-12-01')).toEqual(['AI-2']);
    // Open for enrollment: UPCOMING/ACTIVE with a free seat. FULL-4 is full, HR-3 is a draft.
    expect(await sorted('?enrollable=true')).toEqual(['AI-2', 'WEB-1']);
    expect(await sorted('?enrollable=false')).toEqual(['FULL-4', 'HR-3']);
    for (const bad of ['?status=OPEN', '?level=GOD', '?enrollable=yes', '?startFrom=x']) {
      expect((await list(bad)).status, bad).toBe(400);
    }
  });
});
