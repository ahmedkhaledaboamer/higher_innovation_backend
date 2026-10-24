import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/createApp.js';
import { TrainerAssignment } from '../src/modules/assignments/assignment.model.js';
import { Course } from '../src/modules/courses/course.model.js';
import { Trainer } from '../src/modules/trainers/trainer.model.js';
import { assign, createCourse, createTrainer, endAssignment } from './helpers/academy.js';
import { useTestDatabase } from './helpers/db.js';
import { createUser, login, signedInAs } from './helpers/factories.js';

useTestDatabase({ roles: true });

const app = createApp();
const MISSING_ID = '665f1c2e9b3e4a0012345678';
let admin: Awaited<ReturnType<typeof signedInAs>>;

beforeEach(async () => {
  admin = await signedInAs(app, 'ADMIN');
});

const counters = async (trainerId: string, courseId: string) => ({
  trainer: (await Trainer.findById(trainerId).lean())!.openAssignments,
  course: (await Course.findById(courseId).lean())!.openAssignments,
});

describe('POST /trainer-assignments', () => {
  it('assigns a trainer to a course and keeps both counters in sync', async () => {
    const trainer = await createTrainer(app, admin);
    const course = await createCourse(app, admin, { status: 'DRAFT' });
    const res = await assign(app, admin, {
      trainerId: trainer.id,
      courseId: course.id,
      role: 'PRIMARY',
      status: 'SCHEDULED',
      startDate: '2026-11-01',
      endDate: '2027-01-31',
      teachingHours: 48,
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      trainer: { id: trainer.id, code: trainer.code },
      course: { id: course.id, code: course.code },
      role: 'PRIMARY',
      status: 'SCHEDULED',
      open: true,
      teachingHours: 48,
      assignedBy: { id: admin.id },
      endedAt: null,
    });
    expect(await counters(trainer.id, course.id)).toEqual({ trainer: 1, course: 1 });
  });

  it('supports many-to-many: a trainer teaches many courses, a course has many trainers', async () => {
    const [t1, t2] = [await createTrainer(app, admin), await createTrainer(app, admin)];
    const [c1, c2] = [await createCourse(app, admin), await createCourse(app, admin)];
    for (const [trainerId, courseId, role] of [
      [t1.id, c1.id, 'PRIMARY'],
      [t2.id, c1.id, 'ASSISTANT'],
      [t1.id, c2.id, 'ASSISTANT'],
    ]) {
      expect((await assign(app, admin, { trainerId, courseId, role })).status).toBe(201);
    }
    expect(await counters(t1.id, c1.id)).toEqual({ trainer: 2, course: 2 });
  });

  it('prevents duplicate open assignments and a second open PRIMARY per course', async () => {
    const [t1, t2] = [await createTrainer(app, admin), await createTrainer(app, admin)];
    const course = await createCourse(app, admin);
    await assign(app, admin, { trainerId: t1.id, courseId: course.id, role: 'PRIMARY' });

    const duplicate = await assign(app, admin, { trainerId: t1.id, courseId: course.id, role: 'ASSISTANT' });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe('ASSIGNMENT_EXISTS');

    const secondPrimary = await assign(app, admin, { trainerId: t2.id, courseId: course.id, role: 'PRIMARY' });
    expect(secondPrimary.status).toBe(409);
    expect(secondPrimary.body.code).toBe('PRIMARY_TRAINER_EXISTS');

    // The aborted transactions left the counters untouched.
    expect(await counters(t1.id, course.id)).toEqual({ trainer: 1, course: 1 });
    expect((await Trainer.findById(t2.id).lean())!.openAssignments).toBe(0);
  });

  it('allows a new assignment after the previous one ended, keeping the history', async () => {
    const trainer = await createTrainer(app, admin);
    const course = await createCourse(app, admin);
    const first = (await assign(app, admin, { trainerId: trainer.id, courseId: course.id })).body.data.id;
    await endAssignment(app, admin, first, 'COMPLETED');

    expect((await assign(app, admin, { trainerId: trainer.id, courseId: course.id })).status).toBe(201);
    expect(await TrainerAssignment.countDocuments({ trainer: trainer.id, course: course.id })).toBe(2);
    expect(await counters(trainer.id, course.id)).toEqual({ trainer: 1, course: 1 });
  });

  it('rejects invalid references and ineligible trainers or courses', async () => {
    const trainer = await createTrainer(app, admin);
    const inactive = await createTrainer(app, admin, { status: 'INACTIVE' });
    const onLeave = await createTrainer(app, admin, { status: 'ON_LEAVE' });
    const course = await createCourse(app, admin);
    const archivedCourse = await createCourse(app, admin);
    await request(app).post(`/api/v1/courses/${archivedCourse.id}/archive`).set(admin.auth);

    const cases: Array<[Record<string, unknown>, number, string]> = [
      [{ trainerId: MISSING_ID, courseId: course.id }, 400, 'TRAINER_NOT_FOUND'],
      [{ trainerId: trainer.id, courseId: MISSING_ID }, 400, 'COURSE_NOT_FOUND'],
      [{ trainerId: inactive.id, courseId: course.id }, 409, 'TRAINER_INACTIVE'],
      [{ trainerId: trainer.id, courseId: archivedCourse.id }, 409, 'COURSE_ARCHIVED'],
      [{ trainerId: 'x', courseId: course.id }, 400, 'VALIDATION_ERROR'],
      [{ trainerId: trainer.id, courseId: course.id, role: 'LEAD' }, 400, 'VALIDATION_ERROR'],
      [{ trainerId: trainer.id, courseId: course.id, status: 'COMPLETED' }, 400, 'VALIDATION_ERROR'],
      [{ trainerId: trainer.id, courseId: course.id, startDate: '2026-12-01', endDate: '2026-11-01' }, 400, 'VALIDATION_ERROR'],
    ];
    for (const [body, status, code] of cases) {
      const res = await assign(app, admin, body);
      expect(res.status, code).toBe(status);
      expect(res.body.code).toBe(code);
    }
    expect((await Trainer.findById(trainer.id).lean())!.openAssignments).toBe(0);
    // Trainers on leave can be scheduled.
    expect((await assign(app, admin, { trainerId: onLeave.id, courseId: course.id })).status).toBe(201);
  });

  it('creates exactly one assignment under concurrent identical requests', async () => {
    const trainer = await createTrainer(app, admin);
    const course = await createCourse(app, admin);
    const results = await Promise.all(
      [1, 2, 3, 4].map(() => assign(app, admin, { trainerId: trainer.id, courseId: course.id })),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.body.code === 'ASSIGNMENT_EXISTS')).toHaveLength(3);
    expect(await TrainerAssignment.countDocuments({ isOpen: true })).toBe(1);
    expect(await counters(trainer.id, course.id)).toEqual({ trainer: 1, course: 1 });
  });

  it('never leaves an open assignment on a course archived concurrently', async () => {
    const trainer = await createTrainer(app, admin);
    const course = await createCourse(app, admin);
    await Promise.all([
      assign(app, admin, { trainerId: trainer.id, courseId: course.id }),
      request(app).post(`/api/v1/courses/${course.id}/archive`).set(admin.auth),
    ]);
    expect(await TrainerAssignment.countDocuments({ course: course.id, isOpen: true })).toBe(0);
    expect(await counters(trainer.id, course.id)).toEqual({ trainer: 0, course: 0 });
  });
});

