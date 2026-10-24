import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/createApp.js';
import { buildRange, bucketKeys, previousRange, todayInReportZone } from '../src/modules/reports/reportRange.js';
import type { RoleKey } from '../src/modules/roles/permissions.js';
import { createCourse, createStudent, enroll, setEnrollmentStatus } from './helpers/academy.js';
import { useTestDatabase } from './helpers/db.js';
import { createUser, signedInAs } from './helpers/factories.js';
import { insertLead, leadBody } from './helpers/leads.js';

useTestDatabase({ roles: true });

const app = createApp();
type Actor = Awaited<ReturnType<typeof signedInAs>>;
let admin: Actor;

beforeEach(async () => {
  admin = await signedInAs(app, 'ADMIN');
});

const get = (path: string, actor: Actor = admin) => request(app).get(`/api/v1/reports${path}`).set(actor.auth);
/** UTC instant for a Dubai wall-clock time (UTC+4). */
const dubai = (isoLocal: string) => new Date(new Date(`${isoLocal}Z`).getTime() - 4 * 3_600_000);

describe('report calendar (Asia/Dubai)', () => {
  it('maps calendar days to instants and buckets', () => {
    const range = buildRange('2026-10-01', '2026-10-31');
    expect(range.start.toISOString()).toBe('2026-09-30T20:00:00.000Z');
    expect(range.end.toISOString()).toBe('2026-10-31T20:00:00.000Z');
    expect(range.days).toBe(31);
    expect(previousRange(range)).toMatchObject({ from: '2026-08-31', to: '2026-09-30', days: 31 });

    expect(bucketKeys(buildRange('2026-10-29', '2026-11-02'), 'day')).toEqual([
      '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02',
    ]);
    // Weeks start on Monday: 2026-10-01 is a Thursday.
    expect(bucketKeys(buildRange('2026-10-01', '2026-10-19'), 'week')).toEqual(['2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19']);
    expect(bucketKeys(buildRange('2026-11-15', '2027-01-03'), 'month')).toEqual(['2026-11-01', '2026-12-01', '2027-01-01']);
    // 21:00 UTC is already the next day in Dubai.
    expect(todayInReportZone(new Date('2026-10-18T21:00:00Z'))).toBe('2026-10-19');
  });
});

