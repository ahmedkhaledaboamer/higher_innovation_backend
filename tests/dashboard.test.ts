import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { RoleKey } from '../src/modules/roles/permissions.js';
import { assign, createCourse, createStudent, createTrainer, enroll } from './helpers/academy.js';
import { useTestDatabase } from './helpers/db.js';
import { createUser, login, type Session, signedInAs } from './helpers/factories.js';
import { insertLead } from './helpers/leads.js';

useTestDatabase({ roles: true });

const app = createApp();
type Actor = Awaited<ReturnType<typeof signedInAs>>;

let admin: Actor;
let salesA: Actor;
let salesB: Actor;
let trainerSession: Session;

const dashboard = (session: Session, query = '') =>
  request(app).get(`/api/v1/dashboard/summary${query}`).set(session.auth);

/**
 * Fixture (all created today, so inside the default range):
 *   leads: 3 assigned to salesA (one due follow-up, one REGISTERED), 2 to salesB, 1 unassigned, 1 archived
 *   students: 2 advised by salesA, 1 by salesB, 1 unadvised
 *   courses: taught (trainer assigned) and other
 */
beforeEach(async () => {
  admin = await signedInAs(app, 'ADMIN');
  salesA = await signedInAs(app, 'SALES');
  salesB = await signedInAs(app, 'SALES');

  await insertLead(admin.id, { assignedTo: salesA.id, status: 'NEW', nextFollowUpAt: new Date(Date.now() - 3_600_000) });
  await insertLead(admin.id, { assignedTo: salesA.id, status: 'QUALIFIED' });
  await insertLead(admin.id, { assignedTo: salesA.id, status: 'REGISTERED', convertedAt: new Date() });
  await insertLead(admin.id, { assignedTo: salesB.id, status: 'NEW', nextFollowUpAt: new Date(Date.now() - 3_600_000) });
  await insertLead(admin.id, { assignedTo: salesB.id, status: 'LOST' });
  await insertLead(admin.id, { status: 'NEW' });
  await insertLead(admin.id, { assignedTo: salesA.id, status: 'NEW', archivedAt: new Date() });

  const taught = await createCourse(app, admin, { seats: 10 });
  const other = await createCourse(app, admin);
  const a1 = await createStudent(app, admin, { advisor: salesA.id });
  await createStudent(app, admin, { advisor: salesA.id });
  const b1 = await createStudent(app, admin, { advisor: salesB.id });
  await createStudent(app, admin);
  await enroll(app, admin, a1.id, { courseId: taught.id });
  await enroll(app, admin, b1.id, { courseId: other.id });

  const trainerUser = await createUser({ role: 'TRAINER' });
  trainerSession = await login(app, trainerUser.email);
  const profile = await createTrainer(app, admin, { userId: trainerUser.id });
  await assign(app, admin, { trainerId: profile.id, courseId: taught.id });
});

describe('sections per role', () => {
  it('shows each role exactly the sections its permissions grant', async () => {
    const expected: Record<RoleKey, string[]> = {
      OWNER: ['campaigns', 'courses', 'enrollments', 'leads', 'staff', 'students'],
      ADMIN: ['campaigns', 'courses', 'enrollments', 'leads', 'staff', 'students'],
      MARKETING: ['campaigns', 'courses', 'leads'],
      SALES: ['courses', 'enrollments', 'leads', 'students'],
      HR: ['staff'],
      TRAINER: ['courses', 'enrollments', 'students', 'teaching'],
      VIEWER: ['campaigns', 'courses', 'enrollments', 'leads', 'staff', 'students'],
    };
    for (const [role, sections] of Object.entries(expected) as Array<[RoleKey, string[]]>) {
      const actor = role === 'ADMIN' ? admin : role === 'TRAINER' ? trainerSession : await signedInAs(app, role);
      const res = await dashboard(actor);
      expect(res.status, role).toBe(200);
      expect(Object.keys(res.body.data.sections).sort(), role).toEqual(sections);
    }
    expect((await request(app).get('/api/v1/dashboard/summary')).status).toBe(401);
  });

  it('HR sees staff counts only; Viewer sees trainers but not user accounts', async () => {
    const hr = await signedInAs(app, 'HR');
    expect((await dashboard(hr)).body.data.sections.staff).toEqual({
      usersByStatus: expect.objectContaining({ ACTIVE: expect.any(Number) }),
      trainersByStatus: { ACTIVE: 1, ON_LEAVE: 0, INACTIVE: 0 },
    });
    const viewer = await signedInAs(app, 'VIEWER');
    expect(Object.keys((await dashboard(viewer)).body.data.sections.staff)).toEqual(['trainersByStatus']);
  });
});