describe('PATCH and end', () => {
  it('edits open assignments and ends them once, keeping history', async () => {
    const trainer = await createTrainer(app, admin);
    const course = await createCourse(app, admin);
    const id = (await assign(app, admin, { trainerId: trainer.id, courseId: course.id, status: 'SCHEDULED' })).body.data.id;

    const edited = await request(app)
      .patch(`/api/v1/trainer-assignments/${id}`)
      .set(admin.auth)
      .send({ status: 'ACTIVE', teachingHours: 30, role: 'PRIMARY', trainer: MISSING_ID, isOpen: false });
    expect(edited.status).toBe(200);
    expect(edited.body.data).toMatchObject({ status: 'ACTIVE', teachingHours: 30, role: 'PRIMARY', open: true, trainer: { id: trainer.id } });

    expect((await request(app).patch(`/api/v1/trainer-assignments/${id}`).set(admin.auth).send({ status: 'COMPLETED' })).status).toBe(400);

    const ended = await endAssignment(app, admin, id, 'CANCELLED');
    expect(ended.body.data).toMatchObject({ status: 'CANCELLED', open: false, endedReason: 'MANUAL', endedBy: { id: admin.id } });
    expect(await counters(trainer.id, course.id)).toEqual({ trainer: 0, course: 0 });

    expect((await endAssignment(app, admin, id)).body.code).toBe('ASSIGNMENT_ENDED');
    expect((await request(app).patch(`/api/v1/trainer-assignments/${id}`).set(admin.auth).send({ teachingHours: 1 })).body.code).toBe(
      'ASSIGNMENT_ENDED',
    );
    expect((await endAssignment(app, admin, MISSING_ID)).status).toBe(404);
    expect((await request(app).post(`/api/v1/trainer-assignments/${id}/end`).set(admin.auth).send({ status: 'ACTIVE' })).status).toBe(400);
  });

  it('archiving a course ends its open assignments and decrements trainer counters', async () => {
    const [t1, t2] = [await createTrainer(app, admin), await createTrainer(app, admin)];
    const course = await createCourse(app, admin);
    const other = await createCourse(app, admin);
    await assign(app, admin, { trainerId: t1.id, courseId: course.id, role: 'PRIMARY' });
    await assign(app, admin, { trainerId: t2.id, courseId: course.id });
    await assign(app, admin, { trainerId: t1.id, courseId: other.id });

    await request(app).post(`/api/v1/courses/${course.id}/archive`).set(admin.auth);
    const ended = await TrainerAssignment.find({ course: course.id }).lean();
    expect(ended.map((a) => [a.status, a.isOpen, a.endedReason])).toEqual([
      ['CANCELLED', false, 'COURSE_ARCHIVED'],
      ['CANCELLED', false, 'COURSE_ARCHIVED'],
    ]);
    expect((await Trainer.findById(t1.id).lean())!.openAssignments).toBe(1);
    expect((await Trainer.findById(t2.id).lean())!.openAssignments).toBe(0);
    expect((await Course.findById(course.id).lean())!.openAssignments).toBe(0);
  });
});

