import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/createApp.js';
import { Enrollment } from '../src/modules/enrollments/enrollment.model.js';
import { Lead } from '../src/modules/leads/lead.model.js';
import { LeadNote } from '../src/modules/leads/leadNote.model.js';
import { Student } from '../src/modules/students/student.model.js';
import { User } from '../src/modules/users/user.model.js';
import { createCourse, enroll, studentBody } from './helpers/academy.js';
import { useTestDatabase } from './helpers/db.js';
import { createUser, type Session, signedInAs } from './helpers/factories.js';
import { insertLead, leadBody } from './helpers/leads.js';

useTestDatabase({ roles: true });

const app = createApp();
const MISSING_ID = '665f1c2e9b3e4a0012345678';
const SENSITIVE = /passwordHash|tokenHash|tokenVersion|phoneNormalized|\$2[aby]\$/;
type Actor = Awaited<ReturnType<typeof signedInAs>>;

let admin: Actor;
let salesA: Actor;
let salesB: Actor;

beforeEach(async () => {
  admin = await signedInAs(app, 'ADMIN');
  salesA = await signedInAs(app, 'SALES');
  salesB = await signedInAs(app, 'SALES');
});

const convert = (session: Session | { auth: Record<string, string> }, id: string, body: object = {}) =>
  request(app).post(`/api/v1/leads/${id}/convert`).set(session.auth).send(body);

async function leadFor(assignee: { id: string } | null, overrides: Record<string, unknown> = {}) {
  const res = await request(app)
    .post('/api/v1/leads')
    .set(admin.auth)
    .send(leadBody({ ...(assignee ? { assignedTo: assignee.id } : {}), ...overrides }));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as { id: string; reference: string; email: string; phone: string; [key: string]: unknown };
}

describe('POST /leads/:id/convert: success', () => {
  it('creates a student from the lead, links both, and keeps the lead and its notes', async () => {
    const lead = await leadFor(salesA, {
      fullName: 'Mariam Adel',
      phone: '+20 100 444 5566',
      country: 'Egypt',
      city: 'Alexandria',
      profession: 'Accountant',
      source: 'GOOGLE_ADS',
      utm: { source: 'google', medium: 'cpc', campaign: 'winter-intake' },
      status: 'QUALIFIED',
      priority: 'HIGH',
      tags: ['HOT'],
    });
    await request(app).post(`/api/v1/leads/${lead.id}/notes`).set(salesA.auth).send({ body: 'Paid deposit' });
    await request(app).post(`/api/v1/leads/${lead.id}/notes`).set(salesA.auth).send({ body: 'Wants evenings', pinned: true });

    const res = await convert(salesA, lead.id);
    expect(res.status).toBe(201);
    expect(res.body.message).toBe('Lead converted to student ST-1001');
    expect(JSON.stringify(res.body)).not.toMatch(SENSITIVE);

    const { student, lead: convertedLead } = res.body.data;
    // Field mapping.
    expect(student).toMatchObject({
      studentNumber: 'ST-1001',
      fullName: 'Mariam Adel',
      email: lead.email,
      phone: '+20 100 444 5566',
      country: 'Egypt',
      city: 'Alexandria',
      profession: 'Accountant',
      dateOfBirth: null,
      status: 'ACTIVE',
      advisor: { id: salesA.id },
      activeEnrollments: 0,
      createdBy: { id: salesA.id },
      // Attribution preserved on the student.
      conversion: {
        leadId: lead.id,
        leadReference: lead.reference,
        source: 'GOOGLE_ADS',
        utm: { source: 'google', medium: 'cpc', campaign: 'winter-intake', term: null, content: null },
        convertedBy: { id: salesA.id },
      },
    });
    // The lead is kept, now REGISTERED and linked.
    expect(convertedLead).toMatchObject({
      id: lead.id,
      status: 'REGISTERED',
      convertedStudent: { id: student.id, studentNumber: 'ST-1001' },
      fullName: 'Mariam Adel',
      priority: 'HIGH',
      tags: ['HOT'],
      source: 'GOOGLE_ADS',
      notesCount: 2,
      archived: false,
    });
    expect(convertedLead.convertedAt).toEqual(expect.any(String));
    expect(convertedLead.statusChangedAt).toEqual(expect.any(String));

    // Notes untouched.
    const notes = await LeadNote.find({ lead: lead.id }).sort({ createdAt: 1 }).lean();
    expect(notes.map((n) => n.body)).toEqual(['Paid deposit', 'Wants evenings']);

    // Conversion does not enroll anyone.
    expect(await Enrollment.countDocuments()).toBe(0);

    // The new student is visible to the converting salesperson through the normal endpoints.
    expect((await request(app).get(`/api/v1/students/${student.id}`).set(salesA.auth)).body.data.conversion.leadId).toBe(lead.id);
  });

  it('uses corrections from the request for the student only, never for the lead', async () => {
    const lead = await leadFor(salesA, { fullName: 'mariam adel', city: 'Alex' });
    const res = await convert(salesA, lead.id, {
      fullName: 'Mariam Adel Hassan',
      email: 'mariam.official@example.com',
      city: '',
      dateOfBirth: '2001-03-09',
      status: 'PENDING',
    });
    expect(res.status).toBe(201);
    expect(res.body.data.student).toMatchObject({
      fullName: 'Mariam Adel Hassan',
      email: 'mariam.official@example.com',
      city: null,
      dateOfBirth: '2001-03-09',
      status: 'PENDING',
    });
    const stored = await Lead.findById(lead.id).lean();
    expect(stored).toMatchObject({ fullName: 'mariam adel', email: lead.email, city: 'Alex' });
  });

  it('sets the advisor from the lead assignee by server rules only', async () => {
    // Unassigned lead → no advisor.
    const unassigned = await leadFor(null);
    expect((await convert(admin, unassigned.id)).body.data.student.advisor).toBeNull();

    // Assignee no longer active → no advisor.
    const leaver = await createUser({ role: 'SALES' });
    const leadOfLeaver = await leadFor(leaver);
    await User.updateOne({ _id: leaver.id }, { status: 'SUSPENDED' });
    expect((await convert(admin, leadOfLeaver.id)).body.data.student.advisor).toBeNull();

    // Assignee who works leads → becomes the advisor, even when an admin converts.
    const leadOfB = await leadFor(salesB);
    expect((await convert(admin, leadOfB.id)).body.data.student.advisor.id).toBe(salesB.id);
  });
});

