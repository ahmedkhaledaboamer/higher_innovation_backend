import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/createApp.js';
import { Course } from '../src/modules/courses/course.model.js';
import { Enrollment } from '../src/modules/enrollments/enrollment.model.js';
import { Student } from '../src/modules/students/student.model.js';
import { createCourse, createStudent, enroll, setEnrollmentStatus } from './helpers/academy.js';
import { useTestDatabase } from './helpers/db.js';
import { signedInAs } from './helpers/factories.js';

useTestDatabase({ roles: true });

const app = createApp();
const MISSING_ID = '665f1c2e9b3e4a0012345678';
let admin: Awaited<ReturnType<typeof signedInAs>>;

beforeEach(async () => {
  admin = await signedInAs(app, 'ADMIN');
});

const counters = async (courseId: string, studentId: string) => ({
  enrolledCount: (await Course.findById(courseId).lean())!.enrolledCount,
  activeEnrollments: (await Student.findById(studentId).lean())!.activeEnrollments,
});

describe('POST /students/:id/enrollments', () => {
  it('enrolls a student, snapshots the price and updates both counters', async () => {
    const course = await createCourse(app, admin, { price: 18500, seats: 10 });
    const student = await createStudent(app, admin);

    const res = await enroll(app, admin, student.id, { courseId: course.id });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      student: { id: student.id, studentNumber: student.studentNumber },
      course: { id: course.id, code: course.code },
      status: 'NOT_STARTED',
      price: 18500,
      enrolledBy: { id: admin.id },
      completedAt: null,
      withdrawnAt: null,
    });
    expect(await counters(course.id, student.id)).toEqual({ enrolledCount: 1, activeEnrollments: 1 });

    // A later price change does not touch the existing enrollment.
    await request(app).patch(`/api/v1/courses/${course.id}`).set(admin.auth).send({ price: 25000 });
    const reread = await request(app).get(`/api/v1/enrollments/${res.body.data.id}`).set(admin.auth);
    expect(reread.body.data.price).toBe(18500);
  });

  it('accepts a past enrolledAt but not a future one, and ignores server-managed fields', async () => {
    const course = await createCourse(app, admin);
    const student = await createStudent(app, admin);
    const future = await enroll(app, admin, student.id, { courseId: course.id, enrolledAt: '2999-01-01' });
    expect(future.status).toBe(400);

    const res = await enroll(app, admin, student.id, {
      courseId: course.id,
      enrolledAt: '2026-09-01T08:00:00Z',
      status: 'COMPLETED',
      price: 1,
      enrolledBy: MISSING_ID,
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ enrolledAt: '2026-09-01T08:00:00.000Z', status: 'NOT_STARTED', price: course.price });
    expect(res.body.data.enrolledBy.id).toBe(admin.id);
  });

  it('prevents duplicate enrollments, including after withdrawing', async () => {
    const course = await createCourse(app, admin);
    const student = await createStudent(app, admin);
    const first = await enroll(app, admin, student.id, { courseId: course.id });

    const again = await enroll(app, admin, student.id, { courseId: course.id });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('ENROLLMENT_EXISTS');
    expect(again.body.errors[0].message).toContain(first.body.data.id);

    await setEnrollmentStatus(app, admin, first.body.data.id, 'WITHDRAWN');
    const afterWithdraw = await enroll(app, admin, student.id, { courseId: course.id });
    expect(afterWithdraw.status).toBe(409);
    expect(afterWithdraw.body.message).toMatch(/re-enroll/);

    expect(await Enrollment.countDocuments()).toBe(1);
    expect(await counters(course.id, student.id)).toEqual({ enrolledCount: 0, activeEnrollments: 0 });
  });

  it('enforces the unique index even when two requests race', async () => {
    const course = await createCourse(app, admin);
    const student = await createStudent(app, admin);
    const results = await Promise.all([
      enroll(app, admin, student.id, { courseId: course.id }),
      enroll(app, admin, student.id, { courseId: course.id }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await Enrollment.countDocuments()).toBe(1);
    expect(await counters(course.id, student.id)).toEqual({ enrolledCount: 1, activeEnrollments: 1 });
  });

  it('rejects missing, archived, draft and full courses without changing counters', async () => {
    const student = await createStudent(app, admin);
    const draft = await createCourse(app, admin, { status: 'DRAFT' });
    const archived = await createCourse(app, admin);
    await request(app).post(`/api/v1/courses/${archived.id}/archive`).set(admin.auth);
    const full = await createCourse(app, admin, { seats: 1 });
    await enroll(app, admin, (await createStudent(app, admin)).id, { courseId: full.id });

    const cases: Array<[string, number, string]> = [
      [MISSING_ID, 400, 'COURSE_NOT_FOUND'],
      [draft.id, 409, 'COURSE_NOT_OPEN'],
      [archived.id, 409, 'COURSE_ARCHIVED'],
      [full.id, 409, 'COURSE_FULL'],
    ];
    for (const [courseId, status, code] of cases) {
      const res = await enroll(app, admin, student.id, { courseId });
      expect(res.status, code).toBe(status);
      expect(res.body.code).toBe(code);
    }
    // The transaction rolled back the student's counter each time.
    expect((await Student.findById(student.id).lean())!.activeEnrollments).toBe(0);
    expect((await Course.findById(full.id).lean())!.enrolledCount).toBe(1);
  });

  it('rejects invalid ids, missing courseId, and unknown students', async () => {
    const course = await createCourse(app, admin);
    const student = await createStudent(app, admin);
    expect((await enroll(app, admin, student.id, {})).status).toBe(400);
    expect((await enroll(app, admin, student.id, { courseId: 'x' })).status).toBe(400);
    expect((await enroll(app, admin, 'x', { courseId: course.id })).status).toBe(400);
    const unknown = await enroll(app, admin, MISSING_ID, { courseId: course.id });
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe('STUDENT_NOT_FOUND');
    expect((await Course.findById(course.id).lean())!.enrolledCount).toBe(0);
  });

  it('never overbooks: concurrent requests for the last seat', async () => {
    const course = await createCourse(app, admin, { seats: 1 });
    const students = await Promise.all([1, 2, 3, 4].map(() => createStudent(app, admin)));

    const results = await Promise.all(students.map((s) => enroll(app, admin, s.id, { courseId: course.id })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.body.code === 'COURSE_FULL')).toHaveLength(3);
    expect((await Course.findById(course.id).lean())!.enrolledCount).toBe(1);
    expect(await Enrollment.countDocuments()).toBe(1);
  });
});