describe('GET /reports/leads/summary', () => {
  async function fixture() {
    const sales = await createUser({ role: 'SALES' });
    const statuses = ['NEW', 'NEW', 'CONTACTED', 'QUALIFIED', 'PAYMENT_PENDING', 'REGISTERED', 'LOST'] as const;
    for (const status of statuses) {
      await insertLead(admin.id, {
        status,
        createdAt: dubai('2026-10-05T10:00:00'),
        source: status === 'LOST' ? 'GOOGLE_ADS' : 'FACEBOOK_ADS',
        assignedTo: status === 'NEW' ? sales.id : null,
        country: status === 'QUALIFIED' ? 'Egypt' : 'UAE',
        ...(status === 'REGISTERED' ? { convertedAt: dubai('2026-10-06T09:00:00') } : {}),
      });
    }
    // Excluded: archived, and outside the range.
    await insertLead(admin.id, { status: 'NEW', createdAt: dubai('2026-10-05T10:00:00'), archivedAt: new Date() });
    await insertLead(admin.id, { status: 'NEW', createdAt: dubai('2026-09-20T10:00:00') });
    // Created before the range but converted inside it: a conversion, not part of the cohort.
    await insertLead(admin.id, { status: 'REGISTERED', createdAt: dubai('2026-09-10T10:00:00'), convertedAt: dubai('2026-10-07T12:00:00') });
    return { sales };
  }

  it('counts the cohort by current status, conversions by date, and the funnel', async () => {
    await fixture();
    const res = await get('/leads/summary?from=2026-10-01&to=2026-10-31');
    expect(res.status).toBe(200);
    expect(res.body.data.range).toEqual({ from: '2026-10-01', to: '2026-10-31', days: 31, timezone: 'Asia/Dubai' });
    expect(res.body.data.summary).toMatchObject({
      leads: 7,
      qualified: 3, // QUALIFIED, PAYMENT_PENDING, REGISTERED
      converted: 1,
      lost: 1,
      open: 5,
      conversionRate: 0.1429,
      conversionsInRange: 2, // includes the September lead converted on Oct 7
    });
    expect(res.body.data.summary.byStatus).toMatchObject({ NEW: 2, CONTACTED: 1, QUALIFIED: 1, PAYMENT_PENDING: 1, REGISTERED: 1, LOST: 1, INTERESTED: 0 });

    const stages = Object.fromEntries(res.body.data.funnel.stages.map((s: { stage: string; value: number }) => [s.stage, s.value]));
    expect(stages).toEqual({ NEW: 6, CONTACTED: 4, INTERESTED: 3, QUALIFIED: 3, MEETING_SCHEDULED: 2, PAYMENT_PENDING: 2, REGISTERED: 1 });
    expect(res.body.data.funnel.lost).toBe(1);
    expect(res.body.data.funnel.stages[1]).toMatchObject({ conversionFromPrevious: 0.6667, conversionFromTop: 0.6667 });
  });

  it('applies validated filters', async () => {
    const { sales } = await fixture();
    const leads = async (query: string) => (await get(`/leads/summary?from=2026-10-01&to=2026-10-31&${query}`)).body.data.summary.leads;
    expect(await leads('source=GOOGLE_ADS')).toBe(1);
    expect(await leads(`assignedTo=${sales.id}`)).toBe(2);
    expect(await leads('assignedTo=unassigned')).toBe(5);
    expect(await leads('country=egypt')).toBe(1);
    expect(await leads('campaign=none')).toBe(7);
    expect((await get('/leads/summary?status[$ne]=X&from=2026-10-01&to=2026-10-31')).body.data.summary.leads).toBe(7);
  });

  it('compares with the previous period and handles zero denominators', async () => {
    await fixture();
    const res = await get('/leads/summary?from=2026-10-01&to=2026-10-31&compare=true');
    expect(res.body.data.previous.range).toMatchObject({ from: '2026-08-31', to: '2026-09-30' });
    expect(res.body.data.previous.summary.leads).toBe(2); // Sep 10 and Sep 20
    expect(res.body.data.change.leads).toEqual({ absolute: 5, relative: 2.5 });

    const empty = await get('/leads/summary?from=2020-01-01&to=2020-01-31&compare=true');
    expect(empty.body.data.summary).toMatchObject({ leads: 0, conversionRate: 0, conversionsInRange: 0 });
    expect(empty.body.data.funnel.stages.every((s: { value: number; conversionFromTop: number }) => s.value === 0 && s.conversionFromTop === 0)).toBe(true);
    expect(empty.body.data.change.leads).toEqual({ absolute: 0, relative: null });
  });

  it('respects Dubai day boundaries', async () => {
    await insertLead(admin.id, { createdAt: new Date('2026-10-01T19:59:59.999Z') }); // Oct 1, 23:59:59 Dubai
    await insertLead(admin.id, { createdAt: new Date('2026-10-01T20:00:00.000Z') }); // Oct 2, 00:00 Dubai
    expect((await get('/leads/summary?from=2026-10-01&to=2026-10-01')).body.data.summary.leads).toBe(1);
    expect((await get('/leads/summary?from=2026-10-02&to=2026-10-02')).body.data.summary.leads).toBe(1);
  });

  it('validates the range', async () => {
    for (const query of ['from=2026-10-05&to=2026-10-01', 'from=2026/10/01', 'from=2020-01-01&to=2026-01-31', 'compare=maybe', 'source=TV']) {
      const res = await get(`/leads/summary?${query}`);
      expect(res.status, query).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    }
    // Defaults: the last 30 days including today.
    const res = await get('/leads/summary');
    expect(res.body.data.range).toMatchObject({ to: todayInReportZone(), days: 30 });
  });
});

