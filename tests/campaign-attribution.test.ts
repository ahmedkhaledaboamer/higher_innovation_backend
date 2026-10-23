import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { Enrollment } from '../src/modules/enrollments/enrollment.model.js';
import { Lead } from '../src/modules/leads/lead.model.js';
import { Student } from '../src/modules/students/student.model.js';
import { useTestDatabase } from './helpers/db.js';
import { type Session, signedInAs } from './helpers/factories.js';
import { insertLead, leadBody } from './helpers/leads.js';

useTestDatabase({ roles: true });

const app = createApp();
const MISSING_ID = '665f1c2e9b3e4a0012345678';
type Actor = Awaited<ReturnType<typeof signedInAs>>;

let admin: Actor;
let marketing: Actor;
let salesA: Actor;
let salesB: Actor;
let running: { id: string; code: string };

async function campaign(overrides: Record<string, unknown> = {}) {
  const res = await request(app)
    .post('/api/v1/campaigns')
    .set(admin.auth)
    .send({ name: `C ${Math.random().toString(36).slice(2, 7)}`, platform: 'FACEBOOK_ADS', status: 'RUNNING', ...overrides });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as { id: string; code: string };
}
const createLead = (session: Session, data: Record<string, unknown> = {}) =>
  request(app).post('/api/v1/leads').set(session.auth).send(leadBody(data));
const metricsOf = async (id: string) =>
  (await request(app).get(`/api/v1/campaigns/${id}`).set(admin.auth)).body.data.metrics as { leads: number; registeredStudents: number };

beforeEach(async () => {
  admin = await signedInAs(app, 'ADMIN');
  marketing = await signedInAs(app, 'MARKETING');
  salesA = await signedInAs(app, 'SALES');
  salesB = await signedInAs(app, 'SALES');
  running = await campaign();
});