describe('aggregate isolation', () => {
  it('Admin totals cover everything (archived excluded)', async () => {
    const { leads, students, enrollments } = (await dashboard(admin)).body.data.sections;
    expect(leads).toMatchObject({ scope: 'all', leads: 6, converted: 1, lost: 1, conversionsInRange: 1, followUpsDue: 2 });
    expect(students).toMatchObject({ scope: 'all', total: 4, withActiveEnrollments: 2 });
    expect(enrollments).toMatchObject({ total: 2, enrolledInRange: 2 });
  });

  it('Sales totals include only their own leads, advised students and those students\' enrollments', async () => {
    const { leads, students, enrollments } = (await dashboard(salesA)).body.data.sections;
    expect(leads).toMatchObject({ scope: 'assigned', leads: 3, qualified: 2, converted: 1, lost: 0, followUpsDue: 1, conversionsInRange: 1 });
    expect(students).toMatchObject({ scope: 'advised', total: 2, withActiveEnrollments: 1 });
    expect(enrollments).toMatchObject({ scope: 'advised', total: 1 });

    const other = (await dashboard(salesB)).body.data.sections;
    expect(other.leads).toMatchObject({ leads: 2, lost: 1, followUpsDue: 1, converted: 0 });
    expect(other.students.total).toBe(1);
  });

  it('query parameters cannot widen a section', async () => {
    const baseline = (await dashboard(salesA)).body.data.sections.leads.leads;
    for (const query of [`?assignedTo=${salesB.id}`, '?scope=all', '?advisor=unassigned', '?leads[$ne]=1']) {
      const res = await dashboard(salesA, query);
      expect(res.status, query).toBe(200);
      expect(res.body.data.sections.leads.leads, query).toBe(baseline);
    }
  });

  it('Trainer totals cover only the taught course, with no conversion counts', async () => {
    const { students, enrollments, teaching, leads } = (await dashboard(trainerSession)).body.data.sections;
    expect(leads).toBeUndefined();
    expect(teaching).toEqual({ coursesTaught: 1 });
    expect(students).toMatchObject({ scope: 'teaching', total: 1, withActiveEnrollments: 1 });
    expect(students).not.toHaveProperty('fromLeadConversion');
    expect(students).not.toHaveProperty('createdDirectly');
    expect(enrollments).toMatchObject({ scope: 'teaching', total: 1 });
  });

  it('Marketing gets lead and campaign aggregates but no student data', async () => {
    const marketing = await signedInAs(app, 'MARKETING');
    const { leads, students, campaigns } = (await dashboard(marketing)).body.data.sections;
    expect(leads.leads).toBe(6);
    expect(students).toBeUndefined();
    expect(campaigns).toMatchObject({ total: 0, budget: 0, spent: 0 });
  });
});

describe('range handling', () => {
  it('uses the requested range and validates it', async () => {
    const past = (await dashboard(admin, '?from=2020-01-01&to=2020-01-31')).body.data;
    expect(past.range).toEqual({ from: '2020-01-01', to: '2020-01-31', days: 31, timezone: 'Asia/Dubai' });
    expect(past.sections.leads).toMatchObject({ leads: 0, conversionRate: 0, conversionsInRange: 0 });
    // Point-in-time counts (students, follow-ups due) do not depend on the range.
    expect(past.sections.students.total).toBe(4);
    expect(past.sections.leads.followUpsDue).toBe(2);

    expect((await dashboard(admin, '?from=2026-10-10&to=2026-10-01')).status).toBe(400);
    expect((await dashboard(admin, '?from=2000-01-01&to=2026-01-01')).status).toBe(400);
  });
});
