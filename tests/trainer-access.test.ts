import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/createApp.js';
import { Enrollment } from '../src/modules/enrollments/enrollment.model.js';
import { assign, createCourse, createStudent, createTrainer, endAssignment, enroll } from './helpers/academy.js';
import { useTestDatabase } from './helpers/db.js';
import { createUser, login, type Session, signedInAs } from './helpers/factories.js';

useTestDatabase({ roles: true });

const app = createApp();
type Actor = Awaited<ReturnType<typeof signedInAs>>;

let admin: Actor;
let salesA: Actor;
let trainerSession: Session;
let trainerProfile: { id: string };
let taught: { id: string };
let notTaught: { id: string };
let student1: { id: string; studentNumber: string };
let student2: { id: string };
let outsider: { id: string };
let enrollmentTaught: string;
let enrollmentOtherCourse: string;
let enrollmentOutsider: string;
let assignmentId: string;

/**
 * taught    ← trainer has an open assignment
 *   student1 (advisor salesA), student2
 * notTaught ← no assignment
 *   student1 (same student, other course), outsider
 */
beforeEach(async () => {
  admin = await signedInAs(app, 'ADMIN');
  salesA = await signedInAs(app, 'SALES');
  const user = await createUser({ role: 'TRAINER' });
  trainerSession = await login(app, user.email);
  trainerProfile = await createTrainer(app, admin, { userId: user.id });

  taught = await createCourse(app, admin);
  notTaught = await createCourse(app, admin);
  student1 = await createStudent(app, admin, { advisor: salesA.id, dateOfBirth: '1999-05-05', city: 'Sharjah' });
  student2 = await createStudent(app, admin);
  outsider = await createStudent(app, admin);
  enrollmentTaught = (await enroll(app, admin, student1.id, { courseId: taught.id })).body.data.id;
  await enroll(app, admin, student2.id, { courseId: taught.id });
  enrollmentOtherCourse = (await enroll(app, admin, student1.id, { courseId: notTaught.id })).body.data.id;
  enrollmentOutsider = (await enroll(app, admin, outsider.id, { courseId: notTaught.id })).body.data.id;
  assignmentId = (await assign(app, admin, { trainerId: trainerProfile.id, courseId: taught.id })).body.data.id;
});

const get = (path: string, session: Session = trainerSession) => request(app).get(`/api/v1${path}`).set(session.auth);
const ids = (res: request.Response) => res.body.data.map((r: { id: string }) => r.id).sort();

describe('trainer reads only what they teach', () => {
  it('lists only students enrolled in the taught course', async () => {
    const res = await get('/students');
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual([student1.id, student2.id].sort());
  });

  it('lists only enrollments in the taught course (not the same student\'s other courses)', async () => {
    const res = await get('/enrollments');
    expect(res.body.meta.total).toBe(2);
    expect(res.body.data.every((e: { course: { id: string } }) => e.course.id === taught.id)).toBe(true);
    expect(res.body.data.map((e: { id: string }) => e.id)).not.toContain(enrollmentOtherCourse);
  });

  it('cannot widen the scope with filters', async () => {
    expect((await get(`/students?course=${notTaught.id}`)).body.data.map((s: { id: string }) => s.id)).toEqual([student1.id]);
    expect((await get(`/enrollments?course=${notTaught.id}`)).body.meta.total).toBe(0);
    expect((await get(`/enrollments?student=${outsider.id}`)).body.meta.total).toBe(0);
    expect((await get('/students?archived=true')).body.meta.total).toBe(0);
    expect((await get(`/students?advisor=${salesA.id}`)).body.data.map((s: { id: string }) => s.id)).toEqual([student1.id]);
  });

  it('gets 404 for unrelated students and enrollments by id', async () => {
    expect((await get(`/students/${student1.id}`)).status).toBe(200);
    expect((await get(`/enrollments/${enrollmentTaught}`)).status).toBe(200);
    for (const path of [`/students/${outsider.id}`, `/enrollments/${enrollmentOutsider}`, `/enrollments/${enrollmentOtherCourse}`]) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
    }
  });

  it('sees only the minimum student and enrollment fields', async () => {
    const student = (await get(`/students/${student1.id}`)).body.data;
    expect(Object.keys(student).sort()).toEqual(['email', 'fullName', 'id', 'status', 'studentNumber']);
    const listed = (await get('/students')).body.data[0];
    expect(Object.keys(listed).sort()).toEqual(['email', 'fullName', 'id', 'status', 'studentNumber']);

    const enrollment = (await get(`/enrollments/${enrollmentTaught}`)).body.data;
    expect(enrollment).not.toHaveProperty('price');
    expect(enrollment).not.toHaveProperty('currency');
    expect(enrollment).not.toHaveProperty('enrolledBy');
    expect(enrollment).toMatchObject({ status: 'NOT_STARTED', student: { id: student1.id }, course: { id: taught.id } });
    expect(JSON.stringify((await get('/enrollments')).body)).not.toMatch(/"price"|"enrolledBy"|"phone"|"dateOfBirth"|"advisor"/);
  });

  it('can read the course catalog and their own assignments, nothing else about trainers', async () => {
    expect((await get('/courses')).body.meta.total).toBe(2);
    expect((await get('/trainers/me')).body.data.id).toBe(trainerProfile.id);
    expect(ids(await get('/trainer-assignments'))).toEqual([assignmentId]);
    expect((await get('/trainers')).status).toBe(403);
  });
});

