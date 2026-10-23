import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { Lead } from '../src/modules/leads/lead.model.js';
import type { RoleKey } from '../src/modules/roles/permissions.js';
import { useTestDatabase } from './helpers/db.js';
import { signedInAs } from './helpers/factories.js';
import { leadBody } from './helpers/leads.js';

useTestDatabase({ roles: true });

const app = createApp();
type Actor = Awaited<ReturnType<typeof signedInAs>>;

let admin: Actor;
let salesA: Actor;
let salesB: Actor;
let leadOfA: string;
let leadOfB: string;
let unassignedLead: string;

beforeEach(async () => {
  admin = await signedInAs(app, 'ADMIN');
  salesA = await signedInAs(app, 'SALES');
  salesB = await signedInAs(app, 'SALES');

  const create = async (body: object) =>
    (await request(app).post('/api/v1/leads').set(admin.auth).send(body)).body.data.id as string;
  leadOfA = await create(leadBody({ fullName: 'Lead Of A', assignedTo: salesA.id }));
  leadOfB = await create(leadBody({ fullName: 'Lead Of B', assignedTo: salesB.id }));
  unassignedLead = await create(leadBody({ fullName: 'Unassigned Lead' }));
});

/** Every lead endpoint, so each role can be checked against all of them. */
function endpoints(actor: Actor, id: string) {
  return {
    list: () => request(app).get('/api/v1/leads').set(actor.auth),
    get: () => request(app).get(`/api/v1/leads/${id}`).set(actor.auth),
    create: () => request(app).post('/api/v1/leads').set(actor.auth).send(leadBody()),
    update: () => request(app).patch(`/api/v1/leads/${id}`).set(actor.auth).send({ city: 'Cairo' }),
    status: () => request(app).patch(`/api/v1/leads/${id}/status`).set(actor.auth).send({ status: 'CONTACTED' }),
    assign: () => request(app).patch(`/api/v1/leads/${id}/assign`).set(actor.auth).send({ assignedTo: salesA.id }),
    archive: () => request(app).post(`/api/v1/leads/${id}/archive`).set(actor.auth),
    restore: () => request(app).post(`/api/v1/leads/${id}/restore`).set(actor.auth),
    notes: () => request(app).get(`/api/v1/leads/${id}/notes`).set(actor.auth),
    addNote: () => request(app).post(`/api/v1/leads/${id}/notes`).set(actor.auth).send({ body: 'Hi' }),
  };
}

const ALL = ['list', 'get', 'create', 'update', 'status', 'assign', 'archive', 'restore', 'notes', 'addNote'] as const;
type Action = (typeof ALL)[number];

/**
 * Expected outcome for a lead that is NOT assigned to the caller.
 * 2xx = allowed; 403 = role lacks the permission; restore on a non-archived lead is 409 when permitted.
 */
const MATRIX: Record<RoleKey, Record<Action, number>> = {
  OWNER: { list: 200, get: 200, create: 201, update: 200, status: 200, assign: 200, archive: 200, restore: 409, notes: 200, addNote: 201 },
  ADMIN: { list: 200, get: 200, create: 201, update: 200, status: 200, assign: 200, archive: 200, restore: 409, notes: 200, addNote: 201 },
  MARKETING: { list: 200, get: 200, create: 201, update: 403, status: 403, assign: 403, archive: 403, restore: 403, notes: 200, addNote: 403 },
  // A Sales user is allowed to list, but cannot see this lead (it is not theirs): 404, not 403.
  SALES: { list: 200, get: 404, create: 201, update: 404, status: 404, assign: 403, archive: 403, restore: 403, notes: 404, addNote: 404 },
  HR: { list: 403, get: 403, create: 403, update: 403, status: 403, assign: 403, archive: 403, restore: 403, notes: 403, addNote: 403 },
  TRAINER: { list: 403, get: 403, create: 403, update: 403, status: 403, assign: 403, archive: 403, restore: 403, notes: 403, addNote: 403 },
  VIEWER: { list: 200, get: 200, create: 403, update: 403, status: 403, assign: 403, archive: 403, restore: 403, notes: 200, addNote: 403 },
};

describe('role matrix for a lead the caller does not own', () => {
  for (const role of Object.keys(MATRIX) as RoleKey[]) {
    it(`${role}`, async () => {
      // Archive runs last so it does not affect the other calls.
      const actor = role === 'SALES' ? salesB : await signedInAs(app, role);
      const target = role === 'SALES' ? leadOfA : unassignedLead;
      const calls = endpoints(actor, target);

      const ordered: Action[] = [...ALL.filter((a) => a !== 'archive'), 'archive'];
      for (const action of ordered) {
        const res = await calls[action]();
        expect(res.status, `${role} ${action}: ${JSON.stringify(res.body)}`).toBe(MATRIX[role][action]);
      }
    });
  }

  it('requires authentication for every endpoint', async () => {
    const anonymous = { auth: {} } as unknown as Actor;
    for (const action of ALL) {
      expect((await endpoints(anonymous, leadOfA)[action]()).status, action).toBe(401);
    }
  });
});

