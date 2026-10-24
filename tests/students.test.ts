import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/createApp.js';
import { Student } from '../src/modules/students/student.model.js';
import { createCourse, createStudent, enroll, setEnrollmentStatus, studentBody } from './helpers/academy.js';
import { useTestDatabase } from './helpers/db.js';
import { createUser, signedInAs } from './helpers/factories.js';

useTestDatabase({ roles: true });

const app = createApp();
const MISSING_ID = '665f1c2e9b3e4a0012345678';
let admin: Awaited<ReturnType<typeof signedInAs>>;

beforeEach(async () => {
  admin = await signedInAs(app, 'ADMIN');
});

const post = (body: object) => request(app).post('/api/v1/students').set(admin.auth).send(body);
const patch = (id: string, body: object) => request(app).patch(`/api/v1/students/${id}`).set(admin.auth).send(body);
const advisor = (id: string, body: object) =>
  request(app).patch(`/api/v1/students/${id}/advisor`).set(admin.auth).send(body);
const archive = (id: string) => request(app).post(`/api/v1/students/${id}/archive`).set(admin.auth);
const restore = (id: string) => request(app).post(`/api/v1/students/${id}/restore`).set(admin.auth);
const list = (query = '') => request(app).get(`/api/v1/students${query}`).set(admin.auth);
const names = (res: request.Response) => res.body.data.map((s: { fullName: string }) => s.fullName);

describe('POST /students', () => {
  it('creates a student with a sequential student number', async () => {
    const res = await post(studentBody({ fullName: 'Omar Fathy', dateOfBirth: '1998-04-12', city: 'Giza' }));
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      studentNumber: 'ST-1001',
      fullName: 'Omar Fathy',
      dateOfBirth: '1998-04-12',
      city: 'Giza',
      status: 'ACTIVE',
      advisor: null,
      activeEnrollments: 0,
      archived: false,
      createdBy: { id: admin.id },
    });
    expect((await post(studentBody())).body.data.studentNumber).toBe('ST-1002');
  });

  it('validates the payload', async () => {
    const cases: Array<[object, string[]]> = [
      [{}, ['fullName']],
      [{ fullName: 'No Contact' }, ['phone']],
      [studentBody({ email: 'bad' }), ['email']],
      [studentBody({ phone: 'abc' }), ['phone']],
      [studentBody({ dateOfBirth: '2999-01-01' }), ['dateOfBirth']],
      [studentBody({ dateOfBirth: '12/04/1998' }), ['dateOfBirth']],
      [studentBody({ status: 'EXPELLED' }), ['status']],
      [studentBody({ advisor: 'nope' }), ['advisor']],
    ];
    for (const [body, paths] of cases) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.errors.map((e: { path: string }) => e.path).sort()).toEqual([...paths].sort());
    }
    expect(await Student.countDocuments()).toBe(0);
  });

  it('ignores server-managed fields', async () => {
    const res = await post(
      studentBody({ studentNumber: 'ST-0001', activeEnrollments: 9, archivedAt: new Date().toISOString(), createdBy: MISSING_ID, lead: MISSING_ID }),
    );
    expect(res.body.data).toMatchObject({ studentNumber: 'ST-1001', activeEnrollments: 0, archived: false });
    expect(res.body.data.createdBy.id).toBe(admin.id);
    expect(res.body.data.lead).toBeUndefined();
  });

  it('rejects duplicate email or phone unless a manager overrides', async () => {
    const first = await createStudent(app, admin, { email: 'sara@example.com', phone: '+20 122 000 1111' });
    const sameEmail = await post(studentBody({ email: 'SARA@example.com' }));
    expect(sameEmail.status).toBe(409);
    expect(sameEmail.body.errors).toEqual([{ path: 'email', message: `Matches student ${first.studentNumber}` }]);
    expect((await post(studentBody({ phone: '0020 1220001111' }))).body.code).toBe('DUPLICATE_STUDENT');
    expect((await post(studentBody({ email: 'sara@example.com', allowDuplicate: true }))).status).toBe(201);
  });
});

describe('GET /students/:id', () => {
  it('returns 404 for unknown and 400 for malformed ids', async () => {
    const student = await createStudent(app, admin);
    expect((await request(app).get(`/api/v1/students/${student.id}`).set(admin.auth)).status).toBe(200);
    expect((await request(app).get(`/api/v1/students/${MISSING_ID}`).set(admin.auth)).body.code).toBe('STUDENT_NOT_FOUND');
    expect((await request(app).get('/api/v1/students/123').set(admin.auth)).status).toBe(400);
  });
});

describe('PATCH /students/:id', () => {
  it('updates profile and status, ignoring protected fields', async () => {
    const sales = await createUser({ role: 'SALES' });
    const student = await createStudent(app, admin);
    const res = await patch(student.id, {
      fullName: 'New Name',
      status: 'GRADUATED',
      city: '',
      advisor: sales.id,
      studentNumber: 'ST-9',
      activeEnrollments: 5,
    });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      fullName: 'New Name',
      status: 'GRADUATED',
      city: null,
      advisor: null,
      studentNumber: student.studentNumber,
      activeEnrollments: 0,
    });
  });

  it('keeps a contact method, rejects duplicates and empty bodies', async () => {
    const a = await createStudent(app, admin, { email: 'a@example.com' });
    const b = await createStudent(app, admin, { email: 'b@example.com', phone: null });
    expect((await patch(b.id, { email: null })).body.errors[0].path).toBe('phone');
    expect((await patch(b.id, { email: 'a@example.com' })).body.code).toBe('DUPLICATE_STUDENT');
    expect((await patch(b.id, {})).status).toBe(400);
    expect((await patch(a.id, { email: 'a@example.com' })).status).toBe(200);
    expect((await patch(MISSING_ID, { city: 'Cairo' })).status).toBe(404);
  });
});