describe('POST /leads/:id/convert: invalid leads', () => {
  it('rejects malformed and unknown ids', async () => {
    expect((await convert(admin, 'not-an-id')).status).toBe(400);
    const missing = await convert(admin, MISSING_ID);
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('LEAD_NOT_FOUND');
  });

  it('rejects archived leads', async () => {
    const lead = await leadFor(null);
    await request(app).post(`/api/v1/leads/${lead.id}/archive`).set(admin.auth);
    const res = await convert(admin, lead.id);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('LEAD_ARCHIVED');
    expect(await Student.countDocuments()).toBe(0);
  });

  it('rejects already converted leads and names the student to callers who can see it', async () => {
    const lead = await leadFor(salesA);
    const first = await convert(salesA, lead.id);
    const studentNumber = first.body.data.student.studentNumber;

    const again = await convert(admin, lead.id);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('LEAD_ALREADY_CONVERTED');
    expect(again.body.errors[0].message).toContain(studentNumber);

    // A REGISTERED lead without a link (e.g. imported data) is also treated as converted.
    const legacy = await insertLead(admin.id, { status: 'REGISTERED' });
    expect((await convert(admin, legacy.id)).body.code).toBe('LEAD_ALREADY_CONVERTED');
    expect(await Student.countDocuments()).toBe(1);
  });

  it('validates the request body', async () => {
    const lead = await leadFor(null);
    const cases: Array<[object, string]> = [
      [{ email: 'not-an-email' }, 'email'],
      [{ status: 'ENROLLED' }, 'status'],
      [{ dateOfBirth: '2999-01-01' }, 'dateOfBirth'],
      [{ dateOfBirth: '09/03/2001' }, 'dateOfBirth'],
      [{ fullName: 'X' }, 'fullName'],
      [{ allowDuplicate: 'yes' }, 'allowDuplicate'],
      [{ email: null, phone: null }, 'phone'],
    ];
    for (const [body, path] of cases) {
      const res = await convert(admin, lead.id, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.errors.map((e: { path: string }) => e.path)).toContain(path);
    }
    expect((await Lead.findById(lead.id).lean())!.status).toBe('NEW');
    expect(await Student.countDocuments()).toBe(0);
  });
});