describe('attribution on lead creation', () => {
  it('Marketing and Admin can attribute a new lead; source and UTM are kept as sent', async () => {
    const res = await createLead(marketing, {
      campaignId: running.id,
      source: 'LANDING_PAGE',
      utm: { source: 'facebook', campaign: 'autumn' },
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({
      campaign: { id: running.id, code: running.code, archived: false },
      source: 'LANDING_PAGE',
      utm: { source: 'facebook', campaign: 'autumn' },
      assignedTo: null,
    });
    expect(res.body.data.campaignAttributedAt).toEqual(expect.any(String));
    expect((await createLead(admin, { campaignId: running.id })).status).toBe(201);
  });

  it('Sales cannot reference campaigns at all (no probing of campaign ids)', async () => {
    for (const campaignId of [running.id, MISSING_ID, null]) {
      const res = await createLead(salesA, { campaignId });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN_FIELD');
    }
    // Without the field, Sales creates leads as before (assigned to themselves, no campaign).
    const ok = await createLead(salesA);
    expect(ok.body.data).toMatchObject({ campaign: null, assignedTo: { id: salesA.id } });
  });

  it('rejects invalid, missing, archived and not-yet-started campaigns', async () => {
    const draft = await campaign({ status: 'DRAFT' });
    const scheduled = await campaign({ status: 'SCHEDULED' });
    const archived = await campaign();
    await request(app).post(`/api/v1/campaigns/${archived.id}/archive`).set(admin.auth);

    const cases: Array<[unknown, number, string]> = [
      ['not-an-id', 400, 'VALIDATION_ERROR'],
      [MISSING_ID, 400, 'CAMPAIGN_NOT_FOUND'],
      [archived.id, 409, 'CAMPAIGN_ARCHIVED'],
      [draft.id, 409, 'CAMPAIGN_NOT_STARTED'],
      [scheduled.id, 409, 'CAMPAIGN_NOT_STARTED'],
    ];
    for (const [campaignId, status, code] of cases) {
      const res = await createLead(marketing, { campaignId });
      expect(res.status, code).toBe(status);
      expect(res.body.code).toBe(code);
    }
    expect(await Lead.countDocuments()).toBe(0);
  });

  it('accepts PAUSED and COMPLETED campaigns (late leads are real)', async () => {
    const paused = await campaign();
    await request(app).patch(`/api/v1/campaigns/${paused.id}/status`).set(admin.auth).send({ status: 'PAUSED' });
    const completed = await campaign();
    await request(app).patch(`/api/v1/campaigns/${completed.id}/status`).set(admin.auth).send({ status: 'COMPLETED' });
    expect((await createLead(marketing, { campaignId: paused.id })).status).toBe(201);
    expect((await createLead(marketing, { campaignId: completed.id })).status).toBe(201);
  });

  it('still detects duplicate contacts when a campaign is attached (sequential)', async () => {
    await createLead(marketing, { campaignId: running.id, email: 'dup@example.com' });
    const dup = await createLead(marketing, { campaignId: running.id, email: 'dup@example.com' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('DUPLICATE_LEAD');
  });
});

describe('editing never silently changes attribution', () => {
  it('PATCH /leads/:id ignores campaignId; PATCH /leads/:id/campaign is explicit and Owner/Admin only', async () => {
    const other = await campaign();
    const lead = (await createLead(marketing, { campaignId: running.id, source: 'GOOGLE_ADS', utm: { campaign: 'x1' } })).body.data;

    const edit = await request(app).patch(`/api/v1/leads/${lead.id}`).set(admin.auth).send({ city: 'Dubai', campaignId: other.id, campaign: other.id });
    expect(edit.status).toBe(200);
    expect(edit.body.data.campaign.id).toBe(running.id);

    for (const actor of [marketing, salesA]) {
      const res = await request(app).patch(`/api/v1/leads/${lead.id}/campaign`).set(actor.auth).send({ campaignId: other.id });
      expect(res.status).toBe(403);
    }

    const reattributed = await request(app).patch(`/api/v1/leads/${lead.id}/campaign`).set(admin.auth).send({ campaignId: other.id });
    expect(reattributed.status).toBe(200);
    expect(reattributed.body.data).toMatchObject({ campaign: { id: other.id }, source: 'GOOGLE_ADS', utm: { campaign: 'x1' } });

    const cleared = await request(app).patch(`/api/v1/leads/${lead.id}/campaign`).set(admin.auth).send({ campaignId: null });
    expect(cleared.body.data).toMatchObject({ campaign: null, campaignAttributedAt: null });
  });

  it('re-attribution validates the target campaign, the lead id and the archive state', async () => {
    const draft = await campaign({ status: 'DRAFT' });
    const lead = (await createLead(marketing, { campaignId: running.id })).body.data;
    const setCampaign = (id: string, campaignId: unknown) =>
      request(app).patch(`/api/v1/leads/${id}/campaign`).set(admin.auth).send({ campaignId });

    expect((await setCampaign(lead.id, draft.id)).body.code).toBe('CAMPAIGN_NOT_STARTED');
    expect((await setCampaign(lead.id, MISSING_ID)).body.code).toBe('CAMPAIGN_NOT_FOUND');
    expect((await setCampaign(lead.id, 'x')).status).toBe(400);
    expect((await request(app).patch(`/api/v1/leads/${lead.id}/campaign`).set(admin.auth).send({})).status).toBe(400);
    expect((await setCampaign(MISSING_ID, running.id)).status).toBe(404);

    await request(app).post(`/api/v1/leads/${lead.id}/archive`).set(admin.auth);
    expect((await setCampaign(lead.id, null)).body.code).toBe('LEAD_ARCHIVED');
  });
});

describe('historical attribution', () => {
  it('keeps attribution when the campaign is completed or archived, flagged in responses', async () => {
    const lead = (await createLead(marketing, { campaignId: running.id })).body.data;
    await request(app).patch(`/api/v1/campaigns/${running.id}/status`).set(admin.auth).send({ status: 'COMPLETED' });
    await request(app).post(`/api/v1/campaigns/${running.id}/archive`).set(admin.auth);

    const reread = await request(app).get(`/api/v1/leads/${lead.id}`).set(admin.auth);
    expect(reread.body.data.campaign).toMatchObject({ id: running.id, archived: true });

    // Other edits on the lead keep working and keep the attribution.
    const edited = await request(app).patch(`/api/v1/leads/${lead.id}`).set(admin.auth).send({ city: 'Sharjah' });
    expect(edited.body.data.campaign.id).toBe(running.id);
    // But the archived campaign cannot be newly assigned to another lead.
    expect((await createLead(marketing, { campaignId: running.id })).body.code).toBe('CAMPAIGN_ARCHIVED');
  });

  it('pre-Phase 7 leads (no campaign field stored) read as unattributed', async () => {
    const legacy = await insertLead(admin.id);
    await Lead.collection.updateOne({ _id: legacy._id }, { $unset: { campaign: '', campaignAttributedAt: '', campaignAttributedBy: '' } });
    const res = await request(app).get(`/api/v1/leads/${legacy.id}`).set(admin.auth);
    expect(res.body.data).toMatchObject({ campaign: null, campaignAttributedAt: null });
    expect((await request(app).get('/api/v1/leads?campaign=none').set(admin.auth)).body.data.map((l: { id: string }) => l.id)).toContain(legacy.id);
  });
});

describe('conversion keeps campaign attribution as a snapshot', () => {
  it('copies the campaign into student.conversion; later re-attribution does not change it', async () => {
    const other = await campaign();
    const lead = (await request(app).post('/api/v1/leads').set(admin.auth).send(leadBody({ campaignId: running.id, assignedTo: salesA.id, utm: { source: 'fb' } }))).body.data;

    const converted = await request(app).post(`/api/v1/leads/${lead.id}/convert`).set(salesA.auth);
    expect(converted.status).toBe(201);
    expect(converted.body.data.student.conversion).toMatchObject({
      leadId: lead.id,
      source: lead.source,
      utm: { source: 'fb' },
      campaign: { id: running.id, code: running.code },
    });
    expect(converted.body.data.lead).toMatchObject({ status: 'REGISTERED', campaign: { id: running.id } });
    expect(await Enrollment.countDocuments()).toBe(0);
    expect((await metricsOf(running.id)).registeredStudents).toBe(1);

    await request(app).patch(`/api/v1/leads/${lead.id}/campaign`).set(admin.auth).send({ campaignId: other.id });
    const student = await Student.findById(converted.body.data.student.id).lean();
    expect(student!.conversion!.campaign!.toString()).toBe(running.id);
    expect((await metricsOf(running.id)).registeredStudents).toBe(0);
    expect((await metricsOf(other.id)).registeredStudents).toBe(1);
  });

  it('converting a lead without a campaign still works exactly as in Phase 5', async () => {
    const lead = (await request(app).post('/api/v1/leads').set(admin.auth).send(leadBody({ assignedTo: salesA.id }))).body.data;
    const converted = await request(app).post(`/api/v1/leads/${lead.id}/convert`).set(salesA.auth);
    expect(converted.status).toBe(201);
    expect(converted.body.data.student.conversion.campaign).toBeNull();
  });
});

describe('lead visibility is unchanged', () => {
  it('the campaign filter stays inside the caller\'s lead scope', async () => {
    await request(app).post('/api/v1/leads').set(admin.auth).send(leadBody({ campaignId: running.id, assignedTo: salesA.id }));
    await request(app).post('/api/v1/leads').set(admin.auth).send(leadBody({ campaignId: running.id, assignedTo: salesB.id }));
    await request(app).post('/api/v1/leads').set(admin.auth).send(leadBody({ campaignId: running.id }));

    expect((await request(app).get(`/api/v1/leads?campaign=${running.id}`).set(admin.auth)).body.meta.total).toBe(3);
    const salesView = await request(app).get(`/api/v1/leads?campaign=${running.id}`).set(salesA.auth);
    expect(salesView.body.meta.total).toBe(1);
    expect(salesView.body.data[0].assignedTo.id).toBe(salesA.id);
    // Sales sees only the campaign reference on their own lead, and still cannot open the campaign.
    expect(salesView.body.data[0].campaign).toEqual({ id: running.id, code: running.code, name: expect.any(String), archived: false });
    expect((await request(app).get(`/api/v1/campaigns/${running.id}`).set(salesA.auth)).status).toBe(403);
    expect((await request(app).get('/api/v1/leads?campaign=nope').set(admin.auth)).status).toBe(400);
  });

  it('metrics count every attributed lead regardless of who is assigned', async () => {
    await request(app).post('/api/v1/leads').set(admin.auth).send(leadBody({ campaignId: running.id, assignedTo: salesA.id }));
    await request(app).post('/api/v1/leads').set(admin.auth).send(leadBody({ campaignId: running.id, assignedTo: salesB.id }));
    expect((await metricsOf(running.id)).leads).toBe(2);
  });
});

describe('metrics under concurrency', () => {
  it('stay exact while leads are created, archived and re-attributed concurrently', async () => {
    const other = await campaign();
    const created = await Promise.all(
      Array.from({ length: 8 }, () => createLead(marketing, { campaignId: running.id })),
    );
    expect(created.every((r) => r.status === 201)).toBe(true);
    const ids = created.map((r) => r.body.data.id as string);

    await Promise.all([
      request(app).post(`/api/v1/leads/${ids[0]}/archive`).set(admin.auth),
      request(app).post(`/api/v1/leads/${ids[1]}/archive`).set(admin.auth),
      request(app).patch(`/api/v1/leads/${ids[2]}/campaign`).set(admin.auth).send({ campaignId: other.id }),
      createLead(marketing, { campaignId: running.id }),
    ]);

    const expected = await Lead.countDocuments({ campaign: running.id, archivedAt: null });
    expect(expected).toBe(6);
    expect((await metricsOf(running.id)).leads).toBe(expected);
    expect((await metricsOf(other.id)).leads).toBe(1);
  });
});