describe('trainer cannot change anything', () => {
  it('is forbidden from every write endpoint', async () => {
    const t = trainerSession.auth;
    const writes: Array<[string, request.Test]> = [
      ['create student', request(app).post('/api/v1/students').set(t).send({ fullName: 'New Person', email: 'n@example.com' })],
      ['edit student', request(app).patch(`/api/v1/students/${student1.id}`).set(t).send({ city: 'Dubai' })],
      ['change advisor', request(app).patch(`/api/v1/students/${student1.id}/advisor`).set(t).send({ advisor: null })],
      ['archive student', request(app).post(`/api/v1/students/${student1.id}/archive`).set(t)],
      ['enroll', request(app).post(`/api/v1/students/${student2.id}/enrollments`).set(t).send({ courseId: notTaught.id })],
      ['enrollment status', request(app).patch(`/api/v1/enrollments/${enrollmentTaught}/status`).set(t).send({ status: 'COMPLETED' })],
      ['course price', request(app).patch(`/api/v1/courses/${taught.id}`).set(t).send({ price: 1 })],
      ['self-assign', request(app).post('/api/v1/trainer-assignments').set(t).send({ trainerId: trainerProfile.id, courseId: notTaught.id, role: 'PRIMARY' })],
      ['end assignment', request(app).post(`/api/v1/trainer-assignments/${assignmentId}/end`).set(t).send({ status: 'COMPLETED' })],
      ['edit own profile', request(app).patch(`/api/v1/trainers/${trainerProfile.id}`).set(t).send({ city: 'Dubai' })],
      ['change a role', request(app).patch(`/api/v1/users/${trainerProfile.id}/role`).set(t).send({ role: 'ADMIN' })],
      ['create diploma', request(app).post('/api/v1/diplomas').set(t).send({ name: 'Nope', level: 'BEGINNER' })],
      ['read leads', request(app).get('/api/v1/leads').set(t)],
    ];
    for (const [label, pending] of writes) {
      expect((await pending).status, label).toBe(403);
    }
    expect((await Enrollment.findById(enrollmentTaught).lean())!.status).toBe('NOT_STARTED');
  });
});

describe('access follows assignments and profile state', () => {
  it('SCHEDULED assignments grant access; ending the assignment removes it immediately', async () => {
    const scheduledCourse = await createCourse(app, admin);
    const s = await createStudent(app, admin);
    await enroll(app, admin, s.id, { courseId: scheduledCourse.id });
    await assign(app, admin, { trainerId: trainerProfile.id, courseId: scheduledCourse.id, status: 'SCHEDULED' });
    expect((await get(`/students/${s.id}`)).status).toBe(200);

    await endAssignment(app, admin, assignmentId);
    expect((await get(`/students/${student2.id}`)).status).toBe(404);
    expect((await get(`/enrollments/${enrollmentTaught}`)).status).toBe(404);
    expect(ids(await get('/students'))).toEqual([s.id]);
  });

  it('archiving the course, archiving the trainer, or making them INACTIVE removes access', async () => {
    await request(app).post(`/api/v1/courses/${taught.id}/archive`).set(admin.auth);
    expect((await get('/students')).body.meta.total).toBe(0);

    const course = await createCourse(app, admin);
    await enroll(app, admin, outsider.id, { courseId: course.id });
    await assign(app, admin, { trainerId: trainerProfile.id, courseId: course.id });
    expect((await get('/students')).body.meta.total).toBe(1);

    await request(app).patch(`/api/v1/trainers/${trainerProfile.id}`).set(admin.auth).send({ status: 'INACTIVE' });
    expect((await get('/students')).body.meta.total).toBe(0);
    await request(app).patch(`/api/v1/trainers/${trainerProfile.id}`).set(admin.auth).send({ status: 'ACTIVE' });
    expect((await get('/students')).body.meta.total).toBe(1);

    await request(app).post(`/api/v1/trainers/${trainerProfile.id}/archive`).set(admin.auth);
    expect((await get('/students')).body.meta.total).toBe(0);
    expect((await get('/enrollments')).body.meta.total).toBe(0);
    expect((await get('/trainer-assignments')).body.meta.total).toBe(0);
  });

  it('a TRAINER user without a profile sees nothing', async () => {
    const bare = await signedInAs(app, 'TRAINER');
    expect((await get('/students', bare)).body.meta.total).toBe(0);
    expect((await get('/enrollments', bare)).body.meta.total).toBe(0);
    expect((await get(`/students/${student1.id}`, bare)).status).toBe(404);
  });

  it('another trainer\'s assignment does not grant access', async () => {
    const otherUser = await createUser({ role: 'TRAINER' });
    const otherSession = await login(app, otherUser.email);
    const otherProfile = await createTrainer(app, admin, { userId: otherUser.id });
    await assign(app, admin, { trainerId: otherProfile.id, courseId: notTaught.id });

    expect(ids(await get('/students', otherSession))).toEqual([outsider.id, student1.id].sort());
    expect(ids(await get('/students'))).toEqual([student1.id, student2.id].sort());
  });
});

describe('regression: Sales isolation and full views are unchanged', () => {
  it('Sales still sees only advised students, with full fields; Admin sees everything', async () => {
    const sales = await get('/students', salesA);
    expect(ids(sales)).toEqual([student1.id]);
    expect(sales.body.data[0]).toMatchObject({ dateOfBirth: '1999-05-05', city: 'Sharjah', advisor: { id: salesA.id } });

    const enrollments = await get('/enrollments', salesA);
    expect(enrollments.body.meta.total).toBe(2);
    expect(enrollments.body.data[0]).toHaveProperty('price');
    expect(enrollments.body.data[0].currency).toBe('AED');

    expect((await get('/students', admin)).body.meta.total).toBe(3);
    expect((await get('/enrollments', admin)).body.meta.total).toBe(4);
  });
});
