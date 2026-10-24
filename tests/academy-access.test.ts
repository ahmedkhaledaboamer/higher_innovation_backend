import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/createApp.js';
import { Enrollment } from '../src/modules/enrollments/enrollment.model.js';
import { Student } from '../src/modules/students/student.model.js';
import type { RoleKey } from '../src/modules/roles/permissions.js';
import { courseBody, createCourse, createStudent, enroll, studentBody } from './helpers/academy.js';
import { useTestDatabase } from './helpers/db.js';
import { signedInAs } from './helpers/factories.js';

useTestDatabase({ roles: true });

const app = createApp();
type Actor = Awaited<ReturnType<typeof signedInAs>>;

let admin: Actor;
let salesA: Actor;
let salesB: Actor;
let course: { id: string };
let spareCourse: { id: string };
let courseToArchive: { id: string };
let studentOfA: { id: string };
let studentOfB: { id: string };
let unadvisedStudent: { id: string };
let enrollmentOfA: string;
let enrollmentOfB: string;

beforeEach(async () => {
  admin = await signedInAs(app, 'ADMIN');
  salesA = await signedInAs(app, 'SALES');
  salesB = await signedInAs(app, 'SALES');
  course = await createCourse(app, admin);
  spareCourse = await createCourse(app, admin);
  courseToArchive = await createCourse(app, admin);
  studentOfA = await createStudent(app, admin, { advisor: salesA.id });
  studentOfB = await createStudent(app, admin, { advisor: salesB.id });
  unadvisedStudent = await createStudent(app, admin);
  enrollmentOfA = (await enroll(app, admin, studentOfA.id, { courseId: course.id })).body.data.id;
  enrollmentOfB = (await enroll(app, admin, studentOfB.id, { courseId: course.id })).body.data.id;
});

/** Every Phase 4 endpoint. `studentId` / `enrollmentId` are records NOT owned by a Sales caller. */
function calls(actor: Actor, studentId: string, enrollmentId: string) {
  const r = () => request(app);
  return {
    'courses.list': () => r().get('/api/v1/courses').set(actor.auth),
    'courses.get': () => r().get(`/api/v1/courses/${course.id}`).set(actor.auth),
    'courses.create': () => r().post('/api/v1/courses').set(actor.auth).send(courseBody()),
    'courses.update': () => r().patch(`/api/v1/courses/${course.id}`).set(actor.auth).send({ name: 'Updated name' }),
    'courses.restore': () => r().post(`/api/v1/courses/${courseToArchive.id}/restore`).set(actor.auth),
    'courses.archive': () => r().post(`/api/v1/courses/${courseToArchive.id}/archive`).set(actor.auth),
    'students.list': () => r().get('/api/v1/students').set(actor.auth),
    'students.get': () => r().get(`/api/v1/students/${studentId}`).set(actor.auth),
    'students.create': () => r().post('/api/v1/students').set(actor.auth).send(studentBody()),
    'students.update': () => r().patch(`/api/v1/students/${studentId}`).set(actor.auth).send({ city: 'Cairo' }),
    'students.advisor': () => r().patch(`/api/v1/students/${studentId}/advisor`).set(actor.auth).send({ advisor: salesA.id }),
    'students.restore': () => r().post(`/api/v1/students/${studentId}/restore`).set(actor.auth),
    'enrollments.list': () => r().get('/api/v1/enrollments').set(actor.auth),
    'enrollments.get': () => r().get(`/api/v1/enrollments/${enrollmentId}`).set(actor.auth),
    'enrollments.create': () =>
      r().post(`/api/v1/students/${studentId}/enrollments`).set(actor.auth).send({ courseId: spareCourse.id }),
    'enrollments.status': () =>
      r().patch(`/api/v1/enrollments/${enrollmentId}/status`).set(actor.auth).send({ status: 'IN_PROGRESS' }),
  };
}
type Action = keyof ReturnType<typeof calls>;

const deny = 403;
/**
 * Expected status per role, against records the caller does not own.
 * restore on a non-archived record answers 409 when permitted. Sales gets 404 (not 403)
 * for another advisor's students and enrollments, so ids cannot be probed.
 */