describe('Sales visibility', () => {
  it('lists only the leads assigned to the caller, whatever filters are sent', async () => {
    const list = (query = '') => request(app).get(`/api/v1/leads${query}`).set(salesA.auth);
    const ids = (res: request.Response) => res.body.data.map((l: { id: string }) => l.id);

    expect(ids(await list())).toEqual([leadOfA]);
    expect((await list()).body.meta.total).toBe(1);

    // Trying to widen the scope through filters finds nothing.
    expect(ids(await list(`?assignedTo=${salesB.id}`))).toEqual([]);
    expect(ids(await list('?assignedTo=unassigned'))).toEqual([]);
    expect(ids(await list(`?assignedTo=${salesA.id},${salesB.id},unassigned`))).toEqual([leadOfA]);
    expect(ids(await list('?search=Lead Of B'))).toEqual([]);
    expect(ids(await list('?archived=true'))).toEqual([]);
  });

  it('cannot read or change another salesperson\'s lead by id', async () => {
    const own = endpoints(salesA, leadOfA);
    const other = endpoints(salesA, leadOfB);

    expect((await own.get()).status).toBe(200);
    expect((await own.update()).status).toBe(200);
    expect((await own.status()).status).toBe(200);
    expect((await own.addNote()).status).toBe(201);

    for (const action of ['get', 'update', 'status', 'notes', 'addNote'] as const) {
      const res = await other[action]();
      expect(res.status, action).toBe(404);
      expect(res.body.code).toBe('LEAD_NOT_FOUND');
    }
    const untouched = await Lead.findById(leadOfB).lean();
    expect(untouched).toMatchObject({ status: 'NEW', city: null, notesCount: 0 });
  });

  it('owns the leads they create and cannot assign leads to anyone', async () => {
    const created = await request(app).post('/api/v1/leads').set(salesA.auth).send(leadBody());
    expect(created.status).toBe(201);
    expect(created.body.data.assignedTo.id).toBe(salesA.id);

    const toOther = await request(app).post('/api/v1/leads').set(salesA.auth).send(leadBody({ assignedTo: salesB.id }));
    expect(toOther.status).toBe(403);
    expect(toOther.body.code).toBe('FORBIDDEN_FIELD');

    const unassign = await request(app).post('/api/v1/leads').set(salesA.auth).send(leadBody({ assignedTo: null }));
    expect(unassign.status).toBe(403);
  });

  it('cannot move their own lead to someone else through any endpoint', async () => {
    const reassign = await request(app).patch(`/api/v1/leads/${leadOfA}/assign`).set(salesA.auth).send({ assignedTo: salesB.id });
    expect(reassign.status).toBe(403);

    const smuggled = await request(app).patch(`/api/v1/leads/${leadOfA}`).set(salesA.auth).send({ city: 'Tanta', assignedTo: salesB.id });
    expect(smuggled.status).toBe(200);
    expect(smuggled.body.data.assignedTo.id).toBe(salesA.id);
    expect((await Lead.findById(leadOfA).lean())!.assignedTo!.toString()).toBe(salesA.id);
  });

  it('learns that a duplicate exists but not which lead it is', async () => {
    const leadB = await Lead.findById(leadOfB).lean();
    const res = await request(app).post('/api/v1/leads').set(salesA.auth).send(leadBody({ email: leadB!.email }));
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).not.toContain(leadB!.reference);

    const override = await request(app)
      .post('/api/v1/leads')
      .set(salesA.auth)
      .send(leadBody({ email: leadB!.email, allowDuplicate: true }));
    expect(override.status).toBe(403);
  });

  it('loses access as soon as the lead is reassigned, and the new owner gains it', async () => {
    expect((await endpoints(salesA, leadOfA).get()).status).toBe(200);
    await request(app).patch(`/api/v1/leads/${leadOfA}/assign`).set(admin.auth).send({ assignedTo: salesB.id });

    expect((await endpoints(salesA, leadOfA).get()).status).toBe(404);
    expect((await endpoints(salesB, leadOfA).get()).status).toBe(200);
  });
});

describe('role changes apply immediately', () => {
  it('a Sales user moved to Viewer can read all leads but no longer edit', async () => {
    await request(app).patch(`/api/v1/users/${salesA.id}/role`).set(admin.auth).send({ role: 'VIEWER' });

    const list = await request(app).get('/api/v1/leads').set(salesA.auth);
    expect(list.body.meta.total).toBe(3);
    expect((await endpoints(salesA, leadOfA).update()).status).toBe(403);
  });

  it('a Marketing user creates unassigned leads and cannot assign them', async () => {
    const marketing = await signedInAs(app, 'MARKETING');
    const created = await request(app).post('/api/v1/leads').set(marketing.auth).send(leadBody());
    expect(created.body.data.assignedTo).toBeNull();

    const withAssignee = await request(app)
      .post('/api/v1/leads')
      .set(marketing.auth)
      .send(leadBody({ assignedTo: salesA.id }));
    expect(withAssignee.status).toBe(403);
  });
});