describe('GET /trainer-assignments', () => {
  it('lists with filters for managers, and only own assignments for a trainer', async () => {
    const user = await createUser({ role: 'TRAINER' });
    const session = await login(app, user.email);
    const mine = await createTrainer(app, admin, { userId: user.id });
    const other = await createTrainer(app, admin);
    const course = await createCourse(app, admin);
    const myId = (await assign(app, admin, { trainerId: mine.id, courseId: course.id, role: 'PRIMARY' })).body.data.id;
    const otherId = (await assign(app, admin, { trainerId: other.id, courseId: course.id })).body.data.id;
    await endAssignment(app, admin, otherId);

    const all = (q = '') => request(app).get(`/api/v1/trainer-assignments${q}`).set(admin.auth);
    expect((await all()).body.meta.total).toBe(2);
    expect((await all('?open=true')).body.data.map((a: { id: string }) => a.id)).toEqual([myId]);
    expect((await all(`?trainer=${other.id}`)).body.data[0].status).toBe('COMPLETED');
    expect((await all('?role=PRIMARY')).body.meta.total).toBe(1);
    expect((await all('?status=OPEN')).status).toBe(400);

    const own = await request(app).get('/api/v1/trainer-assignments').set(session.auth);
    expect(own.body.data.map((a: { id: string }) => a.id)).toEqual([myId]);
    expect((await request(app).get(`/api/v1/trainer-assignments?trainer=${other.id}`).set(session.auth)).body.meta.total).toBe(0);
    expect((await request(app).get(`/api/v1/trainer-assignments/${otherId}`).set(session.auth)).status).toBe(404);
    expect((await request(app).get(`/api/v1/trainer-assignments/${myId}`).set(session.auth)).status).toBe(200);
  });

  it('enforces permissions on every assignment endpoint', async () => {
    const trainer = await createTrainer(app, admin);
    const course = await createCourse(app, admin);
    const id = (await assign(app, admin, { trainerId: trainer.id, courseId: course.id })).body.data.id;

    for (const role of ['HR', 'VIEWER'] as const) {
      const actor = await signedInAs(app, role);
      expect((await request(app).get('/api/v1/trainer-assignments').set(actor.auth)).status, role).toBe(200);
      expect((await assign(app, actor, { trainerId: trainer.id, courseId: course.id })).status, role).toBe(403);
      expect((await endAssignment(app, actor, id)).status, role).toBe(403);
    }
    for (const role of ['SALES', 'MARKETING'] as const) {
      const actor = await signedInAs(app, role);
      expect((await request(app).get('/api/v1/trainer-assignments').set(actor.auth)).status, role).toBe(403);
    }
    const trainerRole = await signedInAs(app, 'TRAINER');
    expect((await assign(app, trainerRole, { trainerId: trainer.id, courseId: course.id })).status).toBe(403);
    expect((await request(app).patch(`/api/v1/trainer-assignments/${id}`).set(trainerRole.auth).send({ teachingHours: 1 })).status).toBe(403);
    expect((await request(app).get('/api/v1/trainer-assignments')).status).toBe(401);
  });
});