const MATRIX: Record<RoleKey, Record<Action, number>> = {
  OWNER: {
    'courses.list': 200, 'courses.get': 200, 'courses.create': 201, 'courses.update': 200, 'courses.restore': 409, 'courses.archive': 200,
    'students.list': 200, 'students.get': 200, 'students.create': 201, 'students.update': 200, 'students.advisor': 200, 'students.restore': 409,
    'enrollments.list': 200, 'enrollments.get': 200, 'enrollments.create': 201, 'enrollments.status': 200,
  },
  ADMIN: {
    'courses.list': 200, 'courses.get': 200, 'courses.create': 201, 'courses.update': 200, 'courses.restore': 409, 'courses.archive': 200,
    'students.list': 200, 'students.get': 200, 'students.create': 201, 'students.update': 200, 'students.advisor': 200, 'students.restore': 409,
    'enrollments.list': 200, 'enrollments.get': 200, 'enrollments.create': 201, 'enrollments.status': 200,
  },
  SALES: {
    'courses.list': 200, 'courses.get': 200, 'courses.create': deny, 'courses.update': deny, 'courses.restore': deny, 'courses.archive': deny,
    'students.list': 200, 'students.get': 404, 'students.create': 201, 'students.update': 404, 'students.advisor': deny, 'students.restore': deny,
    'enrollments.list': 200, 'enrollments.get': 404, 'enrollments.create': 404, 'enrollments.status': 404,
  },
  MARKETING: {
    'courses.list': 200, 'courses.get': 200, 'courses.create': deny, 'courses.update': deny, 'courses.restore': deny, 'courses.archive': deny,
    'students.list': deny, 'students.get': deny, 'students.create': deny, 'students.update': deny, 'students.advisor': deny, 'students.restore': deny,
    'enrollments.list': deny, 'enrollments.get': deny, 'enrollments.create': deny, 'enrollments.status': deny,
  },
  HR: {
    'courses.list': deny, 'courses.get': deny, 'courses.create': deny, 'courses.update': deny, 'courses.restore': deny, 'courses.archive': deny,
    'students.list': deny, 'students.get': deny, 'students.create': deny, 'students.update': deny, 'students.advisor': deny, 'students.restore': deny,
    'enrollments.list': deny, 'enrollments.get': deny, 'enrollments.create': deny, 'enrollments.status': deny,
  },
  // Phase 6: trainers read students/enrollments of the courses they teach. This trainer teaches
  // nothing, so lists are empty and records are not found; every write stays forbidden.
  TRAINER: {
    'courses.list': 200, 'courses.get': 200, 'courses.create': deny, 'courses.update': deny, 'courses.restore': deny, 'courses.archive': deny,
    'students.list': 200, 'students.get': 404, 'students.create': deny, 'students.update': deny, 'students.advisor': deny, 'students.restore': deny,
    'enrollments.list': 200, 'enrollments.get': 404, 'enrollments.create': deny, 'enrollments.status': deny,
  },
  VIEWER: {
    'courses.list': 200, 'courses.get': 200, 'courses.create': deny, 'courses.update': deny, 'courses.restore': deny, 'courses.archive': deny,
    'students.list': 200, 'students.get': 200, 'students.create': deny, 'students.update': deny, 'students.advisor': deny, 'students.restore': deny,
    'enrollments.list': 200, 'enrollments.get': 200, 'enrollments.create': deny, 'enrollments.status': deny,
  },
};

describe('role matrix (records the caller does not own)', () => {
  for (const role of Object.keys(MATRIX) as RoleKey[]) {
    it(role, async () => {
      const actor = role === 'SALES' ? salesB : await signedInAs(app, role);
      const studentId = role === 'SALES' ? studentOfA.id : unadvisedStudent.id;
      const enrollmentId = role === 'SALES' ? enrollmentOfA : enrollmentOfB;
      const endpoints = calls(actor, studentId, enrollmentId);
      for (const action of Object.keys(endpoints) as Action[]) {
        const res = await endpoints[action]();
        expect(res.status, `${role} ${action}: ${JSON.stringify(res.body)}`).toBe(MATRIX[role][action]);
        if (role === 'TRAINER' && action.endsWith('.list') && action !== 'courses.list') {
          expect(res.body.meta.total, `${role} ${action} must see nothing`).toBe(0);
        }
      }
    });
  }

  it('requires authentication everywhere', async () => {
    const endpoints = calls({ auth: {} } as unknown as Actor, studentOfA.id, enrollmentOfA);
    for (const action of Object.keys(endpoints) as Action[]) {
      expect((await endpoints[action]()).status, action).toBe(401);
    }
  });
});