describe('GET /reports/leads/timeseries', () => {
  it('returns zero-filled buckets for cohort and conversion series', async () => {
    await insertLead(admin.id, { status: 'QUALIFIED', createdAt: dubai('2026-10-02T08:00:00') });
    await insertLead(admin.id, { status: 'REGISTERED', createdAt: dubai('2026-10-02T09:00:00'), convertedAt: dubai('2026-10-04T10:00:00') });
    await insertLead(admin.id, { status: 'LOST', createdAt: dubai('2026-10-04T23:30:00') });

    const daily = await get('/leads/timeseries?from=2026-10-01&to=2026-10-05&interval=day');
    expect(daily.body.data.points).toEqual([
      { period: '2026-10-01', leads: 0, qualified: 0, converted: 0, lost: 0, conversions: 0 },
      { period: '2026-10-02', leads: 2, qualified: 2, converted: 1, lost: 0, conversions: 0 },
      { period: '2026-10-03', leads: 0, qualified: 0, converted: 0, lost: 0, conversions: 0 },
      { period: '2026-10-04', leads: 1, qualified: 0, converted: 0, lost: 1, conversions: 1 },
      { period: '2026-10-05', leads: 0, qualified: 0, converted: 0, lost: 0, conversions: 0 },
    ]);

    const weekly = await get('/leads/timeseries?from=2026-10-01&to=2026-10-12&interval=week');
    expect(weekly.body.data.points.map((p: { period: string; leads: number }) => [p.period, p.leads])).toEqual([
      ['2026-09-28', 3],
      ['2026-10-05', 0],
      ['2026-10-12', 0],
    ]);
    const monthly = await get('/leads/timeseries?from=2026-09-15&to=2026-10-31&interval=month');
    expect(monthly.body.data.points.map((p: { period: string; leads: number }) => [p.period, p.leads])).toEqual([
      ['2026-09-01', 0],
      ['2026-10-01', 3],
    ]);
  });

  it('bounds the range per interval', async () => {
    expect((await get('/leads/timeseries?from=2026-01-01&to=2026-06-30&interval=day')).status).toBe(400);
    expect((await get('/leads/timeseries?from=2026-01-01&to=2026-06-30&interval=week')).status).toBe(200);
    expect((await get('/leads/timeseries?interval=hour')).status).toBe(400);
  });
});

describe('GET /reports/leads/breakdown', () => {
  it('groups by every dimension with labels, shares and pagination', async () => {
    const salesA = await createUser({ role: 'SALES', firstName: 'Amal' });
    const created = dubai('2026-10-10T10:00:00');
    const campaign = (
      await request(app).post('/api/v1/campaigns').set(admin.auth).send({ name: 'Winter Push', platform: 'GOOGLE_ADS', status: 'RUNNING' })
    ).body.data;
    await insertLead(admin.id, { createdAt: created, source: 'FACEBOOK_ADS', country: 'Egypt', assignedTo: salesA.id, campaign: campaign.id, status: 'REGISTERED' });
    await insertLead(admin.id, { createdAt: created, source: 'FACEBOOK_ADS', country: 'EGYPT', assignedTo: salesA.id });
    await insertLead(admin.id, { createdAt: created, source: 'WEBSITE', country: null });
    await insertLead(admin.id, { createdAt: created, source: 'FACEBOOK_ADS', country: 'Jordan', archivedAt: new Date() }); // excluded

    const by = async (groupBy: string, extra = '') =>
      (await get(`/leads/breakdown?from=2026-10-01&to=2026-10-31&groupBy=${groupBy}${extra}`)).body;

    const source = await by('source');
    expect(source.data.totalLeads).toBe(3);
    expect(source.data.rows).toEqual([
      expect.objectContaining({ key: 'FACEBOOK_ADS', leads: 2, converted: 1, conversionRate: 0.5, share: 0.6667 }),
      expect.objectContaining({ key: 'WEBSITE', leads: 1, converted: 0, share: 0.3333 }),
    ]);
    expect(source.meta).toEqual({ page: 1, limit: 20, total: 2, totalPages: 1 });

    expect((await by('campaign')).data.rows.map((r: { key: string | null; label: string; leads: number }) => [r.key, r.label, r.leads])).toEqual([
      [null, '(no campaign)', 2],
      [campaign.id, `Winter Push (${campaign.code})`, 1],
    ]);
    expect((await by('assignee')).data.rows.map((r: { label: string; leads: number; converted: number }) => [r.label, r.leads, r.converted])).toEqual([
      ['Amal User', 2, 1],
      ['(unassigned)', 1, 0],
    ]);
    // Countries merge case-insensitively; missing ones are "(not set)".
    expect((await by('country')).data.rows.map((r: { key: string | null; leads: number }) => [r.key, r.leads])).toEqual([
      ['egypt', 2],
      [null, 1],
    ]);
    expect((await by('status')).data.rows.map((r: { key: string }) => r.key).sort()).toEqual(['NEW', 'REGISTERED']);

    const paged = await by('source', '&limit=1&page=2');
    expect(paged.meta).toEqual({ page: 2, limit: 1, total: 2, totalPages: 2 });
    expect(paged.data.rows.map((r: { key: string }) => r.key)).toEqual(['WEBSITE']);

    for (const bad of ['groupBy=course', 'groupBy=source&limit=500', 'groupBy=source&campaign=x', '']) {
      expect((await get(`/leads/breakdown?${bad}`)).status, bad).toBe(400);
    }
  });
});