describe('POST /leads/:id/convert: authorization', () => {
  it('Sales cannot convert another salesperson\'s lead or an unassigned one', async () => {
    const leadOfA = await leadFor(salesA);
    const unassigned = await leadFor(null);

    for (const id of [leadOfA.id, unassigned.id]) {
      const res = await convert(salesB, id);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('LEAD_NOT_FOUND');
    }
    expect((await Lead.findById(leadOfA.id).lean())!.status).toBe('NEW');
    expect(await Student.countDocuments()).toBe(0);
  });

  it('is forbidden to Marketing, Viewer, HR and Trainer, and requires authentication', async () => {
    const lead = await leadFor(null);
    for (const role of ['MARKETING', 'VIEWER', 'HR', 'TRAINER'] as const) {
      const actor = await signedInAs(app, role);
      const res = await convert(actor, lead.id);
      expect(res.status, role).toBe(403);
    }
    expect((await convert({ auth: {} }, lead.id)).status).toBe(401);
    expect(await Student.countDocuments()).toBe(0);
  });

  it('Owner can convert any lead', async () => {
    const owner = await signedInAs(app, 'OWNER');
    expect((await convert(owner, (await leadFor(salesA)).id)).status).toBe(201);
  });
});

describe('POST /leads/:id/convert: duplicates', () => {
  it('refuses to create a duplicate student by email or normalised phone', async () => {
    const existing = await request(app)
      .post('/api/v1/students')
      .set(admin.auth)
      .send(studentBody({ email: 'family@example.com', phone: '+20 100 999 0000' }));
    const byEmail = await leadFor(salesA, { email: 'FAMILY@example.com' });
    const byPhone = await leadFor(salesA, { phone: '00201009990000' });

    const emailConflict = await convert(admin, byEmail.id);
    expect(emailConflict.status).toBe(409);
    expect(emailConflict.body.code).toBe('DUPLICATE_STUDENT');
    expect(emailConflict.body.errors).toEqual([
      { path: 'email', message: `Matches student ${existing.body.data.studentNumber}` },
    ]);

    // A salesperson learns only that a conflict exists, not who the other student is.
    const phoneConflict = await convert(salesA, byPhone.id);
    expect(phoneConflict.status).toBe(409);
    expect(phoneConflict.body.code).toBe('DUPLICATE_STUDENT');
    expect(JSON.stringify(phoneConflict.body)).not.toContain(existing.body.data.studentNumber);
    expect(JSON.stringify(phoneConflict.body)).not.toContain(existing.body.data.id);

    // Nothing changed.
    expect((await Lead.findById(byEmail.id).lean())!.status).toBe('NEW');
    expect(await Student.countDocuments()).toBe(1);
  });

  it('lets only student managers knowingly create a duplicate (e.g. siblings sharing a phone)', async () => {
    await request(app).post('/api/v1/students').set(admin.auth).send(studentBody({ phone: '+20 100 777 1111' }));
    const sibling = await leadFor(salesA, { phone: '+20 100 777 1111' });

    const sales = await convert(salesA, sibling.id, { allowDuplicate: true });
    expect(sales.status).toBe(403);
    expect(sales.body.code).toBe('FORBIDDEN_FIELD');

    const manager = await convert(admin, sibling.id, { allowDuplicate: true });
    expect(manager.status).toBe(201);
    expect(await Student.countDocuments()).toBe(2);
  });
});

