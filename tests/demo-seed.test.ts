import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import {
  DEMO_AVATAR_BASE,
  DEMO_COURSE_PREFIX,
  DEMO_EMAIL_DOMAIN,
  DEMO_MODULES,
  DEMO_USERS,
  assertDedicatedDemoDatabase,
  seedDemoData,
  type DemoSeedReport,
} from '../src/database/demoSeed.js';
import { parseEnv } from '../src/config/envSchema.js';
import { assertLocalDemoConnection, demoSeedTargetProblems, type DemoSeedConfig } from '../src/database/demoSeedGuard.js';
import { TrainerAssignment } from '../src/modules/assignments/assignment.model.js';
import { Campaign } from '../src/modules/campaigns/campaign.model.js';
import { Course } from '../src/modules/courses/course.model.js';
import { Diploma } from '../src/modules/diplomas/diploma.model.js';
import { Enrollment } from '../src/modules/enrollments/enrollment.model.js';
import { Lead } from '../src/modules/leads/lead.model.js';
import { LeadNote } from '../src/modules/leads/leadNote.model.js';
import { Role } from '../src/modules/roles/role.model.js';
import { Student } from '../src/modules/students/student.model.js';
import { Trainer } from '../src/modules/trainers/trainer.model.js';
import { User } from '../src/modules/users/user.model.js';
import { useTestDatabase } from './helpers/db.js';
import { localTestUri } from './helpers/localDatabase.js';

/** Demo seed: 10 records per module, idempotent, valid references, images, and a local-only target. */
const SEED_TIMEOUT = 120_000;
const demoEmail = new RegExp(`@${DEMO_EMAIL_DOMAIN.replaceAll('.', '\\.')}$`);
const demoCourse = new RegExp(`^${DEMO_COURSE_PREFIX}`);

/** How many demo records each module has in the database right now. */
async function demoCounts(): Promise<Record<(typeof DEMO_MODULES)[number], number>> {
  const courses = await Course.find({ code: demoCourse }).select('_id').lean();
  const courseIds = courses.map((course) => course._id);
  const students = await Student.find({ email: demoEmail }).select('_id').lean();
  const leads = await Lead.find({ email: demoEmail }).select('_id').lean();
  return {
    users: await User.countDocuments({ email: demoEmail }),
    courses: courses.length,
    trainers: await Trainer.countDocuments({ email: demoEmail }),
    trainerAssignments: await TrainerAssignment.countDocuments({ course: { $in: courseIds } }),
    campaigns: await Campaign.countDocuments({ 'utm.campaign': /^hia-demo-/ }),
    diplomas: await Diploma.countDocuments({ courses: { $in: courseIds } }),
    students: students.length,
    enrollments: await Enrollment.countDocuments({ student: { $in: students.map((s) => s._id) } }),
    leads: leads.length,
    leadNotes: await LeadNote.countDocuments({ lead: { $in: leads.map((l) => l._id) } }),
  };
}

async function allCollectionCounts(): Promise<Record<string, number>> {
  const collections = await mongoose.connection.db!.collections();
  const entries = await Promise.all(collections.map(async (c) => [c.collectionName, await c.countDocuments()] as const));
  return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
}

const everyModule = (value: number) => Object.fromEntries(DEMO_MODULES.map((module) => [module, value]));

