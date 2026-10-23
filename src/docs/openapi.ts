import { z } from 'zod';
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  resetPasswordSchema,
  updateOwnProfileSchema,
} from '../modules/auth/auth.schema.js';
import { REFRESH_COOKIE_NAME } from '../modules/auth/auth.cookies.js';
import { ASSIGNMENT_END_REASONS, ASSIGNMENT_ROLES, ASSIGNMENT_STATUSES } from '../modules/assignments/assignment.model.js';
import {
  createAssignmentSchema,
  endAssignmentSchema,
  listAssignmentsQuerySchema,
  updateAssignmentSchema,
} from '../modules/assignments/assignments.schema.js';
import { CURRENCY } from '../config/money.js';
import { MAX_RANGE_DAYS, REPORT_TIMEZONE } from '../config/reporting.js';
import {
  academyReportQuerySchema,
  campaignReportQuerySchema,
  dashboardQuerySchema,
  leadBreakdownQuerySchema,
  leadSummaryQuerySchema,
  leadTimeseriesQuerySchema,
} from '../modules/reports/reports.schema.js';
import { CAMPAIGN_PLATFORMS, CAMPAIGN_STATUSES, CAMPAIGN_TRANSITIONS } from '../modules/campaigns/campaign.model.js';
import {
  createCampaignSchema,
  listCampaignsQuerySchema,
  updateCampaignSchema,
  updateCampaignStatusSchema,
} from '../modules/campaigns/campaigns.schema.js';
import { COURSE_LEVELS, COURSE_STATUSES } from '../modules/courses/course.model.js';
import { DIPLOMA_STATUSES } from '../modules/diplomas/diploma.model.js';
import { createDiplomaSchema, listDiplomasQuerySchema, updateDiplomaSchema } from '../modules/diplomas/diplomas.schema.js';
import { TRAINER_STATUSES } from '../modules/trainers/trainer.model.js';
import { createTrainerSchema, listTrainersQuerySchema, updateTrainerSchema } from '../modules/trainers/trainers.schema.js';
import { createCourseSchema, listCoursesQuerySchema, updateCourseSchema } from '../modules/courses/courses.schema.js';
import { ENROLLMENT_STATUSES } from '../modules/enrollments/enrollment.model.js';
import {
  createEnrollmentSchema,
  listEnrollmentsQuerySchema,
  updateEnrollmentStatusSchema,
} from '../modules/enrollments/enrollments.schema.js';
import { LEAD_PRIORITIES, LEAD_SOURCES, LEAD_STATUSES, LEAD_TAGS } from '../modules/leads/lead.model.js';
import { STUDENT_STATUSES } from '../modules/students/student.model.js';
import {
  assignAdvisorSchema,
  createStudentSchema,
  listStudentsQuerySchema,
  updateStudentSchema,
} from '../modules/students/students.schema.js';
import {
  assignLeadSchema,
  convertLeadSchema,
  createLeadNoteSchema,
  createLeadSchema,
  listLeadNotesQuerySchema,
  listLeadsQuerySchema,
  setLeadCampaignSchema,
  updateLeadSchema,
  updateLeadStatusSchema,
} from '../modules/leads/leads.schema.js';
import { PERMISSIONS, ROLE_KEYS } from '../modules/roles/permissions.js';
import { USER_STATUSES } from '../modules/users/user.model.js';
import { assignRoleSchema, createUserSchema, listUsersQuerySchema, updateUserSchema } from '../modules/users/users.schema.js';

/**
 * OpenAPI 3.1 description of the API, served by Swagger UI at /api/docs.
 *
 * Request schemas are generated from the same Zod schemas the routes validate with,
 * so the documentation cannot drift from the real validation rules.
 */

type JsonSchema = Record<string, unknown>;

function fromZod(schema: z.ZodType): JsonSchema {
  const { $schema: _ignored, ...json } = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as JsonSchema;
  return json;
}

/** Turns an object schema's properties into query parameters. */
function queryParameters(schema: z.ZodType) {
  const json = fromZod(schema) as { properties: Record<string, JsonSchema> };
  return Object.entries(json.properties).map(([name, property]) => ({ name, in: 'query', required: false, schema: property }));
}

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const jsonBody = (schema: JsonSchema) => ({ required: true, content: { 'application/json': { schema } } });

/** `{ success: true, message, data, meta? }` wrapping the given data schema. */
function ok(description: string, data: JsonSchema = { type: 'null' }, withMeta = false) {
  return {
    description,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          required: ['success', 'message', 'data'],
          properties: {
            success: { type: 'boolean', const: true },
            message: { type: 'string' },
            data,
            ...(withMeta ? { meta: ref('PaginationMeta') } : {}),
          },
        },
      },
    },
  };
}

const error = (description: string) => ({ description, content: { 'application/json': { schema: ref('Error') } } });

const commonErrors = {
  '400': error('Validation failed (`VALIDATION_ERROR`) or invalid id (`INVALID_ID`)'),
  '401': error('Missing, invalid, expired or revoked access token; or the account is not active'),
  '403': error('Authenticated, but not permitted (`FORBIDDEN`, `INSUFFICIENT_ROLE`, `ROLE_NOT_ASSIGNABLE`, `CANNOT_MODIFY_SELF`)'),
};

const secured = [{ bearerAuth: [] }];
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string', pattern: '^[0-9a-fA-F]{24}$' } };
const setsRefreshCookie = {
  'Set-Cookie': {
    description: `\`${REFRESH_COOKIE_NAME}\` refresh token: HttpOnly, Secure (production), SameSite, Path=/api/v1/auth`,
    schema: { type: 'string' },
  },
};

const sessionResponse = (description: string) => ({ ...ok(description, ref('Session')), headers: setsRefreshCookie });