describe('POST /leads/:id/convert: concurrency and rollback', () => {
  it('converts a lead exactly once under simultaneous requests', async () => {
    const lead = await leadFor(salesA);
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => convert(salesA, lead.id)));

    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.body.code === 'LEAD_ALREADY_CONVERTED')).toHaveLength(4);
    expect(await Student.countDocuments({ 'conversion.lead': lead.id })).toBe(1);
    const stored = await Lead.findById(lead.id).lean();
    const student = await Student.findOne().lean();
    expect(stored!.convertedStudent!.toString()).toBe(student!._id.toString());
  });

  it('rolls everything back when the student cannot be written', async () => {
    const lead = await leadFor(salesA);
    // A conflicting record that only the database-level unique index can catch: a student
    // already claiming this lead while the lead itself still looks unconverted.
    await Student.create({
      studentNumber: 'ST-ORPHAN',
      fullName: 'Orphan Record',
      email: 'orphan@example.com',
      createdBy: admin.id,
      conversion: { lead: lead.id, leadReference: lead.reference, source: 'WEBSITE', convertedAt: new Date(), convertedBy: admin.id },
    });

    const res = await convert(admin, lead.id);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('LEAD_ALREADY_CONVERTED');

    // The lead claim in the same transaction was rolled back.
    const stored = await Lead.findById(lead.id).lean();
    expect(stored).toMatchObject({ status: 'NEW', convertedStudent: null, convertedAt: null });
    expect(await Student.countDocuments()).toBe(1);
    // So was the student number: the next student still gets ST-1001.
    const next = await request(app).post('/api/v1/students').set(admin.auth).send(studentBody());
    expect(next.body.data.studentNumber).toBe('ST-1001');
  });
});

describe('protected conversion fields', () => {
  it('ignores ownership and conversion fields sent to the convert endpoint', async () => {
    const lead = await leadFor(salesA);
    const res = await convert(salesA, lead.id, {
      advisor: salesB.id,
      studentNumber: 'ST-0001',
      createdBy: salesB.id,
      lead: MISSING_ID,
      conversion: { lead: MISSING_ID, source: 'ORGANIC' },
      activeEnrollments: 4,
    });
    expect(res.status).toBe(201);
    expect(res.body.data.student).toMatchObject({
      studentNumber: 'ST-1001',
      advisor: { id: salesA.id },
      createdBy: { id: salesA.id },
      activeEnrollments: 0,
      conversion: { leadId: lead.id, source: 'FACEBOOK_ADS' },
    });
  });

  it('cannot be set or faked through the ordinary lead and student endpoints', async () => {
    const lead = await leadFor(salesA);
    const fakeStudent = (await request(app).post('/api/v1/students').set(admin.auth).send(studentBody())).body.data;

    await request(app)
      .patch(`/api/v1/leads/${lead.id}`)
      .set(admin.auth)
      .send({ city: 'Cairo', convertedStudent: fakeStudent.id, convertedAt: new Date().toISOString(), status: 'REGISTERED' });
    expect(await Lead.findById(lead.id).lean()).toMatchObject({ city: 'Cairo', convertedStudent: null, status: 'NEW' });
    expect((await request(app).patch(`/api/v1/leads/${lead.id}/status`).set(admin.auth).send({ status: 'REGISTERED' })).status).toBe(400);
    expect((await request(app).post('/api/v1/leads').set(admin.auth).send(leadBody({ convertedStudent: fakeStudent.id }))).body.data.convertedStudent).toBeNull();

    const created = await request(app)
      .post('/api/v1/students')
      .set(admin.auth)
      .send(studentBody({ conversion: { lead: lead.id, leadReference: lead.reference, source: 'ORGANIC' }, lead: lead.id }));
    expect(created.body.data.conversion).toBeNull();
    await request(app)
      .patch(`/api/v1/students/${fakeStudent.id}`)
      .set(admin.auth)
      .send({ city: 'Giza', conversion: { lead: lead.id } });
    expect((await Student.findById(fakeStudent.id).lean())!.conversion).toBeNull();

    // The lead is still convertible: nothing above linked it.
    expect((await convert(admin, lead.id)).status).toBe(201);
  });
});

describe('after conversion', () => {
  it('the lead is frozen in REGISTERED, and the student follows normal enrollment rules', async () => {
    const lead = await leadFor(salesA);
    const { student } = (await convert(salesA, lead.id)).body.data;

    expect((await request(app).patch(`/api/v1/leads/${lead.id}/status`).set(salesA.auth).send({ status: 'NEW' })).body.code).toBe(
      'LEAD_CONVERTED',
    );
    const list = await request(app).get('/api/v1/leads?status=REGISTERED').set(admin.auth);
    expect(list.body.data.map((l: { id: string }) => l.id)).toEqual([lead.id]);

    const course = await createCourse(app, admin, { seats: 1 });
    expect((await enroll(app, salesA, student.id, { courseId: course.id })).status).toBe(201);
    expect((await request(app).get(`/api/v1/courses/${course.id}`).set(admin.auth)).body.data).toMatchObject({
      enrolledCount: 1,
      enrollable: false,
    });
  });
});