describe('PATCH /students/:id/advisor', () => {
  it('sets, changes and removes the advisor with validation', async () => {
    const student = await createStudent(app, admin);
    const salesA = await createUser({ role: 'SALES' });
    const salesB = await createUser({ role: 'SALES' });

    expect((await advisor(student.id, { advisor: salesA.id })).body.data.advisor.id).toBe(salesA.id);
    expect((await advisor(student.id, { advisor: salesB.id })).body.data.advisor.id).toBe(salesB.id);
    expect((await advisor(student.id, { advisor: null })).body.data.advisor).toBeNull();

    const cases: Array<[string, string]> = [
      [MISSING_ID, 'ADVISOR_NOT_FOUND'],
      [(await createUser({ role: 'SALES', status: 'SUSPENDED' })).id, 'ADVISOR_INACTIVE'],
      [(await createUser({ role: 'VIEWER' })).id, 'ADVISOR_ROLE_NOT_ALLOWED'],
      [(await createUser({ role: 'TRAINER' })).id, 'ADVISOR_ROLE_NOT_ALLOWED'],
    ];
    for (const [id, code] of cases) {
      const res = await advisor(student.id, { advisor: id });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe(code);
    }
    expect((await advisor(student.id, {})).status).toBe(400);
    expect((await advisor(MISSING_ID, { advisor: salesA.id })).status).toBe(404);
  });
});

describe('archive and restore', () => {
  it('requires withdrawing active enrollments first', async () => {
    const student = await createStudent(app, admin);
    const course = await createCourse(app, admin);
    const enrollment = (await enroll(app, admin, student.id, { courseId: course.id })).body.data;

    const blocked = await archive(student.id);
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('STUDENT_HAS_ACTIVE_ENROLLMENTS');

    await setEnrollmentStatus(app, admin, enrollment.id, 'WITHDRAWN');
    const archived = await archive(student.id);
    expect(archived.status).toBe(200);
    expect(archived.body.data.archived).toBe(true);

    expect(names(await list())).toEqual([]);
    expect((await list('?archived=true')).body.meta.total).toBe(1);
    expect((await patch(student.id, { city: 'Cairo' })).body.code).toBe('STUDENT_ARCHIVED');
    expect((await enroll(app, admin, student.id, { courseId: (await createCourse(app, admin)).id })).body.code).toBe(
      'STUDENT_ARCHIVED',
    );
    // Re-joining the old course is blocked too while archived.
    expect((await setEnrollmentStatus(app, admin, enrollment.id, 'IN_PROGRESS')).body.code).toBe('STUDENT_ARCHIVED');
    expect((await archive(student.id)).body.code).toBe('STUDENT_ALREADY_ARCHIVED');

    expect((await restore(student.id)).body.data.archived).toBe(false);
    expect((await restore(student.id)).body.code).toBe('STUDENT_NOT_ARCHIVED');
    expect((await request(app).delete(`/api/v1/students/${student.id}`).set(admin.auth)).status).toBe(404);
  });

  it('returns 404 for unknown students', async () => {
    expect((await archive(MISSING_ID)).status).toBe(404);
    expect((await restore(MISSING_ID)).status).toBe(404);
  });
});

describe('GET /students (list)', () => {
  it('paginates, sorts, searches and filters', async () => {
    const sales = await createUser({ role: 'SALES' });
    const course = await createCourse(app, admin);
    const omar = await createStudent(app, admin, { fullName: 'Omar Ali', email: 'omar@example.com', phone: '+20 111 222 3333', country: 'Egypt', advisor: sales.id });
    await createStudent(app, admin, { fullName: 'laila Hassan', country: 'Jordan', status: 'PENDING' });
    await createStudent(app, admin, { fullName: 'Ziad Kamal', country: 'egypt', status: 'GRADUATED' });
    await enroll(app, admin, omar.id, { courseId: course.id });

    const page = await list('?limit=2&sortBy=fullName&sortDir=asc');
    expect(page.body.meta).toEqual({ page: 1, limit: 2, total: 3, totalPages: 2 });
    expect(names(page)).toEqual(['laila Hassan', 'Omar Ali']);
    expect(names(await list('?sortBy=studentNumber&sortDir=desc'))).toEqual(['Ziad Kamal', 'laila Hassan', 'Omar Ali']);

    const sorted = async (query: string) => names(await list(`${query}&sortBy=fullName&sortDir=asc`));
    expect(await sorted('?search=omar%40')).toEqual(['Omar Ali']);
    expect(await sorted('?search=222 3333')).toEqual(['Omar Ali']);
    expect(await sorted(`?search=${omar.studentNumber}`)).toEqual(['Omar Ali']);
    expect(await sorted('?status=PENDING,GRADUATED')).toEqual(['laila Hassan', 'Ziad Kamal']);
    expect(await sorted('?country=EGYPT')).toEqual(['Omar Ali', 'Ziad Kamal']);
    expect(await sorted(`?advisor=${sales.id}`)).toEqual(['Omar Ali']);
    expect(await sorted('?advisor=unassigned')).toEqual(['laila Hassan', 'Ziad Kamal']);
    expect(await sorted(`?course=${course.id}`)).toEqual(['Omar Ali']);

    for (const bad of ['?status=GONE', '?advisor=x', '?course=1', '?sortBy=email', '?archived=1']) {
      expect((await list(bad)).status, bad).toBe(400);
    }
  });
});