export const openApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'Academy CRM API',
    version: '1.0.0',
    description: [
      'REST API for the Higher Innovation Academy CRM.',
      '',
      'Successful responses use `{ success: true, message, data, meta? }`; errors use `{ success: false, message, code, errors?, requestId? }`.',
      '',
      '**Authentication:** `POST /auth/login` returns a short-lived access token in the body and sets an httpOnly refresh-token cookie.',
      'Send the access token as `Authorization: Bearer <token>`. When it expires, call `POST /auth/refresh` (the browser sends the cookie automatically; use `credentials: "include"`).',
      'There is no public registration: Owner/Admin create staff accounts with `POST /users`, and the first Owner is created by the seed command.',
    ].join('\n'),
  },
  servers: [{ url: '/api/v1' }],
  tags: [
    { name: 'Health', description: 'Liveness and readiness probes' },
    { name: 'Auth', description: 'Sign-in, sessions and passwords' },
    { name: 'Users', description: 'Staff accounts (permission-protected)' },
    { name: 'Roles', description: 'System roles and their permissions' },
    {
      name: 'Leads',
      description: [
        'Prospects in the sales pipeline. Visibility is enforced on every request:',
        '`leads:read_all` (Owner, Admin, Marketing, Viewer) sees every lead; `leads:read_assigned` (Sales) sees only leads assigned to them.',
        'A lead outside the caller\'s scope answers **404**, exactly like a nonexistent one.',
        'Leads are archived, never deleted. Archived leads are read-only until restored.',
      ].join(' '),
    },
    {
      name: 'Courses',
      description:
        'The course catalog. Readable by every role with `courses:read` (Owner, Admin, Marketing, Sales, Trainer, Viewer); changed only with `courses:write` (Owner, Admin). Archived, never deleted.',
    },
    {
      name: 'Students',
      description: [
        '`students:read_all` (Owner, Admin, Viewer) sees every student; `students:read_assigned` (Sales) only students whose advisor is the caller; `students:read_teaching` (Trainer) only students enrolled in courses they teach, with reduced fields (`StudentTeaching`).',
        'Out-of-scope students answer **404**. Archived, never deleted; a student with active enrollments must be withdrawn before archiving.',
      ].join(' '),
    },
    {
      name: 'Dashboard',
      description:
        'Home-screen summary for every signed-in user. Sections appear only for the permissions that grant that data elsewhere, and are computed inside the caller\'s scope (Sales: own leads and advised students; Trainer: taught courses).',
    },
    {
      name: 'Reports',
      description: [
        `Academy-wide reports. Dates: \`from\`/\`to\` are inclusive calendar days in ${REPORT_TIMEZONE} (UTC+4, no DST); default the last 30 days including today.`,
        `Max range: daily series ${MAX_RANGE_DAYS.day} days, weekly ${MAX_RANGE_DAYS.week}, monthly and summaries ${MAX_RANGE_DAYS.summary}.`,
        'Archived leads, students, courses and campaigns are excluded. Metrics use current lead status (no status history).',
        'Cohort metrics: leads created in the range, by current status. Activity metrics: conversions (convertedAt) / enrollments (enrolledAt, completedAt, withdrawnAt) in the range.',
        'Each response is built from several queries and is not a point-in-time snapshot.',
        'Not available: revenue, payments, impressions, clicks, ROAS, call/activity metrics.',
      ].join(' '),
    },
    {
      name: 'Campaigns',
      description: [
        'Marketing campaigns. Read: `campaigns:read` (Owner, Admin, Marketing, Viewer). Write (create, edit, status, archive, restore): `campaigns:write` (Owner, Admin, Marketing).',
        'Other roles get 403 for every campaign id, existing or not.',
        '`metrics` are derived from attributed, non-archived leads at request time (nothing is stored).',
        'Amounts are whole AED. Archived, never deleted.',
      ].join(' '),
    },
    {
      name: 'Trainers',
      description:
        'Trainer profiles (separate from user accounts; optionally linked to one TRAINER-role user). Read: `trainers:read` (Owner, Admin, HR, Viewer). Write: `trainers:write` (Owner, Admin). Archived, never deleted; archiving ends open assignments.',
    },
    {
      name: 'Trainer assignments',
      description:
        'Trainer ↔ Course, many-to-many. SCHEDULED/ACTIVE are open; COMPLETED/CANCELLED are final history. At most one open assignment per trainer and course, and one open PRIMARY per course (database-enforced). Trainers see their own assignments (`trainers:read_own`).',
    },
    {
      name: 'Diplomas',
      description:
        'Programs made of several courses (a course can be in several diplomas). Catalog data: `courses:read` to read, `courses:write` (Owner, Admin) to change. Never enrolls or charges anyone.',
    },
    {
      name: 'Enrollments',
      description: [
        'Student ↔ Course, at most one enrollment per pair. Created with `POST /students/{id}/enrollments`.',
        'Visibility follows the student (Sales) or the course (Trainer: enrollments in courses they teach, without price or enrolledBy). Seats are enforced atomically; WITHDRAWN releases the seat.',
      ].join(' '),
    },
  ],
  paths: {
    '/health': {
      get: {
        tags: ['Health'],
        summary: 'Liveness: the process is up',
        responses: {
          '200': ok('The API process is running', {
            type: 'object',
            properties: {
              status: { type: 'string', const: 'ok' },
              uptimeSeconds: { type: 'integer' },
              timestamp: { type: 'string', format: 'date-time' },
            },
          }),
        },
      },
    },
    '/health/ready': {
      get: {
        tags: ['Health'],
        summary: 'Readiness: dependencies (MongoDB) are reachable',
        responses: {
          '200': { description: 'Ready to serve traffic' },
          '503': { description: 'A dependency is down; see data.checks' },
        },
      },
    },

    '/auth/login': {
      post: {
        tags: ['Auth'],
        summary: 'Sign in with email and password',
        description: 'Rate limited per IP + email (failed attempts only).',
        requestBody: jsonBody(fromZod(loginSchema)),
        responses: {
          '200': sessionResponse('Signed in'),
          '400': commonErrors['400'],
          '401': error('`INVALID_CREDENTIALS`: unknown email or wrong password (same response for both)'),
          '403': error('`ACCOUNT_DISABLED`: correct password, but the account is not active'),
          '429': error('Too many failed attempts'),
        },
      },
    },
    '/auth/refresh': {
      post: {
        tags: ['Auth'],
        summary: 'Rotate the refresh token and get a new access token',
        description:
          'Reads the refresh token from the cookie. Each refresh token works once; presenting a used one revokes the whole session (theft detection).',
        parameters: [{ name: REFRESH_COOKIE_NAME, in: 'cookie', required: true, schema: { type: 'string' } }],
        responses: {
          '200': sessionResponse('New token pair issued'),
          '401': error('`REFRESH_TOKEN_MISSING`, `INVALID_REFRESH_TOKEN` or `ACCOUNT_DISABLED`; the cookie is cleared'),
        },
      },
    },
    '/auth/logout': {
      post: {
        tags: ['Auth'],
        summary: 'Sign out this device',
        description: 'Revokes the refresh token in the cookie and clears it. Always succeeds.',
        responses: { '200': ok('Signed out') },
      },
    },
    '/auth/logout-all': {
      post: {
        tags: ['Auth'],
        summary: 'Sign out every device',
        description: 'Revokes all refresh tokens and invalidates all access tokens already issued.',
        security: secured,
        responses: { '200': ok('Signed out from all devices'), '401': commonErrors['401'] },
      },
    },
    '/auth/me': {
      get: {
        tags: ['Auth'],
        summary: 'The signed-in user, with permissions',
        security: secured,
        responses: { '200': ok('Current user', ref('CurrentUser')), '401': commonErrors['401'] },
      },
      patch: {
        tags: ['Auth'],
        summary: 'Edit your own profile',
        description:
          'Any signed-in user may change their own name, phone and location. Email, role, status and department are managed by administrators and are ignored here.',
        security: secured,
        requestBody: jsonBody(fromZod(updateOwnProfileSchema)),
        responses: { '200': ok('Current user', ref('CurrentUser')), '400': commonErrors['400'], '401': commonErrors['401'] },
      },
    },
    '/auth/change-password': {
      post: {
        tags: ['Auth'],
        summary: 'Change your password',
        description: 'Signs out every other session and returns a fresh session for this device.',
        security: secured,
        requestBody: jsonBody(fromZod(changePasswordSchema)),
        responses: {
          '200': sessionResponse('Password changed'),
          '400': error('`VALIDATION_ERROR` (password policy) or `INVALID_CURRENT_PASSWORD`'),
          '401': commonErrors['401'],
          '429': error('Too many failed attempts'),
        },
      },
    },
    '/auth/forgot-password': {
      post: {
        tags: ['Auth'],
        summary: 'Email a password reset link',
        description:
          'Always returns 202 with the same message, whether or not the email has an account. The link expires after PASSWORD_RESET_TTL_MINUTES and works once.',
        requestBody: jsonBody(fromZod(forgotPasswordSchema)),
        responses: { '202': ok('Accepted'), '400': commonErrors['400'], '429': error('Too many requests') },
      },
    },
    '/auth/reset-password': {
      post: {
        tags: ['Auth'],
        summary: 'Set a new password with a reset or invitation token',
        description:
          'Accepts the token from a password-reset email or an invitation email. Invitation tokens also activate the account. All existing sessions are revoked.',
        requestBody: jsonBody(fromZod(resetPasswordSchema)),
        responses: {
          '200': ok('Password set; sign in with it'),
          '400': error('`VALIDATION_ERROR` or `INVALID_RESET_TOKEN` (unknown, used or expired)'),
          '429': error('Too many failed attempts'),
        },
      },
    },

    '/users': {
      get: {
        tags: ['Users'],
        summary: 'List staff accounts',
        description: `Requires \`${PERMISSIONS.USERS_READ}\` (Owner, Admin, HR). \`role\` and \`status\` accept several values (\`?role=SALES,ADMIN\` or repeated keys).`,
        security: secured,
        parameters: queryParameters(listUsersQuerySchema),
        responses: { '200': ok('A page of users', { type: 'array', items: ref('User') }, true), ...commonErrors },
      },
      post: {
        tags: ['Users'],
        summary: 'Create a staff account and email an invitation',
        description: [
          `Requires \`${PERMISSIONS.USERS_CREATE}\`. The account starts as INVITED with no password; the user sets one via the emailed link.`,
          'Owner may create Admin and below; Admin may create roles below Admin. Nobody can create an Owner.',
        ].join(' '),
        security: secured,
        requestBody: jsonBody(fromZod(createUserSchema)),
        responses: {
          '201': ok('Created', { allOf: [ref('User'), { type: 'object', properties: { inviteSent: { type: 'boolean' } } }] }),
          ...commonErrors,
          '409': error('`EMAIL_TAKEN`'),
        },
      },
    },
    '/users/{id}': {
      get: {
        tags: ['Users'],
        summary: 'Get one staff account',
        security: secured,
        parameters: [idParam],
        responses: { '200': ok('User', ref('User')), ...commonErrors, '404': error('`USER_NOT_FOUND`') },
      },
      patch: {
        tags: ['Users'],
        summary: 'Update profile fields or status',
        description: `Requires \`${PERMISSIONS.USERS_UPDATE}\`. Suspending or deactivating a user ends their sessions immediately. You cannot change your own status.`,
        security: secured,
        parameters: [idParam],
        requestBody: jsonBody(fromZod(updateUserSchema)),
        responses: { '200': ok('Updated', ref('User')), ...commonErrors, '404': error('`USER_NOT_FOUND`') },
      },
    },
    '/users/{id}/role': {
      patch: {
        tags: ['Users'],
        summary: 'Assign a role',
        description: `Requires \`${PERMISSIONS.USERS_ASSIGN_ROLE}\`. The actor must outrank both the user's current role and the new role. You cannot change your own role.`,
        security: secured,
        parameters: [idParam],
        requestBody: jsonBody(fromZod(assignRoleSchema)),
        responses: { '200': ok('Role updated', ref('User')), ...commonErrors, '404': error('`USER_NOT_FOUND`') },
      },
    },
    '/users/{id}/resend-invite': {
      post: {
        tags: ['Users'],
        summary: 'Send a new invitation link (older links stop working)',
        security: secured,
        parameters: [idParam],
        responses: {
          '200': ok('Invitation sent'),
          ...commonErrors,
          '409': error('`USER_NOT_INVITED`: the account is already active'),
          '502': error('`EMAIL_DELIVERY_FAILED`'),
        },
      },
    },

    '/leads': {
      get: {
        tags: ['Leads'],
        summary: 'List leads',
        description:
          'Multi-value filters accept repeated keys (`?status=NEW&status=LOST`) or commas (`?status=NEW,LOST`). `assignedTo` accepts user ids and `unassigned`. Filters can only narrow the caller\'s scope, never widen it.',
        security: secured,
        parameters: queryParameters(listLeadsQuerySchema),
        responses: { '200': ok('A page of leads', { type: 'array', items: ref('Lead') }, true), ...commonErrors },
      },
      post: {
        tags: ['Leads'],
        summary: 'Create a lead',
        description: [
          `Requires \`${PERMISSIONS.LEADS_CREATE}\` (Owner, Admin, Marketing, Sales). A phone or an email is required.`,
          'Sales users\' leads are assigned to themselves; `assignedTo` may only be sent by callers with `leads:assign`.',
          'An active lead with the same email or (normalised) phone causes 409 `DUPLICATE_LEAD`; `allowDuplicate: true` overrides it for `leads:update_all` holders only.',
          '`campaignId` attributes the lead to a campaign (callers with `campaigns:read` only; others get 403 `FORBIDDEN_FIELD`). The campaign must exist, not be archived, and be RUNNING, PAUSED or COMPLETED.',
          'Server-controlled fields (reference, notesCount, archive fields, createdBy) are ignored if sent.',
        ].join(' '),
        security: secured,
        requestBody: jsonBody(fromZod(createLeadSchema)),
        responses: {
          '201': ok('Created', ref('Lead')),
          '400': error('`VALIDATION_ERROR`, or an invalid assignee (`ASSIGNEE_NOT_FOUND`, `ASSIGNEE_INACTIVE`, `ASSIGNEE_ROLE_NOT_ALLOWED`)'),
          '401': commonErrors['401'],
          '403': error('`FORBIDDEN`, or `FORBIDDEN_FIELD` (assignedTo / allowDuplicate without permission)'),
          '409': error('`DUPLICATE_LEAD`, `CAMPAIGN_ARCHIVED`, `CAMPAIGN_NOT_STARTED`'),
        },
      },
    },
    '/leads/{id}': {
      get: {
        tags: ['Leads'],
        summary: 'Get one lead',
        security: secured,
        parameters: [idParam],
        responses: { '200': ok('Lead', ref('Lead')), ...commonErrors, '404': error('`LEAD_NOT_FOUND` (or outside your scope)') },
      },
      patch: {
        tags: ['Leads'],
        summary: 'Update lead details',
        description:
          'Requires `leads:update_all`, or `leads:update_assigned` for your own leads. Status, assignment and archiving use their own endpoints; those fields are ignored here. Send `null` or `""` to clear an optional field.',
        security: secured,
        parameters: [idParam],
        requestBody: jsonBody(fromZod(updateLeadSchema)),
        responses: {
          '200': ok('Updated', ref('Lead')),
          ...commonErrors,
          '404': error('`LEAD_NOT_FOUND`'),
          '409': error('`LEAD_ARCHIVED` or `DUPLICATE_LEAD`'),
        },
      },
    },
    '/leads/{id}/status': {
      patch: {
        tags: ['Leads'],
        summary: 'Move the lead to another pipeline status',
        description:
          'Any status except `REGISTERED`, which is set by converting the lead to a student. `lostReason` is accepted only with `LOST`. A REGISTERED lead cannot change status.',
        security: secured,
        parameters: [idParam],
        requestBody: jsonBody(fromZod(updateLeadStatusSchema)),
        responses: {
          '200': ok('Status updated', ref('Lead')),
          ...commonErrors,
          '404': error('`LEAD_NOT_FOUND`'),
          '409': error('`LEAD_ARCHIVED` or `LEAD_CONVERTED`'),
        },
      },
    },
    '/leads/{id}/assign': {
      patch: {
        tags: ['Leads'],
        summary: 'Assign, reassign or unassign a lead',
        description: `Requires \`${PERMISSIONS.LEADS_ASSIGN}\` (Owner, Admin). The assignee must exist, be ACTIVE, and have a role that works leads (Sales, Admin, Owner). \`null\` unassigns.`,
        security: secured,
        parameters: [idParam],
        requestBody: jsonBody(fromZod(assignLeadSchema)),
        responses: {
          '200': ok('Assignment updated', ref('Lead')),
          '400': error('`VALIDATION_ERROR`, `ASSIGNEE_NOT_FOUND`, `ASSIGNEE_INACTIVE`, `ASSIGNEE_ROLE_NOT_ALLOWED`'),
          '401': commonErrors['401'],
          '403': commonErrors['403'],
          '404': error('`LEAD_NOT_FOUND`'),
          '409': error('`LEAD_ARCHIVED`'),
        },
      },
    },
    '/leads/{id}/archive': {
      post: {
        tags: ['Leads'],
        summary: 'Archive a lead (soft delete)',
        description: `Requires \`${PERMISSIONS.LEADS_ARCHIVE}\` (Owner, Admin). The lead stays in the database, disappears from default lists, and becomes read-only.`,
        security: secured,
        parameters: [idParam],
        responses: {
          '200': ok('Archived', ref('Lead')),
          ...commonErrors,
          '404': error('`LEAD_NOT_FOUND`'),
          '409': error('`LEAD_ALREADY_ARCHIVED`'),
        },
      },
    },
    '/leads/{id}/restore': {
      post: {
        tags: ['Leads'],
        summary: 'Restore an archived lead',
        description: `Requires \`${PERMISSIONS.LEADS_ARCHIVE}\`.`,
        security: secured,
        parameters: [idParam],
        responses: {
          '200': ok('Restored', ref('Lead')),
          ...commonErrors,
          '404': error('`LEAD_NOT_FOUND`'),
          '409': error('`LEAD_NOT_ARCHIVED`'),
        },
      },
    },
    '/leads/{id}/convert': {
      post: {
        tags: ['Leads'],
        summary: 'Convert the lead into a student',
        description: [
          'Requires lead edit access (`leads:update_all`, or `leads:update_assigned` for your own leads) and `students:create`: Owner, Admin, and Sales for leads assigned to them.',
          "Creates a student from the lead's details (the body may correct them, for the student only), sets the lead to REGISTERED and links the two, all in one transaction.",
          "The student's advisor is the lead's assignee when that user is active and works with students; it cannot be chosen by the client. The lead's source and UTM values are copied to `student.conversion`.",
          'Does not enroll the student in a course: use `POST /students/{id}/enrollments` afterwards.',
          'A lead converts at most once (database-enforced). Duplicate students (same email or normalised phone) are refused unless a `students:update_all` holder sends `allowDuplicate: true`.',
        ].join(' '),
        security: secured,
        parameters: [idParam],
        requestBody: { required: false, content: { 'application/json': { schema: fromZod(convertLeadSchema) } } },
        responses: {
          '201': ok('Converted', {
            type: 'object',
            properties: { student: ref('Student'), lead: ref('Lead') },
          }),
          '400': error('`VALIDATION_ERROR`'),
          '401': commonErrors['401'],
          '403': error('`FORBIDDEN`, or `FORBIDDEN_FIELD` (allowDuplicate without permission)'),
          '404': error('`LEAD_NOT_FOUND` (or outside your scope)'),
          '409': error('`LEAD_ARCHIVED`, `LEAD_ALREADY_CONVERTED` or `DUPLICATE_STUDENT`'),
        },
      },
    },
    '/leads/{id}/notes': {
      get: {
        tags: ['Leads'],
        summary: 'List notes on a lead (pinned first, then newest)',
        security: secured,
        parameters: [idParam, ...queryParameters(listLeadNotesQuerySchema)],
        responses: {
          '200': ok('A page of notes', { type: 'array', items: ref('LeadNote') }, true),
          ...commonErrors,
          '404': error('`LEAD_NOT_FOUND`'),
        },
      },
      post: {
        tags: ['Leads'],
        summary: 'Add a note',
        description: 'Same permission as editing the lead. The author is always the signed-in user.',
        security: secured,
        parameters: [idParam],
        requestBody: jsonBody(fromZod(createLeadNoteSchema)),
        responses: {
          '201': ok('Note added', ref('LeadNote')),
          ...commonErrors,
          '404': error('`LEAD_NOT_FOUND`'),
          '409': error('`LEAD_ARCHIVED`'),
        },
      },
    },

    '/courses': {
      get: {
        tags: ['Courses'],
        summary: 'List courses',
        description: '`enrollable=true` returns only courses accepting enrollments now (UPCOMING/ACTIVE, not archived, a seat free).',
        security: secured,
        parameters: queryParameters(listCoursesQuerySchema),
        responses: { '200': ok('A page of courses', { type: 'array', items: ref('Course') }, true), ...commonErrors },
      },
      post: {
        tags: ['Courses'],
        summary: 'Create a course',
        description: `Requires \`${PERMISSIONS.COURSES_WRITE}\`. Codes are stored upper-case and unique forever (archived courses keep theirs). New courses default to DRAFT. \`price\` is a whole amount.`,
        security: secured,
        requestBody: jsonBody(fromZod(createCourseSchema)),
        responses: { '201': ok('Created', ref('Course')), ...commonErrors, '409': error('`COURSE_CODE_TAKEN`') },
      },
    },
    '/courses/{id}': {
      get: {
        tags: ['Courses'],
        summary: 'Get one course',
        security: secured,
        parameters: [idParam],
        responses: { '200': ok('Course', ref('Course')), ...commonErrors, '404': error('`COURSE_NOT_FOUND`') },
      },
      patch: {
        tags: ['Courses'],
        summary: 'Update a course',
        description:
          'Price changes do not affect existing enrollments (they keep the price they enrolled at). `seats` cannot go below the enrolled count, and a course with enrolled students cannot return to DRAFT.',
        security: secured,
        parameters: [idParam],
        requestBody: jsonBody(fromZod(updateCourseSchema)),
        responses: {
          '200': ok('Updated', ref('Course')),
          ...commonErrors,
          '404': error('`COURSE_NOT_FOUND`'),
          '409': error('`COURSE_ARCHIVED`, `COURSE_CODE_TAKEN`, `SEATS_BELOW_ENROLLED`, `COURSE_HAS_ENROLLMENTS`'),
        },
      },
    },
    '/courses/{id}/archive': {
      post: {
        tags: ['Courses'],
        summary: 'Archive a course',
        description: 'Leaves the catalog and accepts no new enrollments; existing enrollments are kept.',
        security: secured,
        parameters: [idParam],
        responses: { '200': ok('Archived', ref('Course')), ...commonErrors, '404': error('`COURSE_NOT_FOUND`'), '409': error('`COURSE_ALREADY_ARCHIVED`') },
      },
    },
    '/courses/{id}/restore': {
      post: {
        tags: ['Courses'],
        summary: 'Restore an archived course',
        security: secured,
        parameters: [idParam],
        responses: { '200': ok('Restored', ref('Course')), ...commonErrors, '404': error('`COURSE_NOT_FOUND`'), '409': error('`COURSE_NOT_ARCHIVED`') },
      },
    },

    '/students': {
      get: {
        tags: ['Students'],
        summary: 'List students',
        description: '`course` lists students with a non-withdrawn enrollment in those courses. Filters only narrow the caller\'s scope.',
        security: secured,
        parameters: queryParameters(listStudentsQuerySchema),
        responses: { '200': ok('A page of students', { type: 'array', items: ref('Student') }, true), ...commonErrors },
      },
      post: {
        tags: ['Students'],
        summary: 'Create a student',
        description: [
          `Requires \`${PERMISSIONS.STUDENTS_CREATE}\` (Owner, Admin, Sales). A phone or an email is required.`,
          'Sales users become the advisor of students they create; `advisor` may only be sent with `students:assign`.',
          'An active student with the same email or (normalised) phone causes 409 `DUPLICATE_STUDENT`; `allowDuplicate` overrides it for `students:update_all` holders only.',
        ].join(' '),
        security: secured,
        requestBody: jsonBody(fromZod(createStudentSchema)),
        responses: {
          '201': ok('Created', ref('Student')),
          '400': error('`VALIDATION_ERROR`, `ADVISOR_NOT_FOUND`, `ADVISOR_INACTIVE`, `ADVISOR_ROLE_NOT_ALLOWED`'),
          '401': commonErrors['401'],
          '403': error('`FORBIDDEN` or `FORBIDDEN_FIELD`'),
          '409': error('`DUPLICATE_STUDENT`'),
        },
      },
    },
    '/students/{id}': {
      get: {
        tags: ['Students'],
        summary: 'Get one student',
        security: secured,
        parameters: [idParam],
        responses: { '200': ok('Student', ref('Student')), ...commonErrors, '404': error('`STUDENT_NOT_FOUND` (or outside your scope)') },
      },
      patch: {
        tags: ['Students'],
        summary: 'Update student details and status',
        description: 'Requires `students:update_all`, or `students:update_assigned` for students you advise. Advisor and archive state have their own endpoints.',
        security: secured,
        parameters: [idParam],
        requestBody: jsonBody(fromZod(updateStudentSchema)),
        responses: {
          '200': ok('Updated', ref('Student')),
          ...commonErrors,
          '404': error('`STUDENT_NOT_FOUND`'),
          '409': error('`STUDENT_ARCHIVED` or `DUPLICATE_STUDENT`'),
        },
      },
    },
    '/students/{id}/advisor': {
      patch: {
        tags: ['Students'],
        summary: 'Set, change or remove the advisor',
        description: `Requires \`${PERMISSIONS.STUDENTS_ASSIGN}\` (Owner, Admin). The advisor must exist, be ACTIVE, and be a Sales, Admin or Owner user. \`null\` removes it.`,
        security: secured,
        parameters: [idParam],
        requestBody: jsonBody(fromZod(assignAdvisorSchema)),
        responses: {
          '200': ok('Advisor updated', ref('Student')),
          '400': error('`VALIDATION_ERROR`, `ADVISOR_NOT_FOUND`, `ADVISOR_INACTIVE`, `ADVISOR_ROLE_NOT_ALLOWED`'),
          '401': commonErrors['401'],
          '403': commonErrors['403'],
          '404': error('`STUDENT_NOT_FOUND`'),
          '409': error('`STUDENT_ARCHIVED`'),
        },
      },
    },
    '/students/{id}/archive': {
      post: {
        tags: ['Students'],
        summary: 'Archive a student',
        description: `Requires \`${PERMISSIONS.STUDENTS_ARCHIVE}\`. Only possible when the student has no active (non-withdrawn) enrollments.`,
        security: secured,
        parameters: [idParam],
        responses: {
          '200': ok('Archived', ref('Student')),
          ...commonErrors,
          '404': error('`STUDENT_NOT_FOUND`'),
          '409': error('`STUDENT_ALREADY_ARCHIVED` or `STUDENT_HAS_ACTIVE_ENROLLMENTS`'),
        },
      },
    },
    '/students/{id}/restore': {
      post: {
        tags: ['Students'],
        summary: 'Restore an archived student',
        security: secured,
        parameters: [idParam],
        responses: { '200': ok('Restored', ref('Student')), ...commonErrors, '404': error('`STUDENT_NOT_FOUND`'), '409': error('`STUDENT_NOT_ARCHIVED`') },
      },
    },
    '/students/{id}/enrollments': {
      post: {
        tags: ['Enrollments'],
        summary: 'Enroll the student in a course',
        description: [
          'Requires `enrollments:write` and write access to the student. The course must exist, not be archived, be UPCOMING or ACTIVE, and have a free seat.',
          'The course price is copied onto the enrollment. New enrollments start as NOT_STARTED.',
          'A student can be enrolled in a course only once; after withdrawing, change that enrollment\'s status instead.',
        ].join(' '),
        security: secured,
        parameters: [idParam],
        requestBody: jsonBody(fromZod(createEnrollmentSchema)),
        responses: {
          '201': ok('Enrolled', ref('Enrollment')),
          '400': error('`VALIDATION_ERROR` or `COURSE_NOT_FOUND`'),
          '401': commonErrors['401'],
          '403': commonErrors['403'],
          '404': error('`STUDENT_NOT_FOUND` (or outside your scope)'),
          '409': error('`ENROLLMENT_EXISTS`, `STUDENT_ARCHIVED`, `COURSE_ARCHIVED`, `COURSE_NOT_OPEN`, `COURSE_FULL`'),
        },
      },
    },
    '/enrollments': {
      get: {
        tags: ['Enrollments'],
        summary: 'List enrollments',
        description: 'Filter by `student`, `course` (rosters), `status`, enrollment date. Limited to students the caller can see.',
        security: secured,
        parameters: queryParameters(listEnrollmentsQuerySchema),
        responses: { '200': ok('A page of enrollments', { type: 'array', items: ref('Enrollment') }, true), ...commonErrors },
      },
    },
    '/enrollments/{id}': {
      get: {
        tags: ['Enrollments'],
        summary: 'Get one enrollment',
        security: secured,
        parameters: [idParam],
        responses: { '200': ok('Enrollment', ref('Enrollment')), ...commonErrors, '404': error('`ENROLLMENT_NOT_FOUND`') },
      },
    },
    '/enrollments/{id}/status': {
      patch: {
        tags: ['Enrollments'],
        summary: 'Change the enrollment status',
        description:
          'Any status can be set; no academic progression rules are imposed. Setting WITHDRAWN releases the seat; leaving WITHDRAWN takes a seat again (the course must be open with room). Not allowed while the student is archived.',
        security: secured,
        parameters: [idParam],
        requestBody: jsonBody(fromZod(updateEnrollmentStatusSchema)),
        responses: {
          '200': ok('Status updated', ref('Enrollment')),
          ...commonErrors,
          '404': error('`ENROLLMENT_NOT_FOUND`'),
          '409': error('`STUDENT_ARCHIVED`, `COURSE_ARCHIVED`, `COURSE_NOT_OPEN`, `COURSE_FULL`, `CONFLICT`'),
        },
      },
    },

    '/dashboard/summary': {
      get: {
        tags: ['Dashboard'],
        summary: 'Dashboard summary for the caller',
        description: [
          'Sections: `leads` (leads:read_all or read_assigned; cohort in range + conversionsInRange + followUpsDue),',
          '`students` (any student read access; point-in-time; trainers get no conversion counts),',
          '`enrollments` (enrollments:read + student access), `teaching` (trainers), `courses` (courses:read),',
          '`campaigns` (campaigns:read), `staff` (users:read and/or trainers:read). Only `from`/`to` are accepted.',
        ].join(' '),
        security: secured,
        parameters: queryParameters(dashboardQuerySchema),
        responses: { '200': ok('Summary', ref('DashboardSummary')), '400': error('`VALIDATION_ERROR`: bad date, `from` after `to`, or range longer than allowed'), '401': commonErrors['401'] },
      },
    },
    '/reports/leads/summary': {
      get: {
        tags: ['Reports'],
        summary: 'Lead KPIs and funnel for a range (optionally compared with the previous period)',
        description:
          'Requires `reports:read` + `leads:read_all` (Owner, Admin, Marketing, Viewer). Filters: source, campaign (ids or `none`), assignedTo (ids or `unassigned`), country (case-insensitive). `compare=true` adds `previous` (same length, immediately before) and `change` (absolute; relative is null when the previous value is 0).',
        security: secured,
        parameters: queryParameters(leadSummaryQuerySchema),
        responses: { '200': ok('Lead summary', ref('LeadSummaryReport')), '400': error('`VALIDATION_ERROR`: bad date, `from` after `to`, or range longer than allowed'), '401': commonErrors['401'], '403': commonErrors['403'] },
      },
    },
    '/reports/leads/timeseries': {
      get: {
        tags: ['Reports'],
        summary: 'Leads per day, week (Monday) or month, zero-filled',
        description:
          'Each point: cohort counts of leads created in the bucket (leads, qualified, converted, lost by current status) and `conversions` that happened in the bucket. `period` is the first day of the bucket in Asia/Dubai.',
        security: secured,
        parameters: queryParameters(leadTimeseriesQuerySchema),
        responses: { '200': ok('Series', ref('LeadTimeseriesReport')), '400': error('`VALIDATION_ERROR`: bad date, `from` after `to`, or range longer than allowed'), '401': commonErrors['401'], '403': commonErrors['403'] },
      },
    },
    '/reports/leads/breakdown': {
      get: {
        tags: ['Reports'],
        summary: 'Leads created in the range grouped by source, status, campaign, assignee or country',
        description:
          'Sorted by lead count (desc), paginated over groups (`meta.total` = number of groups). `groupBy=assignee` is the employee leaderboard (assigned vs converted). `key: null` = no campaign / unassigned / no country. `share` = group leads / totalLeads.',
        security: secured,
        parameters: queryParameters(leadBreakdownQuerySchema),
        responses: { '200': ok('Breakdown', ref('LeadBreakdownReport'), true), '400': error('`VALIDATION_ERROR`: bad date, `from` after `to`, or range longer than allowed'), '401': commonErrors['401'], '403': commonErrors['403'] },
      },
    },
    '/reports/campaigns': {
      get: {
        tags: ['Reports'],
        summary: 'Campaign portfolio and per-platform performance (stored data only)',
        description:
          'Requires `reports:read` + `campaigns:read`. Budget and spend are lifetime figures (no daily spend data), so `costPerLead`/`costPerConversion` use lifetime attributed leads; `leadsInRange` is reported separately. Archived campaigns (and their leads) are excluded. No revenue or ROAS.',
        security: secured,
        parameters: queryParameters(campaignReportQuerySchema),
        responses: { '200': ok('Campaign report', ref('CampaignReport')), '400': error('`VALIDATION_ERROR`: bad date, `from` after `to`, or range longer than allowed'), '401': commonErrors['401'], '403': commonErrors['403'] },
      },
    },
    '/reports/academy': {
      get: {
        tags: ['Reports'],
        summary: 'Students, enrollments, course capacity, popular courses, countries and enrollment trend',
        description:
          'Requires `reports:read` + `students:read_all` + `enrollments:read` + `courses:read` (Owner, Admin, Viewer). `students.fromLeadConversion` counts students created by converting a lead; `students.withActiveEnrollments` counts distinct students with at least one non-withdrawn enrollment. They are different things: a converted student may have no enrollment.',
        security: secured,
        parameters: queryParameters(academyReportQuerySchema),
        responses: { '200': ok('Academy report', ref('AcademyReport')), '400': error('`VALIDATION_ERROR`: bad date, `from` after `to`, or range longer than allowed'), '401': commonErrors['401'], '403': commonErrors['403'] },
      },
    },

    '/campaigns': {
      get: {
        tags: ['Campaigns'],
        summary: 'List campaigns (with derived metrics)',
        security: secured,
        parameters: queryParameters(listCampaignsQuerySchema),
        responses: { '200': ok('A page of campaigns', { type: 'array', items: ref('Campaign') }, true), ...commonErrors },
      },
      post: {
        tags: ['Campaigns'],
        summary: 'Create a campaign',
        description:
          '`utm.campaign`, when set, must be unique (case-insensitive) so lead attribution is unambiguous. `courseId` must be an existing, non-archived course; `ownerId` an active Marketing/Admin/Owner user. Starts as DRAFT, SCHEDULED or RUNNING (default DRAFT).',
        security: secured,
        requestBody: jsonBody(fromZod(createCampaignSchema)),
        responses: {
          '201': ok('Created', ref('Campaign')),
          '400': error('`VALIDATION_ERROR`, `COURSE_NOT_FOUND`, `OWNER_NOT_FOUND`, `OWNER_INACTIVE`, `OWNER_ROLE_NOT_ALLOWED`'),
          '401': commonErrors['401'],
          '403': commonErrors['403'],
          '409': error('`CAMPAIGN_UTM_TAKEN` or `COURSE_ARCHIVED`'),
        },
      },
    },
    '/campaigns/{id}': {
      get: {
        tags: ['Campaigns'],
        summary: 'Get one campaign (with derived metrics)',
        security: secured,
        parameters: [idParam],
        responses: { '200': ok('Campaign', ref('Campaign')), ...commonErrors, '404': error('`CAMPAIGN_NOT_FOUND`') },
      },
      patch: {
        tags: ['Campaigns'],
        summary: 'Edit a campaign (status has its own endpoint)',
        security: secured,
        parameters: [idParam],
        requestBody: jsonBody(fromZod(updateCampaignSchema)),
        responses: {
          '200': ok('Updated', ref('Campaign')),
          ...commonErrors,
          '404': error('`CAMPAIGN_NOT_FOUND`'),
          '409': error('`CAMPAIGN_ARCHIVED`, `CAMPAIGN_UTM_TAKEN`, `COURSE_ARCHIVED`'),
        },
      },
    },
    '/campaigns/{id}/status': {
      patch: {
        tags: ['Campaigns'],
        summary: 'Change the campaign status (activate, pause, complete...)',
        description: 'Allowed transitions: DRAFT → SCHEDULED, RUNNING; SCHEDULED → RUNNING, DRAFT; RUNNING → PAUSED, COMPLETED; PAUSED → RUNNING, COMPLETED; COMPLETED → (final). Setting the current status is a no-op. Concurrent changes: only one applies.',
        security: secured,
        parameters: [idParam],
        requestBody: jsonBody(fromZod(updateCampaignStatusSchema)),
        responses: {
          '200': ok('Status updated', ref('Campaign')),
          ...commonErrors,
          '404': error('`CAMPAIGN_NOT_FOUND`'),
          '409': error('`INVALID_STATUS_TRANSITION`, `CAMPAIGN_ARCHIVED` or `CONFLICT`'),
        },
      },
    },
    '/campaigns/{id}/archive': {
      post: {
        tags: ['Campaigns'],
        summary: 'Archive a campaign',
        description: 'Read-only afterwards; accepts no new lead attributions. Existing attributions are kept.',
        security: secured,
        parameters: [idParam],
        responses: { '200': ok('Archived', ref('Campaign')), ...commonErrors, '404': error('`CAMPAIGN_NOT_FOUND`'), '409': error('`CAMPAIGN_ALREADY_ARCHIVED`') },
      },
    },
    '/campaigns/{id}/restore': {
      post: {
        tags: ['Campaigns'],
        summary: 'Restore an archived campaign (keeps its status)',
        security: secured,
        parameters: [idParam],
        responses: { '200': ok('Restored', ref('Campaign')), ...commonErrors, '404': error('`CAMPAIGN_NOT_FOUND`'), '409': error('`CAMPAIGN_NOT_ARCHIVED`') },
      },
    },
    '/leads/{id}/campaign': {
      patch: {
        tags: ['Leads'],
        summary: 'Set, change or remove the campaign attribution of a lead',
        description:
          'Requires `leads:update_all` and `campaigns:read` (Owner, Admin). A newly chosen campaign must exist, not be archived, and be RUNNING, PAUSED or COMPLETED. Does not change source/utm, status, or a converted student\'s conversion snapshot. `PATCH /leads/{id}` never changes the campaign.',
        security: secured,
        parameters: [idParam],
        requestBody: jsonBody(fromZod(setLeadCampaignSchema)),
        responses: {
          '200': ok('Attribution updated', ref('Lead')),
          '400': error('`VALIDATION_ERROR` or `CAMPAIGN_NOT_FOUND`'),
          '401': commonErrors['401'],
          '403': commonErrors['403'],
          '404': error('`LEAD_NOT_FOUND`'),
          '409': error('`LEAD_ARCHIVED`, `CAMPAIGN_ARCHIVED`, `CAMPAIGN_NOT_STARTED`'),
        },
      },
    },

    '/trainers': {
      get: {
        tags: ['Trainers'],
        summary: 'List trainers',
        description: '`course` returns trainers with an open assignment to those courses.',
        security: secured,
        parameters: queryParameters(listTrainersQuerySchema),
        responses: { '200': ok('A page of trainers', { type: 'array', items: ref('Trainer') }, true), ...commonErrors },
      },
      post: {
        tags: ['Trainers'],
        summary: 'Create a trainer profile',
        description:
          'Email is unique among trainers. `userId` links a login account, which must exist, not be INACTIVE, have the TRAINER role, and not be linked to another profile. No credentials are stored on trainers.',
        security: secured,
        requestBody: jsonBody(fromZod(createTrainerSchema)),
        responses: {
          '201': ok('Created', ref('Trainer')),
          '400': error('`VALIDATION_ERROR`, `USER_NOT_FOUND`, `USER_INACTIVE`, `USER_ROLE_NOT_TRAINER`'),
          '401': commonErrors['401'],
          '403': commonErrors['403'],
          '409': error('`TRAINER_EMAIL_TAKEN` or `TRAINER_USER_TAKEN`'),
        },
      },
    },
    '/trainers/me': {
      get: {
        tags: ['Trainers'],
        summary: "The caller's own trainer profile",
        description: 'Requires `trainers:read_own` (Trainer, plus Owner/Admin who hold every permission).',
        security: secured,
        responses: { '200': ok('Trainer', ref('Trainer')), ...commonErrors, '404': error('`TRAINER_PROFILE_NOT_FOUND`') },
      },
    },
    '/trainers/{id}': {
      get: {
        tags: ['Trainers'],
        summary: 'Get one trainer',
        security: secured,
        parameters: [idParam],
        responses: { '200': ok('Trainer', ref('Trainer')), ...commonErrors, '404': error('`TRAINER_NOT_FOUND`') },
      },
      patch: {
        tags: ['Trainers'],
        summary: 'Update a trainer profile (send userId: null to unlink the account)',
        description: 'INACTIVE trainers keep their assignments but lose teaching access and cannot be assigned until active again.',
        security: secured,
        parameters: [idParam],
        requestBody: jsonBody(fromZod(updateTrainerSchema)),
        responses: {
          '200': ok('Updated', ref('Trainer')),
          ...commonErrors,
          '404': error('`TRAINER_NOT_FOUND`'),
          '409': error('`TRAINER_ARCHIVED`, `TRAINER_EMAIL_TAKEN`, `TRAINER_USER_TAKEN`'),
        },
      },
    },
    '/trainers/{id}/archive': {
      post: {
        tags: ['Trainers'],
        summary: 'Archive a trainer',
        description: 'Ends every open assignment (CANCELLED, endedReason TRAINER_ARCHIVED) in the same transaction; the linked user loses teaching access at once.',
        security: secured,
        parameters: [idParam],
        responses: { '200': ok('Archived', ref('Trainer')), ...commonErrors, '404': error('`TRAINER_NOT_FOUND`'), '409': error('`TRAINER_ALREADY_ARCHIVED`') },
      },
    },
    '/trainers/{id}/restore': {
      post: {
        tags: ['Trainers'],
        summary: 'Restore an archived trainer (assignments are not reopened)',
        security: secured,
        parameters: [idParam],
        responses: { '200': ok('Restored', ref('Trainer')), ...commonErrors, '404': error('`TRAINER_NOT_FOUND`'), '409': error('`TRAINER_NOT_ARCHIVED`') },
      },
    },

    '/trainer-assignments': {
      get: {
        tags: ['Trainer assignments'],
        summary: 'List assignments',
        description: 'Managers (`trainers:read`) see all; trainers (`trainers:read_own`) only their own.',
        security: secured,
        parameters: queryParameters(listAssignmentsQuerySchema),
        responses: { '200': ok('A page of assignments', { type: 'array', items: ref('TrainerAssignment') }, true), ...commonErrors },
      },
      post: {
        tags: ['Trainer assignments'],
        summary: 'Assign a trainer to a course',
        description:
          'The trainer must exist, not be archived, and be ACTIVE or ON_LEAVE; the course must exist and not be archived (any status, so drafts can be staffed). Starts as ACTIVE or SCHEDULED.',
        security: secured,
        requestBody: jsonBody(fromZod(createAssignmentSchema)),
        responses: {
          '201': ok('Assigned', ref('TrainerAssignment')),
          '400': error('`VALIDATION_ERROR`, `TRAINER_NOT_FOUND`, `COURSE_NOT_FOUND`'),
          '401': commonErrors['401'],
          '403': commonErrors['403'],
          '409': error('`TRAINER_ARCHIVED`, `TRAINER_INACTIVE`, `COURSE_ARCHIVED`, `ASSIGNMENT_EXISTS`, `PRIMARY_TRAINER_EXISTS`'),
        },
      },
    },
    '/trainer-assignments/{id}': {
      get: {
        tags: ['Trainer assignments'],
        summary: 'Get one assignment',
        security: secured,
        parameters: [idParam],
        responses: { '200': ok('Assignment', ref('TrainerAssignment')), ...commonErrors, '404': error('`ASSIGNMENT_NOT_FOUND`') },
      },
      patch: {
        tags: ['Trainer assignments'],
        summary: 'Edit an open assignment (role, status SCHEDULED/ACTIVE, dates, hours)',
        security: secured,
        parameters: [idParam],
        requestBody: jsonBody(fromZod(updateAssignmentSchema)),
        responses: {
          '200': ok('Updated', ref('TrainerAssignment')),
          ...commonErrors,
          '404': error('`ASSIGNMENT_NOT_FOUND`'),
          '409': error('`ASSIGNMENT_ENDED` or `PRIMARY_TRAINER_EXISTS`'),
        },
      },
    },
    '/trainer-assignments/{id}/end': {
      post: {
        tags: ['Trainer assignments'],
        summary: 'End an assignment (COMPLETED or CANCELLED); final, kept as history',
        security: secured,
        parameters: [idParam],
        requestBody: jsonBody(fromZod(endAssignmentSchema)),
        responses: {
          '200': ok('Ended', ref('TrainerAssignment')),
          ...commonErrors,
          '404': error('`ASSIGNMENT_NOT_FOUND`'),
          '409': error('`ASSIGNMENT_ENDED`'),
        },
      },
    },

    '/diplomas': {
      get: {
        tags: ['Diplomas'],
        summary: 'List diplomas',
        description: '`course` returns diplomas containing any of those courses.',
        security: secured,
        parameters: queryParameters(listDiplomasQuerySchema),
        responses: { '200': ok('A page of diplomas', { type: 'array', items: ref('Diploma') }, true), ...commonErrors },
      },
      post: {
        tags: ['Diplomas'],
        summary: 'Create a diploma',
        description:
          'Names are unique ignoring case. Every id in `courseIds` must be an existing, non-archived course, without repeats (max 50). `price` is a whole amount of the configured currency.',
        security: secured,
        requestBody: jsonBody(fromZod(createDiplomaSchema)),
        responses: {
          '201': ok('Created', ref('Diploma')),
          '400': error('`VALIDATION_ERROR` or `COURSE_NOT_FOUND` (errors name the courseIds positions)'),
          '401': commonErrors['401'],
          '403': commonErrors['403'],
          '409': error('`DIPLOMA_NAME_TAKEN` or `COURSE_ARCHIVED`'),
        },
      },
    },
    '/diplomas/{id}': {
      get: {
        tags: ['Diplomas'],
        summary: 'Get one diploma',
        security: secured,
        parameters: [idParam],
        responses: { '200': ok('Diploma', ref('Diploma')), ...commonErrors, '404': error('`DIPLOMA_NOT_FOUND`') },
      },
      patch: {
        tags: ['Diplomas'],
        summary: 'Update a diploma',
        description:
          '`courseIds` replaces the whole ordered list. Courses already in the diploma may stay even if archived since; newly added courses must not be archived.',
        security: secured,
        parameters: [idParam],
        requestBody: jsonBody(fromZod(updateDiplomaSchema)),
        responses: {
          '200': ok('Updated', ref('Diploma')),
          ...commonErrors,
          '404': error('`DIPLOMA_NOT_FOUND`'),
          '409': error('`DIPLOMA_ARCHIVED`, `DIPLOMA_NAME_TAKEN`, `COURSE_ARCHIVED`'),
        },
      },
    },
    '/diplomas/{id}/archive': {
      post: {
        tags: ['Diplomas'],
        summary: 'Archive a diploma',
        security: secured,
        parameters: [idParam],
        responses: { '200': ok('Archived', ref('Diploma')), ...commonErrors, '404': error('`DIPLOMA_NOT_FOUND`'), '409': error('`DIPLOMA_ALREADY_ARCHIVED`') },
      },
    },
    '/diplomas/{id}/restore': {
      post: {
        tags: ['Diplomas'],
        summary: 'Restore an archived diploma',
        security: secured,
        parameters: [idParam],
        responses: { '200': ok('Restored', ref('Diploma')), ...commonErrors, '404': error('`DIPLOMA_NOT_FOUND`'), '409': error('`DIPLOMA_NOT_ARCHIVED`') },
      },
    },

    '/roles': {
      get: {
        tags: ['Roles'],
        summary: 'List roles with their permissions and user counts',
        description: `Requires \`${PERMISSIONS.ROLES_READ}\`.`,
        security: secured,
        responses: { '200': ok('Roles, most privileged first', { type: 'array', items: ref('Role') }), ...commonErrors },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
    schemas: {
      Error: {
        type: 'object',
        required: ['success', 'message', 'code'],
        properties: {
          success: { type: 'boolean', const: false },
          message: { type: 'string', example: 'Validation failed' },
          code: { type: 'string', example: 'VALIDATION_ERROR' },
          errors: {
            type: 'array',
            items: { type: 'object', properties: { path: { type: 'string' }, message: { type: 'string' } } },
          },
          requestId: { type: 'string' },
        },
      },
      PaginationMeta: {
        type: 'object',
        properties: {
          page: { type: 'integer' },
          limit: { type: 'integer' },
          total: { type: 'integer' },
          totalPages: { type: 'integer' },
        },
      },
      User: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          firstName: { type: 'string' },
          lastName: { type: 'string' },
          name: { type: 'string', description: 'firstName + lastName' },
          email: { type: 'string', format: 'email' },
          phone: { type: ['string', 'null'] },
          role: { type: 'string', enum: [...ROLE_KEYS] },
          roleName: { type: 'string' },
          status: { type: 'string', enum: [...USER_STATUSES] },
          avatarUrl: { type: ['string', 'null'] },
          department: { type: ['string', 'null'] },
          location: { type: ['string', 'null'] },
          lastLoginAt: { type: ['string', 'null'], format: 'date-time' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      CurrentUser: {
        allOf: [
          ref('User'),
          {
            type: 'object',
            properties: { permissions: { type: 'array', items: { type: 'string', enum: Object.values(PERMISSIONS) } } },
          },
        ],
      },
      Session: {
        type: 'object',
        properties: {
          accessToken: { type: 'string' },
          tokenType: { type: 'string', const: 'Bearer' },
          expiresIn: { type: 'integer', description: 'Seconds until the access token expires' },
          user: ref('User'),
        },
      },
      UserRef: {
        type: ['object', 'null'],
        properties: { id: { type: 'string' }, name: { type: 'string' }, email: { type: 'string' } },
      },
      Lead: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          reference: { type: 'string', example: 'LD-1001' },
          fullName: { type: 'string' },
          email: { type: ['string', 'null'] },
          phone: { type: ['string', 'null'] },
          country: { type: ['string', 'null'] },
          city: { type: ['string', 'null'] },
          profession: { type: ['string', 'null'] },
          source: { type: 'string', enum: [...LEAD_SOURCES] },
          utm: {
            type: ['object', 'null'],
            properties: Object.fromEntries(
              ['source', 'medium', 'campaign', 'term', 'content'].map((key) => [key, { type: ['string', 'null'] }]),
            ),
          },
          campaign: ref('CampaignRef'),
          campaignAttributedAt: { type: ['string', 'null'], format: 'date-time' },
          status: { type: 'string', enum: [...LEAD_STATUSES] },
          statusChangedAt: { type: ['string', 'null'], format: 'date-time' },
          lostReason: { type: ['string', 'null'] },
          priority: { type: 'string', enum: [...LEAD_PRIORITIES] },
          tags: { type: 'array', items: { type: 'string', enum: [...LEAD_TAGS] } },
          budget: { type: ['number', 'null'] },
          assignedTo: ref('UserRef'),
          assignedAt: { type: ['string', 'null'], format: 'date-time' },
          nextFollowUpAt: { type: ['string', 'null'], format: 'date-time' },
          notesCount: { type: 'integer' },
          archived: { type: 'boolean' },
          archivedAt: { type: ['string', 'null'], format: 'date-time' },
          createdBy: ref('UserRef'),
          convertedStudent: {
            type: ['object', 'null'],
            description: 'Set by conversion only',
            properties: { id: { type: 'string' }, studentNumber: { type: 'string' } },
          },
          convertedAt: { type: ['string', 'null'], format: 'date-time' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      LeadNote: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          leadId: { type: 'string' },
          body: { type: 'string' },
          pinned: { type: 'boolean' },
          author: ref('UserRef'),
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      Course: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          code: { type: 'string', example: 'DA-101' },
          name: { type: 'string' },
          description: { type: 'string' },
          level: { type: 'string', enum: [...COURSE_LEVELS] },
          duration: { type: ['string', 'null'], example: '16 weeks · 2 evenings/week' },
          hours: { type: ['integer', 'null'] },
          price: { type: 'integer', description: 'Whole units of `currency`' },
          currency: { type: 'string', const: CURRENCY },
          seats: { type: ['integer', 'null'], description: 'null = unlimited' },
          enrolledCount: { type: 'integer', description: 'Enrollments holding a seat (not WITHDRAWN)' },
          seatsAvailable: { type: ['integer', 'null'] },
          startDate: { type: ['string', 'null'], format: 'date-time' },
          endDate: { type: ['string', 'null'], format: 'date-time' },
          status: { type: 'string', enum: [...COURSE_STATUSES] },
          enrollable: { type: 'boolean' },
          archived: { type: 'boolean' },
          archivedAt: { type: ['string', 'null'], format: 'date-time' },
          createdBy: ref('UserRef'),
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      Student: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          studentNumber: { type: 'string', example: 'ST-1001' },
          fullName: { type: 'string' },
          email: { type: ['string', 'null'] },
          phone: { type: ['string', 'null'] },
          country: { type: ['string', 'null'] },
          city: { type: ['string', 'null'] },
          profession: { type: ['string', 'null'] },
          dateOfBirth: { type: ['string', 'null'], format: 'date' },
          status: { type: 'string', enum: [...STUDENT_STATUSES] },
          advisor: ref('UserRef'),
          advisorAssignedAt: { type: ['string', 'null'], format: 'date-time' },
          activeEnrollments: { type: 'integer', description: 'Enrollments that are not WITHDRAWN' },
          archived: { type: 'boolean' },
          archivedAt: { type: ['string', 'null'], format: 'date-time' },
          createdBy: ref('UserRef'),
          conversion: {
            type: ['object', 'null'],
            description: 'Read-only. Present only for students created by converting a lead.',
            properties: {
              leadId: { type: 'string' },
              leadReference: { type: 'string' },
              source: { type: 'string', enum: [...LEAD_SOURCES] },
              utm: { type: ['object', 'null'] },
              campaign: ref('CampaignRef'),
              convertedAt: { type: 'string', format: 'date-time' },
              convertedBy: ref('UserRef'),
            },
          },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      Enrollment: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          student: {
            type: ['object', 'null'],
            properties: { id: { type: 'string' }, studentNumber: { type: 'string' }, fullName: { type: 'string' } },
          },
          course: {
            type: ['object', 'null'],
            properties: { id: { type: 'string' }, code: { type: 'string' }, name: { type: 'string' } },
          },
          status: { type: 'string', enum: [...ENROLLMENT_STATUSES] },
          enrolledAt: { type: 'string', format: 'date-time' },
          statusChangedAt: { type: ['string', 'null'], format: 'date-time' },
          completedAt: { type: ['string', 'null'], format: 'date-time' },
          withdrawnAt: { type: ['string', 'null'], format: 'date-time' },
          price: { type: 'integer', description: 'Course price at enrollment time (absent for trainers)' },
          currency: { type: 'string', const: CURRENCY },
          enrolledBy: ref('UserRef'),
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      ReportRange: {
        type: 'object',
        properties: {
          from: { type: 'string', format: 'date' },
          to: { type: 'string', format: 'date' },
          days: { type: 'integer' },
          timezone: { type: 'string', const: REPORT_TIMEZONE },
        },
      },
      LeadCounts: {
        type: 'object',
        description: 'Over non-archived leads, by current status.',
        properties: {
          leads: { type: 'integer' },
          byStatus: { type: 'object', additionalProperties: { type: 'integer' } },
          qualified: { type: 'integer', description: 'QUALIFIED or later (not LOST)' },
          converted: { type: 'integer', description: 'Status REGISTERED (converted to a student)' },
          lost: { type: 'integer' },
          open: { type: 'integer', description: 'leads - converted - lost' },
          conversionRate: { type: 'number', description: 'converted / leads (0..1); 0 when leads = 0' },
          conversionsInRange: { type: 'integer', description: 'Leads whose convertedAt is in the range' },
        },
      },
      LeadSummaryReport: {
        type: 'object',
        properties: {
          range: ref('ReportRange'),
          summary: ref('LeadCounts'),
          funnel: {
            type: 'object',
            properties: {
              stages: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    stage: { type: 'string', enum: [...LEAD_STATUSES] },
                    value: { type: 'integer', description: 'Non-lost leads currently at this stage or later' },
                    conversionFromPrevious: { type: 'number' },
                    conversionFromTop: { type: 'number' },
                  },
                },
              },
              lost: { type: 'integer' },
            },
          },
          previous: { type: 'object', properties: { range: ref('ReportRange'), summary: ref('LeadCounts') } },
          change: { type: 'object', additionalProperties: { type: 'object', properties: { absolute: { type: 'number' }, relative: { type: ['number', 'null'] } } } },
        },
      },
      LeadTimeseriesReport: {
        type: 'object',
        properties: {
          range: ref('ReportRange'),
          interval: { type: 'string', enum: ['day', 'week', 'month'] },
          points: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                period: { type: 'string', format: 'date' },
                leads: { type: 'integer' },
                qualified: { type: 'integer' },
                converted: { type: 'integer' },
                lost: { type: 'integer' },
                conversions: { type: 'integer' },
              },
            },
          },
        },
      },
      LeadBreakdownReport: {
        type: 'object',
        properties: {
          range: ref('ReportRange'),
          groupBy: { type: 'string', enum: ['source', 'status', 'campaign', 'assignee', 'country'] },
          totalLeads: { type: 'integer' },
          rows: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                key: { type: ['string', 'null'] },
                label: { type: 'string' },
                leads: { type: 'integer' },
                qualified: { type: 'integer' },
                converted: { type: 'integer' },
                lost: { type: 'integer' },
                conversionRate: { type: 'number' },
                share: { type: 'number' },
              },
            },
          },
        },
      },
      CampaignReport: {
        type: 'object',
        properties: {
          range: ref('ReportRange'),
          portfolio: {
            type: 'object',
            properties: {
              total: { type: 'integer' },
              byStatus: { type: 'object', additionalProperties: { type: 'integer' } },
              budget: { type: 'integer', description: 'Whole AED, lifetime; unset budgets count as 0' },
              spent: { type: 'integer', description: 'Whole AED, lifetime (entered by Marketing)' },
            },
          },
          rows: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                platform: { type: 'string', enum: [...CAMPAIGN_PLATFORMS] },
                campaigns: { type: 'integer' },
                budget: { type: 'integer' },
                spent: { type: 'integer' },
                leads: { type: 'integer', description: 'Lifetime attributed, non-archived leads' },
                converted: { type: 'integer' },
                leadsInRange: { type: 'integer' },
                costPerLead: { type: ['number', 'null'] },
                costPerConversion: { type: ['number', 'null'] },
                spendShare: { type: 'number' },
              },
            },
          },
          unattributedLeads: { type: 'integer' },
          unattributedLeadsInRange: { type: 'integer' },
        },
      },
      AcademyReport: {
        type: 'object',
        properties: {
          range: ref('ReportRange'),
          interval: { type: 'string', enum: ['day', 'week', 'month'] },
          students: {
            type: 'object',
            properties: {
              total: { type: 'integer' },
              byStatus: { type: 'object', additionalProperties: { type: 'integer' } },
              withActiveEnrollments: { type: 'integer' },
              fromLeadConversion: { type: 'integer' },
              createdDirectly: { type: 'integer' },
            },
          },
          enrollments: {
            type: 'object',
            properties: {
              byStatus: { type: 'object', additionalProperties: { type: 'integer' } },
              total: { type: 'integer' },
              active: { type: 'integer' },
              enrolledInRange: { type: 'integer' },
              completedInRange: { type: 'integer' },
              withdrawnInRange: { type: 'integer' },
            },
          },
          courses: {
            type: 'object',
            properties: {
              total: { type: 'integer' },
              byStatus: { type: 'object', additionalProperties: { type: 'integer' } },
              limitedCourses: { type: 'integer' },
              unlimitedCourses: { type: 'integer' },
              seats: { type: 'integer' },
              seatsTaken: { type: 'integer' },
              fillRate: { type: 'number' },
              fullCourses: { type: 'integer' },
              enrolled: { type: 'integer' },
            },
          },
          popularCourses: {
            type: 'array',
            items: { type: 'object', properties: { courseId: { type: 'string' }, code: { type: 'string' }, name: { type: 'string' }, archived: { type: 'boolean' }, enrollments: { type: 'integer' } } },
          },
          countries: { type: 'array', items: { type: 'object', properties: { key: { type: ['string', 'null'] }, label: { type: 'string' }, students: { type: 'integer' } } } },
          trend: { type: 'array', items: { type: 'object', properties: { period: { type: 'string', format: 'date' }, enrolled: { type: 'integer' }, completed: { type: 'integer' } } } },
        },
      },
      DashboardSummary: {
        type: 'object',
        properties: {
          range: ref('ReportRange'),
          sections: {
            type: 'object',
            description: 'Only the sections the caller is allowed to see are present.',
            properties: {
              leads: { allOf: [ref('LeadCounts'), { type: 'object', properties: { scope: { type: 'string', enum: ['all', 'assigned'] }, followUpsDue: { type: 'integer' } } }] },
              students: { type: 'object', properties: { scope: { type: 'string', enum: ['all', 'advised', 'teaching'] } } },
              enrollments: { type: 'object' },
              teaching: { type: 'object', properties: { coursesTaught: { type: 'integer' } } },
              courses: { type: 'object' },
              campaigns: { type: 'object' },
              staff: { type: 'object', properties: { usersByStatus: { type: 'object' }, trainersByStatus: { type: 'object' } } },
            },
          },
        },
      },
      CampaignRef: {
        type: ['object', 'null'],
        properties: { id: { type: 'string' }, code: { type: 'string' }, name: { type: 'string' }, archived: { type: 'boolean' } },
      },
      Campaign: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          code: { type: 'string', example: 'CMP-1001' },
          name: { type: 'string' },
          platform: { type: 'string', enum: [...CAMPAIGN_PLATFORMS] },
          objective: { type: ['string', 'null'] },
          description: { type: 'string' },
          course: { type: ['object', 'null'], properties: { id: { type: 'string' }, code: { type: 'string' }, name: { type: 'string' } } },
          owner: ref('UserRef'),
          budget: { type: ['integer', 'null'], description: 'Whole units of `currency`' },
          spent: { type: 'integer', description: 'Whole units of `currency`, entered by Marketing' },
          currency: { type: 'string', const: CURRENCY },
          startDate: { type: ['string', 'null'], format: 'date-time' },
          endDate: { type: ['string', 'null'], format: 'date-time' },
          utm: {
            type: ['object', 'null'],
            properties: Object.fromEntries(['source', 'medium', 'campaign', 'term', 'content'].map((k) => [k, { type: ['string', 'null'] }])),
          },
          status: { type: 'string', enum: [...CAMPAIGN_STATUSES], description: `Transitions: ${JSON.stringify(CAMPAIGN_TRANSITIONS)}` },
          statusChangedAt: { type: ['string', 'null'], format: 'date-time' },
          metrics: ref('CampaignMetrics'),
          archived: { type: 'boolean' },
          archivedAt: { type: ['string', 'null'], format: 'date-time' },
          createdBy: ref('UserRef'),
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      CampaignMetrics: {
        type: 'object',
        description: 'Derived from attributed, non-archived leads at request time.',
        properties: {
          leads: { type: 'integer' },
          byStatus: { type: 'object', additionalProperties: { type: 'integer' }, description: 'Lead count per lead status' },
          qualifiedLeads: { type: 'integer', description: 'Currently QUALIFIED, MEETING_SCHEDULED, PAYMENT_PENDING or REGISTERED' },
          registeredStudents: { type: 'integer', description: 'Leads converted to students' },
          lostLeads: { type: 'integer' },
          conversionRate: { type: 'number', description: 'registeredStudents / leads (0..1)' },
          costPerLead: { type: ['number', 'null'], description: 'spent / leads in AED; null with no leads' },
          budgetUsed: { type: ['number', 'null'], description: 'spent / budget; null without a budget' },
        },
      },
      StudentTeaching: {
        type: 'object',
        description: 'Reduced student view returned to trainers (students:read_teaching).',
        properties: {
          id: { type: 'string' },
          studentNumber: { type: 'string' },
          fullName: { type: 'string' },
          email: { type: ['string', 'null'] },
          status: { type: 'string', enum: [...STUDENT_STATUSES] },
        },
      },
      Trainer: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          code: { type: 'string', example: 'TR-1001' },
          fullName: { type: 'string' },
          title: { type: ['string', 'null'] },
          specialization: { type: ['string', 'null'] },
          email: { type: 'string', format: 'email' },
          phone: { type: ['string', 'null'] },
          bio: { type: 'string' },
          status: { type: 'string', enum: [...TRAINER_STATUSES] },
          experienceYears: { type: ['integer', 'null'] },
          weeklyCapacityHours: { type: ['integer', 'null'] },
          joinDate: { type: ['string', 'null'], format: 'date' },
          city: { type: ['string', 'null'] },
          country: { type: ['string', 'null'] },
          user: ref('UserRef'),
          openAssignments: { type: 'integer', description: 'Open (SCHEDULED/ACTIVE) assignments' },
          archived: { type: 'boolean' },
          archivedAt: { type: ['string', 'null'], format: 'date-time' },
          createdBy: ref('UserRef'),
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      TrainerAssignment: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          trainer: { type: ['object', 'null'], properties: { id: { type: 'string' }, code: { type: 'string' }, fullName: { type: 'string' } } },
          course: { type: ['object', 'null'], properties: { id: { type: 'string' }, code: { type: 'string' }, name: { type: 'string' } } },
          role: { type: 'string', enum: [...ASSIGNMENT_ROLES] },
          status: { type: 'string', enum: [...ASSIGNMENT_STATUSES] },
          open: { type: 'boolean' },
          startDate: { type: ['string', 'null'], format: 'date-time' },
          endDate: { type: ['string', 'null'], format: 'date-time' },
          teachingHours: { type: ['integer', 'null'] },
          endedAt: { type: ['string', 'null'], format: 'date-time' },
          endedReason: { type: ['string', 'null'], enum: [...ASSIGNMENT_END_REASONS, null] },
          endedBy: ref('UserRef'),
          assignedBy: ref('UserRef'),
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      Diploma: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          name: { type: 'string' },
          description: { type: 'string' },
          level: { type: 'string', enum: [...COURSE_LEVELS] },
          duration: { type: ['string', 'null'] },
          price: { type: ['integer', 'null'], description: 'Whole units of `currency`' },
          currency: { type: 'string', const: CURRENCY },
          status: { type: 'string', enum: [...DIPLOMA_STATUSES] },
          courseIds: { type: 'array', items: { type: 'string' }, description: 'Ordered (frontend courseIds[])' },
          courses: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                code: { type: 'string' },
                name: { type: 'string' },
                status: { type: 'string', enum: [...COURSE_STATUSES] },
                archived: { type: 'boolean' },
              },
            },
          },
          coursesCount: { type: 'integer' },
          archived: { type: 'boolean' },
          archivedAt: { type: ['string', 'null'], format: 'date-time' },
          createdBy: ref('UserRef'),
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      Role: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          key: { type: 'string', enum: [...ROLE_KEYS] },
          name: { type: 'string' },
          description: { type: 'string' },
          level: { type: 'integer', description: 'Lower is more privileged' },
          isSystem: { type: 'boolean' },
          permissions: { type: 'array', items: { type: 'string' } },
          usersCount: { type: 'integer' },
        },
      },
    },
  },
};