describe('PATCH /enrollments/:id/status', () => {
  it('moves freely between learning statuses and records timestamps', async () => {
    const course = await createCourse(app, admin);
    const student = await createStudent(app, admin);
    const id = (await enroll(app, admin, student.id, { courseId: course.id })).body.data.id;

    expect((await setEnrollmentStatus(app, admin, id, 'IN_PROGRESS')).body.data.status).toBe('IN_PROGRESS');
    const completed = await setEnrollmentStatus(app, admin, id, 'COMPLETED');
    expect(completed.body.data.completedAt).toEqual(expect.any(String));
    const back = await setEnrollmentStatus(app, admin, id, 'IN_PROGRESS');
    expect(back.body.data).toMatchObject({ status: 'IN_PROGRESS', completedAt: null });
    expect(await counters(course.id, student.id)).toEqual({ enrolledCount: 1, activeEnrollments: 1 });
  });

  it('withdrawing frees the seat; re-joining needs a free seat and an open course', async () => {
    const course = await createCourse(app, admin, { seats: 1 });
    const a = await createStudent(app, admin);
    const b = await createStudent(app, admin);
    const enrollmentA = (await enroll(app, admin, a.id, { courseId: course.id })).body.data.id;

    const withdrawn = await setEnrollmentStatus(app, admin, enrollmentA, 'WITHDRAWN');
    expect(withdrawn.body.data.withdrawnAt).toEqual(expect.any(String));
    expect(await counters(course.id, a.id)).toEqual({ enrolledCount: 0, activeEnrollments: 0 });

    // B takes the freed seat, so A cannot come back.
    expect((await enroll(app, admin, b.id, { courseId: course.id })).status).toBe(201);
    const rejoin = await setEnrollmentStatus(app, admin, enrollmentA, 'NOT_STARTED');
    expect(rejoin.status).toBe(409);
    expect(rejoin.body.code).toBe('COURSE_FULL');
    expect((await Enrollment.findById(enrollmentA).lean())!.status).toBe('WITHDRAWN');

    await request(app).patch(`/api/v1/courses/${course.id}`).set(admin.auth).send({ seats: 2 });
    const rejoined = await setEnrollmentStatus(app, admin, enrollmentA, 'IN_PROGRESS');
    expect(rejoined.status).toBe(200);
    expect(rejoined.body.data.withdrawnAt).toBeNull();
    expect(await counters(course.id, a.id)).toEqual({ enrolledCount: 2, activeEnrollments: 1 });
  });

  it('cannot re-join an archived course', async () => {
    const course = await createCourse(app, admin);
    const student = await createStudent(app, admin);
    const id = (await enroll(app, admin, student.id, { courseId: course.id })).body.data.id;
    await setEnrollmentStatus(app, admin, id, 'WITHDRAWN');
    await request(app).post(`/api/v1/courses/${course.id}/archive`).set(admin.auth);
    expect((await setEnrollmentStatus(app, admin, id, 'IN_PROGRESS')).body.code).toBe('COURSE_ARCHIVED');
  });

  it('validates the status and the id', async () => {
    const course = await createCourse(app, admin);
    const student = await createStudent(app, admin);
    const id = (await enroll(app, admin, student.id, { courseId: course.id })).body.data.id;
    expect((await setEnrollmentStatus(app, admin, id, 'GRADUATED')).status).toBe(400);
    expect((await setEnrollmentStatus(app, admin, 'x', 'COMPLETED')).status).toBe(400);
    expect((await setEnrollmentStatus(app, admin, MISSING_ID, 'COMPLETED')).body.code).toBe('ENROLLMENT_NOT_FOUND');
    // Setting the current status again is a harmless no-op.
    expect((await setEnrollmentStatus(app, admin, id, 'NOT_STARTED')).status).toBe(200);
  });
});