describe('Sales isolation for students', () => {
  it('lists only the students they advise, whatever filters are sent', async () => {
    const list = (query = '') => request(app).get(`/api/v1/students${query}`).set(salesA.auth);
    const ids = (res: request.Response) => res.body.data.map((s: { id: string }) => s.id);

    expect(ids(await list())).toEqual([studentOfA.id]);
    expect(ids(await list(`?advisor=${salesB.id}`))).toEqual([]);
    expect(ids(await list('?advisor=unassigned'))).toEqual([]);
    expect(ids(await list(`?course=${course.id}`))).toEqual([studentOfA.id]);
    expect(ids(await list('?archived=true'))).toEqual([]);
  });

  it('advises the students they create and cannot pick another advisor', async () => {
    const created = await request(app).post('/api/v1/students').set(salesA.auth).send(studentBody());
    expect(created.body.data.advisor.id).toBe(salesA.id);

    const other = await request(app).post('/api/v1/students').set(salesA.auth).send(studentBody({ advisor: salesB.id }));
    expect(other.status).toBe(403);
    expect(other.body.code).toBe('FORBIDDEN_FIELD');

    const dup = await request(app)
      .post('/api/v1/students')
      .set(salesA.auth)
      .send(studentBody({ email: (await Student.findById(studentOfB.id).lean())!.email, allowDuplicate: true }));
    expect(dup.status).toBe(403);
  });

  it('can enroll their own students but not anyone else\'s', async () => {
    const own = await enroll(app, salesA, studentOfA.id, { courseId: spareCourse.id });
    expect(own.status).toBe(201);

    for (const target of [studentOfB.id, unadvisedStudent.id]) {
      const res = await enroll(app, salesA, target, { courseId: spareCourse.id });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('STUDENT_NOT_FOUND');
    }
    // Even an existing enrollment of another advisor's student is not revealed.
    const existing = await enroll(app, salesA, studentOfB.id, { courseId: course.id });
    expect(existing.status).toBe(404);
    expect(JSON.stringify(existing.body)).not.toContain(enrollmentOfB);
  });

  it('sees and changes only their students\' enrollments', async () => {
    const list = await request(app).get('/api/v1/enrollments').set(salesA.auth);
    expect(list.body.data.map((e: { id: string }) => e.id)).toEqual([enrollmentOfA]);

    const filtered = await request(app).get(`/api/v1/enrollments?student=${studentOfB.id}`).set(salesA.auth);
    expect(filtered.body.meta.total).toBe(0);

    expect((await request(app).get(`/api/v1/enrollments/${enrollmentOfB}`).set(salesA.auth)).status).toBe(404);
    const change = await request(app)
      .patch(`/api/v1/enrollments/${enrollmentOfB}/status`)
      .set(salesA.auth)
      .send({ status: 'WITHDRAWN' });
    expect(change.status).toBe(404);
    expect((await Enrollment.findById(enrollmentOfB).lean())!.status).toBe('NOT_STARTED');

    const ownChange = await request(app)
      .patch(`/api/v1/enrollments/${enrollmentOfA}/status`)
      .set(salesA.auth)
      .send({ status: 'IN_PROGRESS' });
    expect(ownChange.status).toBe(200);
  });

  it('cannot move a student to another advisor through the profile endpoint', async () => {
    const res = await request(app)
      .patch(`/api/v1/students/${studentOfA.id}`)
      .set(salesA.auth)
      .send({ city: 'Tanta', advisor: salesB.id });
    expect(res.status).toBe(200);
    expect(res.body.data.advisor.id).toBe(salesA.id);
  });

  it('loses access when the advisor changes, and the new advisor gains it', async () => {
    await request(app).patch(`/api/v1/students/${studentOfA.id}/advisor`).set(admin.auth).send({ advisor: salesB.id });
    expect((await request(app).get(`/api/v1/students/${studentOfA.id}`).set(salesA.auth)).status).toBe(404);
    expect((await request(app).get(`/api/v1/enrollments/${enrollmentOfA}`).set(salesA.auth)).status).toBe(404);
    expect((await request(app).get(`/api/v1/students/${studentOfA.id}`).set(salesB.auth)).status).toBe(200);
  });
});