describe('GET /reports/campaigns', () => {
  it('summarises the portfolio and platforms from stored data only', async () => {
    const post = (data: object) => request(app).post('/api/v1/campaigns').set(admin.auth).send(data);
    const fb = (await post({ name: 'FB 1', platform: 'FACEBOOK_ADS', status: 'RUNNING', budget: 10000, spent: 3000 })).body.data;
    const fb2 = (await post({ name: 'FB 2', platform: 'FACEBOOK_ADS', status: 'RUNNING', budget: 5000, spent: 1000 })).body.data;
    expect((await request(app).patch(`/api/v1/campaigns/${fb2.id}/status`).set(admin.auth).send({ status: 'PAUSED' })).status).toBe(200);
    const google = (await post({ name: 'G 1', platform: 'GOOGLE_ADS', status: 'DRAFT', spent: 0 })).body.data;
    const archived = (await post({ name: 'Old', platform: 'TIKTOK', status: 'RUNNING', spent: 9999 })).body.data;
    await request(app).post(`/api/v1/campaigns/${archived.id}/archive`).set(admin.auth);

    await insertLead(admin.id, { campaign: fb.id, status: 'REGISTERED', createdAt: dubai('2026-10-03T10:00:00') });
    await insertLead(admin.id, { campaign: fb.id, status: 'NEW', createdAt: dubai('2026-08-03T10:00:00') });
    await insertLead(admin.id, { campaign: fb.id, status: 'NEW', archivedAt: new Date() });
    await insertLead(admin.id, { campaign: google.id });
    await insertLead(admin.id, { createdAt: dubai('2026-10-04T10:00:00') }); // unattributed

    const res = await get('/campaigns?from=2026-10-01&to=2026-10-31');
    expect(res.status).toBe(200);
    expect(res.body.data.portfolio).toEqual({
      total: 3,
      byStatus: { DRAFT: 1, SCHEDULED: 0, RUNNING: 1, PAUSED: 1, COMPLETED: 0 },
      budget: 15000,
      spent: 4000,
    });
    const facebook = res.body.data.rows.find((r: { platform: string }) => r.platform === 'FACEBOOK_ADS');
    expect(facebook).toEqual({
      platform: 'FACEBOOK_ADS',
      campaigns: 2,
      budget: 15000,
      spent: 4000,
      leads: 2,
      converted: 1,
      leadsInRange: 1,
      costPerLead: 2000,
      costPerConversion: 4000,
      spendShare: 1,
    });
    expect(res.body.data.rows.map((r: { platform: string }) => r.platform).sort()).toEqual(['FACEBOOK_ADS', 'GOOGLE_ADS']);
    expect(res.body.data.rows.find((r: { platform: string }) => r.platform === 'GOOGLE_ADS')).toMatchObject({ leads: 1, costPerLead: 0, costPerConversion: null });
    expect(res.body.data).toMatchObject({ unattributedLeads: 1, unattributedLeadsInRange: 1 });
    expect(JSON.stringify(res.body.data)).not.toMatch(/revenue|roas|impressions|clicks/i);
  });
});