describe('demo seed', () => {
  useTestDatabase({ roles: true });

  it('creates 10 records per module on the first run', async () => {
    const report = await seedDemoData();
    expect(Object.fromEntries(DEMO_MODULES.map((m) => [m, report[m].created]))).toEqual(everyModule(10));
    expect(Object.fromEntries(DEMO_MODULES.map((m) => [m, report[m].skipped]))).toEqual(everyModule(0));
    expect(await demoCounts()).toEqual(everyModule(10));
  }, SEED_TIMEOUT);

  it('a second run creates nothing and changes nothing', async () => {
    await seedDemoData();
    const before = await allCollectionCounts();
    const snapshot = JSON.stringify(await Course.find().sort({ code: 1 }).lean());

    const second: DemoSeedReport = await seedDemoData();
    expect(Object.fromEntries(DEMO_MODULES.map((m) => [m, second[m].created]))).toEqual(everyModule(0));
    expect(Object.fromEntries(DEMO_MODULES.map((m) => [m, second[m].skipped]))).toEqual(everyModule(10));
    expect(await allCollectionCounts()).toEqual(before);
    expect(JSON.stringify(await Course.find().sort({ code: 1 }).lean())).toBe(snapshot);
    expect(await demoCounts()).toEqual(everyModule(10));
  }, SEED_TIMEOUT);

  it('every record passes schema validation and every reference resolves', async () => {
    await seedDemoData();
    for (const model of [User, Course, Trainer, TrainerAssignment, Campaign, Diploma, Student, Enrollment, Lead, LeadNote] as const) {
      const docs = await (model as unknown as mongoose.Model<unknown>).find();
      expect(docs.length, model.modelName).toBeGreaterThanOrEqual(10);
      for (const doc of docs) expect((doc as mongoose.Document).validateSync(), `${model.modelName} ${String((doc as mongoose.Document)._id)}`).toBeUndefined();
    }
    const exists = async (model: mongoose.Model<any>, ids: unknown[]) => (await model.countDocuments({ _id: { $in: ids } })) === new Set(ids.map(String)).size;

    const enrollments = await Enrollment.find().lean();
    expect(await exists(Student, enrollments.map((e) => e.student))).toBe(true);
    expect(await exists(Course, enrollments.map((e) => e.course))).toBe(true);
    const assignments = await TrainerAssignment.find().lean();
    expect(await exists(Trainer, assignments.map((a) => a.trainer))).toBe(true);
    expect(await exists(Course, assignments.map((a) => a.course))).toBe(true);
    const leads = await Lead.find().lean();
    expect(await exists(Campaign, leads.flatMap((l) => (l.campaign ? [l.campaign] : [])))).toBe(true);
    expect(await exists(User, leads.flatMap((l) => (l.assignedTo ? [l.assignedTo] : [])))).toBe(true);
    expect(await exists(User, (await Student.find().lean()).flatMap((s) => (s.advisor ? [s.advisor] : [])))).toBe(true);
    expect(await exists(Course, (await Diploma.find().lean()).flatMap((d) => d.courses))).toBe(true);
    expect(await exists(Course, (await Campaign.find().lean()).flatMap((c) => (c.course ? [c.course] : [])))).toBe(true);
    const linked = (await Trainer.find({ user: { $ne: null } }).lean()).map((t) => t.user);
    expect(linked).toHaveLength(2);
    expect(await User.countDocuments({ _id: { $in: linked }, role: (await Role.findOne({ key: 'TRAINER' }).lean())!._id })).toBe(2);
    expect(await exists(Lead, (await LeadNote.find().lean()).map((n) => n.lead))).toBe(true);

    // Counters the services maintain stay consistent with the records.
    for (const course of await Course.find({ code: demoCourse }).lean()) {
      expect(course.enrolledCount, course.code).toBe(await Enrollment.countDocuments({ course: course._id, status: { $ne: 'WITHDRAWN' } }));
      expect(course.openAssignments, course.code).toBe(await TrainerAssignment.countDocuments({ course: course._id, isOpen: true }));
    }
    for (const student of await Student.find().lean()) {
      expect(student.activeEnrollments).toBe(await Enrollment.countDocuments({ student: student._id, status: { $ne: 'WITHDRAWN' } }));
    }
    for (const lead of leads) expect(lead.notesCount).toBe(1);
    expect(new Set((await Enrollment.find().lean()).map((e) => e.status))).toEqual(new Set(['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'WITHDRAWN']));
    expect(new Set((await Campaign.find().lean()).map((c) => c.status))).toEqual(new Set(['DRAFT', 'SCHEDULED', 'RUNNING', 'PAUSED', 'COMPLETED']));
    expect(await Lead.countDocuments({ status: 'LOST', lostReason: { $type: 'string' } })).toBe(1);
  }, SEED_TIMEOUT);

  it('gives every user its own avatar, served by the frontend, and adds no image fields elsewhere', async () => {
    await seedDemoData();
    const users = await User.find({ email: demoEmail }).lean();
    const avatars = users.map((user) => user.avatarUrl);
    expect(avatars.every((url) => typeof url === 'string' && url.startsWith(`${DEMO_AVATAR_BASE}/`) && url.endsWith('.svg'))).toBe(true);
    expect(new Set(avatars).size).toBe(10);
    // The files exist in the frontend (when it is checked out next to the API) and are distinct SVGs.
    const publicDir = path.resolve(import.meta.dirname, '../../Higher-Innovation-Academy-CRM/public');
    if (existsSync(publicDir)) {
      const contents = avatars.map((url) => readFileSync(path.join(publicDir, url!), 'utf8'));
      expect(contents.every((svg) => svg.startsWith('<svg') && svg.length < 5_000)).toBe(true);
      expect(new Set(contents).size).toBe(10);
    }
    // Only User has an image field; the seed does not invent one for other models.
    for (const model of [Course, Trainer, Student, Lead, Campaign, Diploma, Enrollment, TrainerAssignment, LeadNote]) {
      expect(Object.keys(model.schema.paths).filter((p) => /avatar|image|photo|picture/i.test(p)), model.modelName).toEqual([]);
    }
    // No image data stored inline.
    expect(await User.countDocuments({ avatarUrl: /^data:/ })).toBe(0);
  }, SEED_TIMEOUT);

  it('demo staff accounts have no password and cannot be used to sign in', async () => {
    await seedDemoData();
    const users = await User.find({ email: demoEmail }).select('+passwordHash').lean();
    expect(users).toHaveLength(DEMO_USERS.length);
    expect(users.every((user) => user.passwordHash === null)).toBe(true);
    expect(users.some((user) => (user as { role: unknown }).role === null)).toBe(false);
    expect(await User.countDocuments({ email: demoEmail, role: (await Role.findOne({ key: 'OWNER' }).lean())!._id })).toBe(0);
  }, SEED_TIMEOUT);

  it('remote opt-in: accepts only a database holding this CRM\'s collections and demo records', async () => {
    const db = mongoose.connection.db!;
    const name = db.databaseName;
    await expect(assertDedicatedDemoDatabase(mongoose.connection, name)).resolves.toBeUndefined(); // roles only
    await seedDemoData();
    await expect(assertDedicatedDemoDatabase(mongoose.connection, name)).resolves.toBeUndefined(); // re-run allowed
    await expect(assertDedicatedDemoDatabase(mongoose.connection, 'another_database')).rejects.toThrow(/confirmed database/);

    // A real (non-demo) course: refused, nothing written.
    const admin = await User.findOne({ email: demoEmail }).lean();
    await Course.create({ code: 'DA-101', name: 'Real course', level: 'BEGINNER', price: 100, createdBy: admin!._id });
    await expect(assertDedicatedDemoDatabase(mongoose.connection, name)).rejects.toThrow(/courses that are not demo data/);
    await Course.deleteOne({ code: 'DA-101' });

    // A real lead without e-mail counts as real data too.
    await Lead.create({ reference: 'LD-REAL', fullName: 'Real Prospect', phone: '+20 100 000 0000', source: 'WEBSITE', createdBy: admin!._id });
    await expect(assertDedicatedDemoDatabase(mongoose.connection, name)).rejects.toThrow(/leads that are not demo data/);
    await Lead.deleteOne({ reference: 'LD-REAL' });

    // A collection from another project: refused.
    await db.createCollection('patients');
    try {
      await expect(assertDedicatedDemoDatabase(mongoose.connection, name)).rejects.toThrow(/do not belong to this CRM/);
    } finally {
      await db.dropCollection('patients');
    }
  }, SEED_TIMEOUT);

  it('never modifies records that already exist', async () => {
    const viewer = (await Role.findOne({ key: 'VIEWER' }).lean())!;
    const existingUser = await User.create({ firstName: 'Existing', lastName: 'Person', email: `omar.khaled@${DEMO_EMAIL_DOMAIN}`, role: viewer._id, status: 'SUSPENDED' });
    const unrelated = await User.create({ firstName: 'Real', lastName: 'Staff', email: 'real.staff@academy.example', role: viewer._id, status: 'ACTIVE' });
    const before = JSON.stringify(await User.find({ _id: { $in: [existingUser._id, unrelated._id] } }).sort({ email: 1 }).lean());

    const report = await seedDemoData();
    expect(report.users).toEqual({ created: 9, skipped: 1 });
    expect(JSON.stringify(await User.find({ _id: { $in: [existingUser._id, unrelated._id] } }).sort({ email: 1 }).lean())).toBe(before);
  }, SEED_TIMEOUT);
});

describe('demo seed without system roles', () => {
  useTestDatabase();

  it('refuses before writing anything', async () => {
    await expect(seedDemoData()).rejects.toThrow(/system roles are missing/);
    expect(await User.countDocuments()).toBe(0);
    expect(await Course.countDocuments()).toBe(0);
  });
});

describe('demo seed target guard', () => {
  const local: DemoSeedConfig = { NODE_ENV: 'development', DEPLOY_ENV: undefined, STAGING_CONNECTIVITY_APPROVED: false, PRODUCTION_DB_HOST_SHA256: undefined };

  it('accepts only a named local development or test database', () => {
    for (const uri of [
      'mongodb://127.0.0.1:27017/academy_crm_dev?replicaSet=rs0',
      'mongodb://localhost:27017/academy_crm_demo',
      'mongodb://[::1]:27017/academy_test',
      'mongodb://user:pw@127.0.0.1:27017/academy_local?authSource=admin',
    ]) {
      expect(demoSeedTargetProblems(local, uri), uri).toEqual([]);
    }
    expect(demoSeedTargetProblems({ ...local, NODE_ENV: 'test' }, 'mongodb://127.0.0.1/academy_crm_e2e')).toEqual([]);
  });

  it('refuses remote, hosted, unnamed or production-looking targets without echoing them', () => {
    const cases: Array<[string, RegExp]> = [
      ['mongodb+srv://u:secret-pw@cluster0.abcde.example.net/academy_crm_dev', /mongodb\+srv/],
      ['mongodb://u:secret-pw@db.example.net:27017/academy_crm_dev', /local hosts/],
      ['mongodb://127.0.0.1:27017,db.example.net:27017/academy_crm_dev', /local hosts/],
      ['mongodb://localhost:secret-pw@db.example.net/academy_crm_dev', /local hosts/],
      ['mongodb://127.0.0.1:27017/', /name the database/],
      ['mongodb://127.0.0.1:27017/?replicaSet=rs0', /name the database/],
      ['mongodb://127.0.0.1:27017/academy_crm', /"dev", "development"/],
      ['mongodb://127.0.0.1:27017/academy_prod_dev', /shared or production/],
      ['mongodb://127.0.0.1:27017/staging_test', /shared or production/],
      ['mongodb://u:p@/academy_crm_dev', /cannot be read/],
    ];
    for (const [uri, problem] of cases) {
      const problems = demoSeedTargetProblems(local, uri);
      expect(problems.join(' | '), uri).toMatch(problem);
      expect(problems.join(' | ')).not.toMatch(/secret-pw|example\.net/);
    }
  });

  it('remote opt-in: needs the exact database name as confirmation, development mode and a safe name', () => {
    const atlas = 'mongodb+srv://app:secret-pw@cluster0.abcde.example.net/higher-edu?retryWrites=true&w=majority';
    const remote = { ...local, DEMO_SEED_REMOTE_DATABASE: 'higher-edu' };
    expect(demoSeedTargetProblems(remote, atlas)).toEqual([]);
    // Without the opt-in the same target stays refused.
    expect(demoSeedTargetProblems(local, atlas).join(' | ')).toMatch(/mongodb\+srv/);
    const cases: Array<[DemoSeedConfig, string, RegExp]> = [
      [{ ...remote, DEMO_SEED_REMOTE_DATABASE: 'higher_edu' }, atlas, /must equal the database name/],
      [{ ...remote, DEMO_SEED_REMOTE_DATABASE: 'Higher-Edu' }, atlas, /must equal the database name/],
      [remote, atlas.replace('/higher-edu?', '/?'), /name the database/],
      [{ ...remote, DEMO_SEED_REMOTE_DATABASE: 'admin' }, atlas.replace('/higher-edu?', '/admin?'), /admin, local or config/],
      [{ ...remote, DEMO_SEED_REMOTE_DATABASE: 'higher-edu-prod' }, atlas.replace('/higher-edu?', '/higher-edu-prod?'), /shared or production/],
      [remote, `${atlas}&tlsAllowInvalidCertificates=true`, /TLS/],
      [{ ...remote, NODE_ENV: 'test' }, atlas, /NODE_ENV=development/],
      [{ ...remote, NODE_ENV: 'production' }, atlas, /NODE_ENV=development/],
      [{ ...remote, DEPLOY_ENV: 'staging' }, atlas, /DEPLOY_ENV/],
      [{ ...remote, PRODUCTION_DB_HOST_SHA256: ['a'.repeat(64)] }, atlas, /PRODUCTION_DB_HOST_SHA256/],
      [{ ...remote, STAGING_CONNECTIVITY_APPROVED: true }, atlas, /STAGING_CONNECTIVITY_APPROVED/],
    ];
    for (const [config, uri, problem] of cases) {
      const problems = demoSeedTargetProblems(config, uri).join(' | ');
      expect(problems, uri).toMatch(problem);
      expect(problems).not.toMatch(/secret-pw|example\.net/);
    }
    // The setting itself is refused by the configuration outside development.
    const base = { MONGODB_URI: 'mongodb://127.0.0.1:27017/academy_crm_dev', JWT_ACCESS_SECRET: 'x'.repeat(32), DEMO_SEED_REMOTE_DATABASE: 'higher-edu' };
    expect(() => parseEnv(base)).not.toThrow();
    expect(() => parseEnv({ ...base, NODE_ENV: 'test', MONGODB_URI: 'mongodb://127.0.0.1:27017/academy_test' })).toThrow(/DEMO_SEED_REMOTE_DATABASE: may only be set/);
  });

  it('refuses production, staging and approval settings', () => {
    const uri = 'mongodb://127.0.0.1:27017/academy_crm_dev';
    expect(demoSeedTargetProblems({ ...local, NODE_ENV: 'production' }, uri).join()).toMatch(/NODE_ENV/);
    expect(demoSeedTargetProblems({ ...local, DEPLOY_ENV: 'staging' }, uri).join()).toMatch(/DEPLOY_ENV/);
    expect(demoSeedTargetProblems({ ...local, DEPLOY_ENV: 'production' }, uri).join()).toMatch(/DEPLOY_ENV/);
    expect(demoSeedTargetProblems({ ...local, STAGING_CONNECTIVITY_APPROVED: true }, uri).join()).toMatch(/STAGING_CONNECTIVITY_APPROVED/);
    expect(demoSeedTargetProblems({ ...local, PRODUCTION_DB_HOST_SHA256: ['a'.repeat(64)] }, uri).join()).toMatch(/PRODUCTION_DB_HOST_SHA256/);
  });

  it('after connecting, refuses a server that reports non-local members or another database', async () => {
    const fake = (hello: Record<string, unknown>, database = 'academy_crm_dev') =>
      ({
        db: { databaseName: database, admin: () => ({ command: async () => hello }) },
        getClient: () => ({ topology: { description: { servers: new Map([['127.0.0.1:27017', {}]]) } } }),
      }) as unknown as mongoose.Connection;
    const uri = 'mongodb://127.0.0.1:27017/academy_crm_dev';
    await expect(assertLocalDemoConnection(fake({ me: 'shard-00-00.abcde.example.net:27017', hosts: ['shard-00-00.abcde.example.net:27017'] }), uri)).rejects.toThrow(/non-local members/);
    await expect(assertLocalDemoConnection(fake({ me: '127.0.0.1:27017' }, 'other_db'), uri)).rejects.toThrow(/checked database/);
    await expect(assertLocalDemoConnection(fake({ me: '127.0.0.1:27017', hosts: ['127.0.0.1:27017'] }), uri)).resolves.toBeUndefined();
  });

  it('accepts the real local in-memory server', async () => {
    const uri = localTestUri();
    const connection = await mongoose.createConnection(localTestUri()).asPromise();
    try {
      await expect(assertLocalDemoConnection(connection, uri)).resolves.toBeUndefined();
    } finally {
      await connection.close();
    }
  });

  it('the run command checks the target before connecting and the server before writing', () => {
    const script = readFileSync(path.resolve(import.meta.dirname, '../src/scripts/seed-demo-data.ts'), 'utf8');
    for (const check of ['await assertDedicatedDemoDatabase(', 'await assertLocalDemoConnection(']) {
      const order = ['demoSeedTargetProblems(env, env.MONGODB_URI)', 'process.exit(1)', 'await connectDatabase()', check, 'await seedDemoData()'].map((call) => script.indexOf(call));
      expect(order.every((index) => index > 0), JSON.stringify(order)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
    }
    expect(script).not.toMatch(/deleteMany|dropDatabase|drop\(/);
    // The connection string is never logged; only the database name derived from it.
    expect(script).not.toMatch(/(logger\.[a-z]+|console\.[a-z]+)\([^;]*env\.MONGODB_URI(?!\)\.database)/);
    const seed = readFileSync(path.resolve(import.meta.dirname, '../src/database/demoSeed.ts'), 'utf8');
    expect(seed).not.toMatch(/deleteMany|deleteOne|dropDatabase|\.drop\(|updateMany|replaceOne|findOneAndUpdate|updateOne/);
  });
});