describe('GET /enrollments', () => {
  it('lists with filters, sorting and pagination', async () => {
    const web = await createCourse(app, admin, { code: 'WEB-9' });
    const ai = await createCourse(app, admin, { code: 'AI-9' });
    const s1 = await createStudent(app, admin);
    const s2 = await createStudent(app, admin);
    const e1 = (await enroll(app, admin, s1.id, { courseId: web.id, enrolledAt: '2026-09-01' })).body.data.id;
    await enroll(app, admin, s1.id, { courseId: ai.id, enrolledAt: '2026-09-10' });
    await enroll(app, admin, s2.id, { courseId: web.id, enrolledAt: '2026-09-20' });
    await setEnrollmentStatus(app, admin, e1, 'COMPLETED');

    const list = (query: string) => request(app).get(`/api/v1/enrollments${query}`).set(admin.auth);
    const dates = (res: request.Response) => res.body.data.map((e: { enrolledAt: string }) => e.enrolledAt.slice(0, 10));

    const page = await list('?limit=2');
    expect(page.body.meta).toEqual({ page: 1, limit: 2, total: 3, totalPages: 2 });
    expect(dates(page)).toEqual(['2026-09-20', '2026-09-10']);
    expect(dates(await list('?sortDir=asc'))).toEqual(['2026-09-01', '2026-09-10', '2026-09-20']);
    expect((await list(`?course=${web.id}`)).body.meta.total).toBe(2);
    expect((await list(`?student=${s1.id}`)).body.meta.total).toBe(2);
    expect((await list(`?student=${s1.id}&course=${web.id}`)).body.meta.total).toBe(1);
    expect((await list('?status=COMPLETED')).body.data[0].id).toBe(e1);
    expect(dates(await list('?enrolledFrom=2026-09-05&enrolledTo=2026-09-15'))).toEqual(['2026-09-10']);

    for (const bad of ['?status=DONE', '?course=abc', '?sortBy=price', '?enrolledFrom=x']) {
      expect((await list(bad)).status, bad).toBe(400);
    }
    expect((await request(app).get(`/api/v1/enrollments/${MISSING_ID}`).set(admin.auth)).status).toBe(404);
  });
});