describe('GET /reports/academy', () => {
  it('distinguishes converted leads from enrolled students and never double-counts', async () => {
    const sales = await createUser({ role: 'SALES' });
    const courseA = await createCourse(app, admin, { seats: 4, code: 'POP-1' });
    const courseB = await createCourse(app, admin, { seats: 2 });
    await createCourse(app, admin); // unlimited seats
    const archivedCourse = await createCourse(app, admin, { seats: 10 });
    await request(app).post(`/api/v1/courses/${archivedCourse.id}/archive`).set(admin.auth);

    // Student with two enrollments (counted once), one direct student without enrollments,
    // one converted student without enrollments.
    const multi = await createStudent(app, admin, { country: 'Egypt' });
    await createStudent(app, admin, { country: 'egypt', status: 'PENDING' });
    const lead = (await request(app).post('/api/v1/leads').set(admin.auth).send(leadBody({ assignedTo: sales.id }))).body.data;
    await request(app).post(`/api/v1/leads/${lead.id}/convert`).set(admin.auth);

    const e1 = (await enroll(app, admin, multi.id, { courseId: courseA.id })).body.data.id;
    await enroll(app, admin, multi.id, { courseId: courseB.id });
    const withdrawnStudent = await createStudent(app, admin);
    const e3 = (await enroll(app, admin, withdrawnStudent.id, { courseId: courseA.id })).body.data.id;
    await setEnrollmentStatus(app, admin, e3, 'WITHDRAWN');
    await setEnrollmentStatus(app, admin, e1, 'COMPLETED');

    const res = await get('/academy');
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.students).toMatchObject({
      total: 4,
      withActiveEnrollments: 1, // only `multi` (2 enrollments → counted once); withdrawn student not counted
      fromLeadConversion: 1,
      createdDirectly: 3,
    });
    expect(data.students.byStatus).toMatchObject({ ACTIVE: 3, PENDING: 1 });
    expect(data.enrollments).toMatchObject({ total: 3, active: 2, enrolledInRange: 3, completedInRange: 1, withdrawnInRange: 1 });
    expect(data.enrollments.byStatus).toMatchObject({ COMPLETED: 1, NOT_STARTED: 1, WITHDRAWN: 1 });
    expect(data.courses).toMatchObject({
      total: 3, // archived course excluded
      limitedCourses: 2,
      unlimitedCourses: 1,
      seats: 6,
      seatsTaken: 2,
      fillRate: 0.3333,
      fullCourses: 0,
    });
    expect(data.popularCourses[0]).toMatchObject({ code: 'POP-1', enrollments: 2, archived: false });
    // "Egypt" and "egypt" merge into one row; students without a country form their own row.
    expect(data.countries).toEqual(
      expect.arrayContaining([
        { key: 'egypt', label: expect.stringMatching(/^egypt$/i), students: 2 },
        { key: null, label: '(not set)', students: 2 },
      ]),
    );
    expect(data.countries).toHaveLength(2);
    expect(data.trend.at(-1)).toMatchObject({ enrolled: 3, completed: 1 });
  });
});

describe('report permissions', () => {
  it('matches the role matrix on every report endpoint', async () => {
    const expected: Record<RoleKey, { leads: number; campaigns: number; academy: number }> = {
      OWNER: { leads: 200, campaigns: 200, academy: 200 },
      ADMIN: { leads: 200, campaigns: 200, academy: 200 },
      MARKETING: { leads: 200, campaigns: 200, academy: 403 },
      VIEWER: { leads: 200, campaigns: 200, academy: 200 },
      SALES: { leads: 403, campaigns: 403, academy: 403 },
      HR: { leads: 403, campaigns: 403, academy: 403 },
      TRAINER: { leads: 403, campaigns: 403, academy: 403 },
    };
    for (const [role, codes] of Object.entries(expected) as Array<[RoleKey, { leads: number; campaigns: number; academy: number }]>) {
      const actor = role === 'ADMIN' ? admin : await signedInAs(app, role);
      for (const path of ['/leads/summary', '/leads/timeseries', '/leads/breakdown?groupBy=source']) {
        expect((await get(path, actor)).status, `${role} ${path}`).toBe(codes.leads);
      }
      expect((await get('/campaigns', actor)).status, `${role} campaigns`).toBe(codes.campaigns);
      expect((await get('/academy', actor)).status, `${role} academy`).toBe(codes.academy);
    }
    for (const path of ['/leads/summary', '/campaigns', '/academy']) {
      expect((await request(app).get(`/api/v1/reports${path}`)).status).toBe(401);
    }
  });
});
