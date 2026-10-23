# Academy CRM API

Backend for the Higher Innovation Academy CRM: Node.js, Express 5, TypeScript, MongoDB, Mongoose 9.
Design notes, permission matrix and open decisions: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Status

| Phase | Scope | State |
|---|---|---|
| 1 | Project setup, config, Express, MongoDB/Mongoose, error handling, health check, Swagger | Done |
| 2 | Authentication, sessions, password reset, users, roles, permissions, seed | Done |
| 3 | Leads: CRUD, assignment, status, notes, archive, role-based visibility | Done |
| 4 | Courses, Students, Enrollments (seat limits, advisor-based visibility, archive) | Done |
| 5 | Lead→Student conversion (transactional, exactly once, attribution kept) | Done |
| 6 | Trainers, trainer assignments, trainer read access, diplomas, currency | Done |
| 7 | Campaigns, campaign→lead attribution, derived campaign metrics | Done |
| 8 | Dashboard summary and reports (leads, campaigns, academy) | Done |
| Release readiness | Concurrency-safe duplicate contacts (D37), stricter env validation, MongoDB version check, staging checklist ([docs/RELEASE-READINESS.md](docs/RELEASE-READINESS.md)) | Done locally; staging not yet run |

## Requirements

- Node.js 22.12+ (developed on Node 24 LTS)
- MongoDB **5.0 or later** (reports use `$dateTrunc`), running as a **replica set** (transactions). The API checks both at startup and refuses to run otherwise. Tests and local development use MongoDB 8.2; 7.0+ is recommended for staging/production. Any of:
  - MongoDB Atlas (free tier works; always a replica set)
  - `docker compose up -d` with the included file (single-node replica set `rs0`)
  - A local `mongod --replSet rs0`, initialised once with `mongosh --eval "rs.initiate()"`

## First-time setup

```bash
npm install
# npm 11 asks before running dependency install scripts. The ones this project needs
# (bcrypt, esbuild, mongodb-memory-server) are already approved in package.json ("allowScripts").

cp .env.example .env
#   - set MONGODB_URI
#   - set JWT_ACCESS_SECRET:  node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
#   - set SEED_OWNER_EMAIL and SEED_OWNER_PASSWORD (10+ chars, a letter and a digit)

npm run db:seed     # builds indexes, creates the 7 roles and the first Owner
# then remove SEED_OWNER_PASSWORD from .env and sign in as the Owner

npm run dev         # http://localhost:4000/api/docs
```

Use `127.0.0.1` rather than `localhost` in a local `MONGODB_URI`: Node resolves `localhost`
to IPv6 `::1` first, and a default `mongod` only listens on IPv4.

`mongodb+srv://` needs a DNS SRV lookup, which some home routers refuse (`querySrv EREFUSED`; Compass
still connects). In development the API then switches its own process to public resolvers (8.8.8.8, 1.1.1.1)
and logs a warning (`src/database/srvDns.ts`). Staging and production never do this.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Start with auto-reload (tsx watch) on `PORT` (default 4000) |
| `npm run build` | Compile to `dist/` |
| `npm start` | Run the compiled build (`dist/server.js`) |
| `npm run typecheck` | Type-check app, tests and config |
| `npm test` | Run the test suite |
| `npm run db:seed` | Indexes + roles + first Owner (idempotent; never modifies an existing account) |
| `npm run db:indexes` | Make MongoDB indexes match the schemas |
| `npm run db:seed:prod` / `npm run db:indexes:prod` | Same, from the compiled build (for servers without dev dependencies) |
| `npm run seed:demo` | Local demo data: 10 records per module (run `db:seed` first). Local development/test databases only |

**Demo data (`npm run seed:demo`):** adds 10 realistic records each for users, courses, trainers, trainer
assignments, campaigns, diplomas, students, enrollments, leads and lead notes, through the same services and
validation as the API (`src/database/demoSeed.ts`). Re-running only adds what is missing; existing records are
never modified or deleted. It refuses to run unless `NODE_ENV` is development/test, `DEPLOY_ENV` is unset, and
`MONGODB_URI` points only at `localhost`/`127.0.0.1`/`::1` (no `mongodb+srv`) with a database named like
`academy_crm_dev` (a dev/development/local/demo/test/e2e segment, no prod/live/staging/main/backup); after
connecting, the server itself must report only local members. **Remote database (development only):** set
`DEMO_SEED_REMOTE_DATABASE` to the exact database name in `MONGODB_URI` (e.g. `higher-edu`) as a typed confirmation;
before the first write the database must contain only this CRM's collections and demo records, so a database of
another project, or one with real data, is refused and left untouched. Demo people use the reserved
`@demo.hia-academy.test` domain and demo course codes start with `DEMO-`. Demo staff accounts have no password
(they cannot sign in). Only users have an image field: each gets its own original SVG avatar from the frontend's
`public/demo/avatars/` (served at `/demo/avatars/<name>.svg`).

**Production deploys:** indexes are not built automatically in production; run `npm run db:indexes:prod`
on each deploy (and `db:seed:prod` once for a new environment).

**Tests** need no database setup and never read `.env`: they start a real, throwaway `mongod`
(mongodb-memory-server) as a single-node replica set, and read the emails the app writes to a temporary
outbox. The first run downloads the MongoDB binary (several hundred MB) and caches it.

Offline configuration checks (never connect, never print values):

```bash
npm run config:check                                 # validate .env (or -- --env-file <path>)
npm run preflight:staging:dev -- --env-file <path>   # staging isolation preflight on a candidate file
npm run preflight:staging                            # same, on the built app and the real environment (staging host)
```

Staging uses `DEPLOY_ENV=staging`, `PRODUCTION_DB_HOST_SHA256` and `STAGING_CONNECTIVITY_APPROVED`; see
[docs/STAGING.md](docs/STAGING.md).

## Endpoints

All under `/api/v1`. Full request/response schemas in Swagger UI at `/api/docs`.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health`, `/health/ready` | – | Liveness; readiness (MongoDB ping, 503 if down) |
| POST | `/auth/login` | – | Email + password → access token (body) + refresh cookie |
| POST | `/auth/refresh` | cookie | Rotate refresh token, new access token |
| POST | `/auth/logout` | cookie | Revoke this session, clear cookie |
| POST | `/auth/logout-all` | Bearer | Revoke every session of this user |
| GET | `/auth/me` | Bearer | Current user + permissions |
| PATCH | `/auth/me` | Bearer | Edit your own name, phone, location (email/role/status are admin-managed) |
| POST | `/auth/change-password` | Bearer | Change password; other sessions are signed out |
| POST | `/auth/forgot-password` | – | Email a reset link (always 202, no account enumeration) |
| POST | `/auth/reset-password` | – | Set password with a reset **or invitation** token |
| GET | `/users` | `users:read` | List with `page, limit, search, role, status, sortBy, sortDir` |
| POST | `/users` | `users:create` | Create staff account (INVITED) and email an invitation |
| GET | `/users/:id` | `users:read` | One user |
| PATCH | `/users/:id` | `users:update` | Profile fields / status (suspend ends sessions immediately) |
| PATCH | `/users/:id/role` | `users:assign_role` | Assign a role (hierarchy rules apply) |
| POST | `/users/:id/resend-invite` | `users:create` | New invitation link |
| GET | `/roles` | `roles:read` | Roles with permissions and user counts |
| GET | `/leads` | `leads:read_*` | List: `page, limit, search, status, source, priority, tags, country, assignedTo, createdFrom, createdTo, followUpBefore, archived, sortBy, sortDir` |
| POST | `/leads` | `leads:create` | Create (duplicate email/phone → 409; optional `campaignId` needs `campaigns:read`; may return `warnings`) |
| GET | `/leads/:id` | `leads:read_*` | One lead |
| PATCH | `/leads/:id` | `leads:update_*` | Edit details (not status/assignment/archive); contact change to another active lead's → 409 unless Owner/Admin send `allowDuplicate: true`; may return `warnings` |
| PATCH | `/leads/:id/status` | `leads:update_*` | Pipeline status (`REGISTERED` reserved for conversion) |
| PATCH | `/leads/:id/assign` | `leads:assign` | Assign / reassign / unassign |
| POST | `/leads/:id/archive`, `/leads/:id/restore` | `leads:archive` | Soft delete / undo (no hard delete); restore → 409 `DUPLICATE_LEAD` if an active lead now has the contact |
| GET, POST | `/leads/:id/notes` | `leads:read_*` / `leads:update_*` | List / add notes |
| POST | `/leads/:id/convert` | `leads:update_*` + `students:create` | Convert to a student (see below) |
| GET | `/courses` | `courses:read` | List: `page, limit, search, status, level, startFrom, startTo, enrollable, archived, sortBy, sortDir` |
| POST | `/courses` | `courses:write` | Create (code unique, default DRAFT) |
| GET / PATCH | `/courses/:id` | `courses:read` / `courses:write` | One course / edit |
| POST | `/courses/:id/archive`, `/courses/:id/restore` | `courses:write` | Soft delete / undo |
| GET | `/students` | `students:read_*` | List: `page, limit, search, status, country, advisor, course, createdFrom, createdTo, archived, sortBy, sortDir` |
| POST | `/students` | `students:create` | Create (duplicate email/phone → 409; may return `warnings`) |
| GET / PATCH | `/students/:id` | `students:read_*` / `students:update_*` | One student / edit details and status (contact duplicate → 409 unless Owner/Admin send `allowDuplicate: true`; may return `warnings`) |
| PATCH | `/students/:id/advisor` | `students:assign` | Set / change / remove advisor |
| POST | `/students/:id/archive`, `/students/:id/restore` | `students:archive` | Soft delete (only without active enrollments) / undo; restore → 409 `DUPLICATE_STUDENT` if an active student now has the contact |
| POST | `/students/:id/enrollments` | `enrollments:write` + `students:update_*` | Enroll in a course (`{ courseId, enrolledAt? }`) |
| GET | `/enrollments` | `enrollments:read` + `students:read_*` | List: `page, limit, student, course, status, enrolledFrom, enrolledTo, sortBy, sortDir` |
| GET | `/enrollments/:id` | same | One enrollment |
| PATCH | `/enrollments/:id/status` | `enrollments:write` + `students:update_*` | `NOT_STARTED`, `IN_PROGRESS`, `COMPLETED`, `WITHDRAWN` |
| GET | `/trainers` | `trainers:read` | List: `page, limit, search, status, specialization, course, archived, sortBy, sortDir` |
| POST | `/trainers` | `trainers:write` | Create profile (optional `userId` link to a TRAINER-role account) |
| GET | `/trainers/me` | `trainers:read_own` | The caller's own trainer profile |
| GET / PATCH | `/trainers/:id` | `trainers:read` / `trainers:write` | One trainer / edit (`userId: null` unlinks) |
| POST | `/trainers/:id/archive`, `/trainers/:id/restore` | `trainers:write` | Archive (ends open assignments) / restore |
| GET | `/trainer-assignments` | `trainers:read` or `trainers:read_own` | List: `page, limit, trainer, course, status, role, open, sortBy, sortDir` (trainers: own only) |
| POST | `/trainer-assignments` | `trainers:write` | Assign `{ trainerId, courseId, role, status?, startDate?, endDate?, teachingHours? }` |
| GET / PATCH | `/trainer-assignments/:id` | read / `trainers:write` | One assignment / edit an open one |
| POST | `/trainer-assignments/:id/end` | `trainers:write` | End: `{ status: COMPLETED \| CANCELLED }` (final, kept as history) |
| GET | `/diplomas` | `courses:read` | List: `page, limit, search, status, level, course, archived, sortBy, sortDir` |
| POST | `/diplomas` | `courses:write` | Create `{ name, level, courseIds[], price?, duration?, description?, status? }` |
| GET / PATCH | `/diplomas/:id` | `courses:read` / `courses:write` | One diploma / edit (`courseIds` replaces the list) |
| POST | `/diplomas/:id/archive`, `/diplomas/:id/restore` | `courses:write` | Soft delete / undo |
| GET | `/campaigns` | `campaigns:read` | List with metrics: `page, limit, search, status, platform, course, owner, startFrom, startTo, archived, sortBy, sortDir` |
| POST | `/campaigns` | `campaigns:write` | Create |
| GET / PATCH | `/campaigns/:id` | `campaigns:read` / `campaigns:write` | One campaign (with metrics) / edit (not status) |
| PATCH | `/campaigns/:id/status` | `campaigns:write` | Activate / pause / complete… along the transition table |
| POST | `/campaigns/:id/archive`, `/campaigns/:id/restore` | `campaigns:write` | Soft delete / undo |
| PATCH | `/leads/:id/campaign` | `leads:update_all` + `campaigns:read` | Explicitly set / change / remove a lead's campaign |
| GET | `/dashboard/summary` | signed in (sections by permission, scoped) | `from, to` |
| GET | `/reports/leads/summary` | `reports:read` + `leads:read_all` | `from, to, source, campaign, assignedTo, country, compare` |
| GET | `/reports/leads/timeseries` | same | `from, to, interval (day\|week\|month)`, same filters |
| GET | `/reports/leads/breakdown` | same | `groupBy (source\|status\|campaign\|assignee\|country), page, limit`, range, filters |
| GET | `/reports/campaigns` | `reports:read` + `campaigns:read` | `from, to` (only for `leadsInRange`) |
| GET | `/reports/academy` | `reports:read` + `students:read_all` + `enrollments:read` + `courses:read` | `from, to, interval` |

There is **no public registration**. Staff accounts are created by Owner/Admin; the first Owner only by `db:seed`.

`leads:read_*` means `leads:read_all` (every lead) or `leads:read_assigned` (Sales: only leads assigned to them);
likewise `leads:update_*`, and for students `students:read_*` / `students:update_*` (Sales: only students they
advise). Enrollments follow their student's visibility. The narrower scope is applied inside every query, so a lead outside the caller's scope
answers 404 from every endpoint, and list filters can only narrow results, never widen them.

## Lead → Student conversion

`POST /api/v1/leads/:id/convert`. Allowed for Owner, Admin, and Sales on leads assigned to them
(needs lead edit access **and** `students:create`; nobody gained new permissions).

Request body (all optional; corrects the **student** only, the lead is never modified):

```jsonc
{
  "fullName": "Mariam Adel Hassan", "email": "m@example.com", "phone": "+20 100 444 5566",
  "country": "Egypt", "city": "Alexandria", "profession": "Accountant",
  "dateOfBirth": "2001-03-09",          // YYYY-MM-DD, in the past
  "status": "ACTIVE",                   // student status, default ACTIVE
  "allowDuplicate": false               // only honoured for students:update_all holders
}
```

Response `201`:

```jsonc
{
  "success": true,
  "message": "Lead converted to student ST-1001",
  "data": {
    "student": { "id": "…", "studentNumber": "ST-1001", "fullName": "…", "advisor": { "id": "…" },
                 "conversion": { "leadId": "…", "leadReference": "LD-1001", "source": "GOOGLE_ADS",
                                 "utm": { "source": "google", … }, "convertedAt": "…", "convertedBy": { … } }, … },
    "lead": { "id": "…", "status": "REGISTERED", "convertedStudent": { "id": "…", "studentNumber": "ST-1001" },
              "convertedAt": "…", … }
  }
}
```

| Rule | Behaviour |
|---|---|
| Field mapping | fullName, email, phone, country, city, profession copied from the lead (request values win); `dateOfBirth` only from the request |
| Advisor | The lead's assignee if active and allowed to advise students (Sales/Admin/Owner); otherwise none. Never from the client |
| Attribution | Lead id, reference, `source` and `utm` copied to `student.conversion` (read-only) |
| Lead | Kept with its notes; status becomes `REGISTERED` (final) and `convertedStudent` / `convertedAt` are set |
| Enrollment | **Not** created. Enroll afterwards with `POST /students/:id/enrollments` (seat rules unchanged) |
| Errors | 400 `VALIDATION_ERROR`; 403 role / `FORBIDDEN_FIELD`; 404 `LEAD_NOT_FOUND` (also another salesperson's lead); 409 `LEAD_ARCHIVED`, `LEAD_ALREADY_CONVERTED`, `DUPLICATE_STUDENT` |
| Duplicates | An active student with the same email or normalised phone → 409. Only callers who see all students learn which student matched. Managers may override with `allowDuplicate` for legitimate cases (siblings or spouses sharing a parent's phone or a family email). Records are never merged |
| Exactly once | One transaction; conditional claim of the lead + unique index on `student.conversion.lead`. Concurrent requests: one 201, the rest 409 |

## Trainers, assignments and diplomas

- **Trainer** is a profile separate from user accounts. It holds no credentials; an optional `userId` links
  one TRAINER-role account (unique). Email is unique among trainers.
- **Assignments** link trainers and courses (many-to-many). SCHEDULED/ACTIVE are open; COMPLETED/CANCELLED
  are final history. At most one open assignment per trainer and course and one open PRIMARY per course
  (database-enforced). Archiving a trainer or a course ends its open assignments (`endedReason`
  `TRAINER_ARCHIVED` / `COURSE_ARCHIVED`); restoring does not reopen them.
- **Trainer access** (TRAINER role): read-only; students and enrollments of courses with an open assignment
  for their profile, with reduced fields (students: `id, studentNumber, fullName, email, status`;
  enrollments: no `price`, `currency`, `enrolledBy`). Profile ARCHIVED or INACTIVE → no access. No trainer
  profile → empty lists.
- **Diplomas** list courses in order (`courseIds[]`); a course can be in several diplomas. New courses must
  exist and not be archived; a course archived later stays listed with `archived: true`. Diplomas never
  enroll or charge anyone.

## Campaigns and attribution

| Who | View | Create / edit / status / archive / restore | Attribute a new lead | Change a lead's campaign |
|---|:-:|:-:|:-:|:-:|
| Owner, Admin | ✓ | ✓ | ✓ | ✓ |
| Marketing | ✓ | ✓ | ✓ | – |
| Viewer | ✓ | – | – (cannot create leads) | – |
| Sales | 403 | 403 | 403 `FORBIDDEN_FIELD` | – |
| HR, Trainer | 403 | 403 | – | – |

- **Status**: `DRAFT → SCHEDULED | RUNNING`, `SCHEDULED → RUNNING | DRAFT`, `RUNNING → PAUSED | COMPLETED`,
  `PAUSED → RUNNING | COMPLETED`; `COMPLETED` is final. Archive is separate and keeps the status.
- **Identifiers**: `code` (`CMP-1001`) and `utm.campaign` are unique (UTM case-insensitive, database-enforced).
  Names can repeat.
- **Attribution**: a lead may be attributed only to a campaign that exists, is not archived and is `RUNNING`,
  `PAUSED` or `COMPLETED`. Existing attributions stay when the campaign is completed or archived (the reference
  shows `archived: true`). `PATCH /leads/:id` never changes the campaign; source and UTM are never derived from or
  overwritten by the campaign. Conversion copies the campaign into `student.conversion.campaign` (snapshot).
- **Metrics** are computed from the attributed, non-archived leads on every request (no stored counters):
  `leads`, `byStatus`, `qualifiedLeads` (currently QUALIFIED or later, not LOST), `registeredStudents`, `lostLeads`,
  `conversionRate`, `costPerLead`, `budgetUsed`. Impressions, clicks, visitors and revenue need ad-platform and
  payment integrations and are not provided.

## Dashboard and reports

**Dates**: `from`/`to` are inclusive calendar days (YYYY-MM-DD) in **Asia/Dubai** (UTC+4, no daylight saving); a
record is in range when `from 00:00 Dubai ≤ timestamp < (to + 1 day) 00:00 Dubai`. Default: the last 30 days including
today. Maximum: 92 days for daily series, 371 for weekly, 1830 for monthly series and summaries. Weeks start on Monday;
`period` is the first day of each bucket; empty buckets are returned as zeros.

**Who sees what** (no permission was added or broadened):

| Role | `/dashboard/summary` sections | Reports |
|---|---|---|
| Owner, Admin | leads, students, enrollments, courses, campaigns, staff | all |
| Marketing | leads (all), courses, campaigns | leads, campaigns |
| Viewer | leads, students, enrollments, courses, campaigns, staff (trainers only) | leads, campaigns, academy |
| Sales | leads (**own only**), students (**advised only**), enrollments (of those students), courses | none (403) |
| Trainer | students and enrollments (**taught courses only**, no conversion counts), teaching, courses | none (403) |
| HR | staff | none (403) |

**Metric definitions** (shared code in `src/modules/leads/lead.metrics.ts`, also used by campaign metrics):

| Metric | Numerator / value | Denominator | Time basis | Excluded |
|---|---|---|---|---|
| `leads` | leads | – | `createdAt` in range (cohort) | archived leads |
| `byStatus.*` | cohort leads per **current** status | – | cohort | archived |
| `qualified` | cohort leads currently QUALIFIED, MEETING_SCHEDULED, PAYMENT_PENDING or REGISTERED | – | cohort | archived, LOST |
| `converted` | cohort leads currently REGISTERED (converted to a student; at most once per lead) | – | cohort | archived |
| `conversionRate` | `converted` | `leads` (0 when 0) | cohort | archived |
| `conversionsInRange` | leads with `convertedAt` in range | – | activity (`convertedAt`) | archived |
| `followUpsDue` | open leads (not REGISTERED/LOST) with `nextFollowUpAt` before the end of today (Dubai) | – | point in time | archived |
| funnel `value` | non-lost cohort leads whose current status is this stage or later | – | cohort | archived, LOST (reported as `lost`) |
| funnel `conversionFromPrevious` / `FromTop` | stage value | previous / first stage value (0 when 0) | cohort | – |
| `students.total`, `byStatus` | students | – | point in time | archived students |
| `students.withActiveEnrollments` | **distinct** students with ≥ 1 non-WITHDRAWN enrollment | – | point in time | archived students |
| `students.fromLeadConversion` | students created by converting a lead (any enrollment state) | – | point in time | archived |
| `enrollments.byStatus`, `total`, `active` | enrollment records (`active` = not WITHDRAWN) | – | point in time | none (enrollments have no archive) |
| `enrolledInRange` / `completedInRange` / `withdrawnInRange` | enrollments with `enrolledAt` / `completedAt` / `withdrawnAt` in range | – | activity | – |
| `courses.fillRate` | seat-holding enrollments in courses with a seat limit | their seats (0 when 0) | point in time | archived courses, unlimited courses |
| `popularCourses` | enrollments created in range per course (top 10) | – | `enrolledAt` | – (archived courses flagged) |
| campaign `budget` / `spent` | whole AED, lifetime, entered by Marketing | – | lifetime | archived campaigns |
| platform `costPerLead` / `costPerConversion` | lifetime `spent` | lifetime attributed leads / conversions (null when 0) | lifetime | archived campaigns and leads |
| platform `leadsInRange` | attributed leads created in range | – | cohort | archived |

"Converted" (a lead became a student) and "enrolled" (an Enrollment record exists) are separate metrics; a converted
student without an enrollment is not counted as enrolled. Archived leads, students, courses and campaigns are
excluded everywhere. Lead metrics use the **current** status (no status history is stored), so the funnel shows how
far leads have progressed, not historical stage transitions. Responses combine several queries and are not a
single point-in-time snapshot.

**Not available** (no data source): revenue and payments (Sales and Revenue reports), ROAS, impressions, clicks,
visitors, call/response-time metrics, activity feed, tasks, targets.

## Money

One currency for the whole academy: **AED** (UAE dirham), matching the frontend formatter. Amounts are
**whole dirhams stored as integers** (no fils): course and diploma prices, the enrollment price snapshot, lead
budgets. Responses carry `currency: "AED"` next to prices. The currency is a code constant
(`src/config/money.ts`), not an environment variable, because changing it would reinterpret stored amounts.
Payments are not implemented yet.

## Authentication in short

- **Access token**: JWT (HS256, 15 min), returned in the JSON body. Send as `Authorization: Bearer <token>`.
- **Refresh token**: random 256-bit value in the `crm_refresh` cookie (`HttpOnly`, `Secure` in production,
  `SameSite`, `Path=/api/v1/auth`). Stored only as a SHA-256 hash. Every refresh rotates it; replaying an
  already-used token revokes that whole login.
- Every request re-reads the user's status, role and token version from MongoDB, so suspending a user,
  changing their role, changing a password or "log out everywhere" applies on the next request.
- Passwords: bcrypt (cost 12 by default), policy 10+ characters with a letter and a digit, max 72 bytes.
- Reset and invitation links: single-use, stored hashed, 30 min / 72 h, older links die when a new one is sent.
- Rate limits: login (failed attempts per IP + email), forgot-password (per IP + email), reset/change password (per IP).

## Email

`MAIL_TRANSPORT=outbox` (development) writes each email as a JSON file into `.outbox/`; open it to click
the reset/invite link. `MAIL_TRANSPORT=smtp` sends through `SMTP_*` and is required in production.
Logs record only which template was sent, never the body or the link.

## Connecting the frontend

The React app (`Higher-Innovation-Academy-CRM`) is integrated with this API for auth, users, leads,
pipeline, conversion, courses, students, enrollments, trainers, assignments, diplomas, campaigns,
dashboard and reports (see its README for what remains mock). The mapping it implements:

| Frontend today | API |
|---|---|
| `http` returns `response.data` | Bodies are wrapped: read `response.data.data` (and `.meta` for lists) |
| `AuthSession.token` | `data.accessToken` from login / refresh / change-password |
| `localStorage` session | Keep the access token in memory; on load, call `POST /auth/refresh` to restore the session from the cookie |
| `withCredentials: true` | Required (already set) so the refresh cookie is sent |
| 401 handling | On `code: "TOKEN_EXPIRED"` call `/auth/refresh` once and retry; other 401 codes mean sign in again |
| `User.name`, `role`, `joinedAt` | `name`, `role` (key, e.g. `SALES`) + `roleName`, `createdAt` |
| `UserStatus` `'Active'` … | `ACTIVE`, `INVITED`, `SUSPENDED`, `INACTIVE` |
| `/reset-password?token=` page | Used for both password reset and invitation links |

Leads (`types/leads.ts`, `types/pipeline.ts`):

| Frontend | API |
|---|---|
| `Paginated { rows, total, page, pageSize, totalPages }` | `data` + `meta { page, limit, total, totalPages }`; send `limit` instead of `pageSize` |
| `LeadStatus` / `PipelineStage` (`'Payment Pending'`, `'Meeting Scheduled'`, …) | `PAYMENT_PENDING`, `MEETING_SCHEDULED`, … (one list for both screens) |
| `LeadSourceName` (`'Facebook Ads'`, …) | `FACEBOOK_ADS`, `INSTAGRAM_ADS`, `GOOGLE_ADS`, `LANDING_PAGE`, `WEBSITE`, `REFERRAL`, `ORGANIC` |
| `LeadPriority`, `LeadTag` (`'Hot Lead'`, …) | `LOW…URGENT`; `HOT`, `COLD`, `VIP`, `URGENT`, `RETURNING` |
| `assigneeId` / `assignee` | `assignedTo: { id, name, email } \| null` |
| `LeadFilters.status[]`, `sources[]`, `assigneeIds[]`, `countries[]`, `from`, `to` | `status`, `source`, `assignedTo`, `country` (repeat or comma-separate), `createdFrom`, `createdTo` |
| `sortBy: 'assignee'` | Not supported (sort by `createdAt`, `updatedAt`, `fullName`, `status`, `country`, `nextFollowUpAt`) |
| `campaignId`, `campaign` (+ `campaignIds` filter) | `campaignId` on create (callers with `campaigns:read`); response `campaign: { id, code, name, archived }`; filter `campaign=<ids>` or `campaign=none` |
| `courseId` (interested course) | Still not stored (D18) |
| `LeadNote` | `GET/POST /leads/:id/notes`; `author: { id, name, email }` |
| Timeline / activities / follow-ups / communications / documents | Not yet (later blueprint models); `nextFollowUpAt` covers the next follow-up date |
| `pipelineService.convertToStudent(id)` (Convert button) | `POST /leads/:id/convert` with an empty body; read `data.student` and `data.lead` |
| Lead `status: 'Registered'` after converting | `status: REGISTERED`, plus `convertedStudent: { id, studentNumber }` and `convertedAt` |

Courses, students, enrollments (`types/academy.ts`, `types/academic.ts`):

| Frontend | API |
|---|---|
| `AcademyCourse.code, name, description, duration, hours, price, seats, startDate` | Same names. `price` is a whole amount; `seats: null` = unlimited |
| `CourseStatus` (`'Active'`, `'Upcoming'`, `'Archived'`), `AcademicCourseStatus` adds `'Draft'` | `status`: `ACTIVE`, `UPCOMING`, `DRAFT`, plus `archived: boolean` |
| `level` (`'Intermediate'`, `'All levels'`, …) | `FOUNDATION, BEGINNER, INTERMEDIATE, ADVANCED, PROFESSIONAL, ALL_LEVELS` |
| `studentsCount` (course views) | `enrolledCount` (+ `seatsAvailable`, `enrollable`) |
| `categoryId`, `instructorId`, `curriculum`, `requirements`, `rating`, `imageUrl` | Not stored yet (no Category model in the blueprint; trainers arrive in Phase 6) |
| `Student.fullName, email, phone, country, city, profession, dateOfBirth` | Same; `dateOfBirth` is `YYYY-MM-DD`; plus `studentNumber` (`ST-1001`) |
| `StudentStatus` (`'Active'`, `'Pending'`, `'Graduated'`, `'Inactive'`) | `ACTIVE, PENDING, GRADUATED, INACTIVE` |
| `Student.advisorId` | `advisor: { id, name, email }` or `null` (set via `PATCH /students/:id/advisor`) |
| `Student.courseId` / `diplomaId` (one course per student) | A student has many enrollments: `GET /enrollments?student=<id>`; diplomas not yet |
| `Student.paymentStatus, progress, attendanceRate, feeTotal, feePaid, certificateId` | Not yet (payments, attendance, certificates are later phases) |
| `StudentFilters.courseIds, countries, statuses` | `course`, `country`, `status` |
| `Enrollment.studentId, courseId, employeeId, enrollmentDate, amount` | `student {id, studentNumber, fullName}`, `course {id, code, name}`, `enrolledBy`, `enrolledAt`, `price` |
| `EnrollmentStatus` / `LearningStatus` (`'Not Started'`, …, `'Withdrawn'`) | `NOT_STARTED, IN_PROGRESS, COMPLETED, WITHDRAWN` (`'Graduated'` is a student status here) |
| `Enrollment.paymentStatus` | Not yet (Payments phase) |

Trainers, assignments, diplomas (`types/academic.ts`, `types/academy.ts`):

| Frontend | API |
|---|---|
| `Trainer.code, fullName, title, specialization, email, phone, bio, experienceYears, weeklyCapacityHours, joinDate, city, country` | Same names; `code` server-generated (`TR-1001`); `joinDate` is `YYYY-MM-DD` |
| `TrainerStatus` (`'Active'`, `'On Leave'`, `'Inactive'`) | `ACTIVE`, `ON_LEAVE`, `INACTIVE` |
| `Trainer.rating`, `TrainerView.workload`, `studentsCount`, `teachingHours` | Not stored / not computed (reviews and workload are later features); `openAssignments` ≈ `coursesCount` |
| `TrainerFilters.statuses, specializations, courseIds` | `status`, `specialization`, `course` (`diplomaIds`, `workloads` not supported) |
| `TrainerAssignment.trainerId, courseId, role, startDate, endDate, teachingHours, status` | `trainer {id, code, fullName}`, `course {id, code, name}`, `role: PRIMARY \| ASSISTANT`, dates, `teachingHours`, `status: SCHEDULED \| ACTIVE \| COMPLETED \| CANCELLED`, plus `open`, `endedReason` |
| `assignCourseToTrainer` / `updateAssignment` / `removeCourseFromTrainer` | `POST /trainer-assignments` / `PATCH /trainer-assignments/:id` / `POST /trainer-assignments/:id/end` (no hard delete) |
| `getTrainerStudents(trainerId)` | As the trainer: `GET /students` and `GET /enrollments` (scoped). As a manager: `GET /enrollments?course=<ids of the trainer's open assignments>` |
| `AcademicCourse.primaryTrainerId`, `assistantTrainerIds` | `GET /trainer-assignments?course=<id>&open=true` (role PRIMARY / ASSISTANT) |
| `Diploma.name, level, duration, price, description, courseIds` | Same names; `courseIds` ordered; plus `courses[]` summaries and `currency` |
| `DiplomaStatus` (`'Active'`, `'Upcoming'`, `'Closed'`), `AcademicDiploma` `'Archived'` | `ACTIVE`, `UPCOMING`, `CLOSED`, plus `archived: boolean` |
| `AcademyCourse.diplomaId` | A course can be in several diplomas: `GET /diplomas?course=<id>` |
| `formatCurrency` (`currency: 'AED'`) | `currency: "AED"` on courses, diplomas, enrollments, campaigns |

Campaigns (`types/marketing.ts` `MarketingCampaign`, `types/leads.ts` `Campaign`):

| Frontend | API |
|---|---|
| `name, platform, objective, budget, startDate, endDate, utm` | Same; `platform`: `FACEBOOK_ADS, INSTAGRAM_ADS, GOOGLE_ADS, TIKTOK, LINKEDIN, ORGANIC, REFERRAL, WEBSITE` |
| `CampaignStatus` (`'Draft'…'Completed'`, `'Archived'`) | `DRAFT, SCHEDULED, RUNNING, PAUSED, COMPLETED` + `archived: boolean`; change via `PATCH /campaigns/:id/status` |
| `Campaign.status` (`'Active' \| 'Paused' \| 'Completed'`, leads screen) | `RUNNING` / `PAUSED` / `COMPLETED` |
| `owner` (name), `courseId` | `owner: { id, name, email }` (`ownerId` in requests), `course: { id, code, name }` (`courseId` in requests) |
| `spent` / `spend` | `spent` (whole AED, entered by Marketing) |
| `leads, qualifiedLeads, registeredStudents` | `metrics.leads`, `metrics.qualifiedLeads`, `metrics.registeredStudents` (+ `byStatus`, `lostLeads`, `conversionRate`, `costPerLead`, `budgetUsed`) |
| `impressions, clicks, visitors, revenue, daily, leadQuality, topCountries, topDevices`, `roas, ctr, cpc` | Not available (need ad-platform / payment data) |
| `CampaignQuery.sortBy` `'revenue' \| 'leads' \| 'spent' \| 'roas'` | `name, code, startDate, budget, spent, createdAt` (metric sorting not supported server-side) |

Dashboard and reports (`types/dashboard.ts`, `types/reports.ts`):

| Frontend | API |
|---|---|
| `ReportRange { from, to }` (inclusive yyyy-MM-dd) | `from`, `to` query params (Asia/Dubai); presets are computed client-side |
| `DashboardKpi` total / new / qualified / registered / lost leads, conversion rate | `GET /dashboard/summary` → `sections.leads`: `leads`, `byStatus.NEW`, `qualified`, `converted`, `lost`, `conversionRate`; `delta` via `GET /reports/leads/summary?compare=true` → `change` |
| KPI revenue, today's calls | Not available |
| `LeadTrendPoint`, `LeadReport.perDay/perWeek/perMonth` | `GET /reports/leads/timeseries?interval=day\|week\|month` → `points[{ period, leads, qualified, converted, lost, conversions }]` |
| `LeadSourceSlice`, `LeadReport.sources`, `statusDistribution` | `GET /reports/leads/breakdown?groupBy=source` / `groupBy=status` → `rows[{ label, leads, share }]` |
| `CampaignBar { campaign, leads, registrations }` | `GET /reports/leads/breakdown?groupBy=campaign` → `label`, `leads`, `converted` |
| `LeaderboardRow`, `EmployeeReportRow { assignedLeads, convertedLeads, conversionRate }` | `GET /reports/leads/breakdown?groupBy=assignee` (revenue, response time, tasks, score not available) |
| `OverviewReport.funnel` | `GET /reports/leads/summary` → `funnel.stages[{ stage, value, conversionFromPrevious, conversionFromTop }]` |
| `MarketingReport.platformPerformance`, `spendShare`, `campaignRows` | `GET /reports/campaigns` → `rows` (per platform) + `GET /campaigns` (per campaign metrics); no revenue/ROAS |
| `StudentReport.enrollments`, `popularCourses`, `countryDistribution` | `GET /reports/academy` → `trend[{ period, enrolled, completed }]`, `popularCourses`, `countries` |
| `StudentReport.completionRate`, `graduated` per month | Not available as a series (no graduation timestamp); use `trend.completed` and `students.byStatus.GRADUATED` |
| `CustomReportRequest { groupBy, filters }` | `GET /reports/leads/breakdown` with `groupBy` and filters `source, campaign, assignedTo, country` (no `course` grouping: leads have no course yet, D18; no revenue/spend columns) |
| `SalesReport`, `RevenueReport`, `RevenuePoint`, `ReportInsight`, `ReportAlert` | Not available (need payments / an insights engine) |
| `recentLeads`, `followUps`, `topCampaigns` widgets | Existing endpoints: `GET /leads?sortBy=createdAt&sortDir=desc&limit=5`, `GET /leads?followUpBefore=…`, `GET /campaigns` |
| (none) | `Student.conversion { leadId, leadReference, source, utm, convertedAt, convertedBy }` for converted students |

Role mapping is documented in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#frontend-role-mapping).

## Response format

```jsonc
// success: documents expose `id`, never `_id` or `__v`
{ "success": true, "message": "OK", "data": { "id": "665f…" }, "meta": { "page": 1, "limit": 20, "total": 42, "totalPages": 3 } }
// error
{ "success": false, "message": "Validation failed", "code": "VALIDATION_ERROR",
  "errors": [{ "path": "email", "message": "Invalid email address" }], "requestId": "…" }
```

`requestId` matches the `X-Request-Id` response header and the server log line for that request.

Some successful writes also carry non-blocking **warnings** (only when there is at least one):

```jsonc
{ "success": true, "message": "Lead created", "data": { "id": "665f…" },
  "warnings": [{ "code": "CONTACT_MATCHES_STUDENT", "message": "A student with this email or phone already exists. …",
                 "fields": ["email"], "matches": [{ "id": "665e…", "studentNumber": "ST-1004" }] }] }
```

`CONTACT_MATCHES_STUDENT` (lead create/edit) and `CONTACT_MATCHES_LEAD` (student create/edit, conversion)
report active records of the other type with the same email or phone, limited to records the caller may
read. The write has already succeeded; nothing is merged or linked.

### Contact rules (duplicates, phones)

- Same-type duplicates (active lead vs lead, student vs student; same email **or** same canonical phone) are
  refused with 409 `DUPLICATE_LEAD` / `DUPLICATE_STUDENT` on create, contact edits, conversion and **restore**.
  Owner/Admin may send `allowDuplicate: true` on create, conversion and edits (not restore); other roles get
  403 `FORBIDDEN_FIELD`. All of these are serialised by contact locks, so concurrent requests cannot slip
  duplicates through.
- Phones are compared in canonical form. When the record's country is the UAE, `050 123 4567` is stored for
  comparison as `+971501234567`; with any other or no country, local numbers are never assumed to be Emirati.
  An unreadable UAE number is 400 `VALIDATION_ERROR` on `phone`.
- Details and decisions: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (D37, D53–D57).

## Project layout

```
src/
  config/        validated environment, CORS policy
  database/      Mongoose connection, transactions, index sync, seed logic
  docs/          OpenAPI document (request schemas generated from Zod)
  mail/          Nodemailer transport (SMTP / outbox) and email templates
  middlewares/   request logging, authenticate, authorize, validate, rate limiting, 404, errors
  modules/
    auth/        login, sessions, refresh tokens, password reset
    users/       staff accounts
    roles/       roles + permissions.ts (the permission matrix)
    leads/       leads, notes, lead.access.ts (visibility scopes), leadConversion.service.ts
    courses/     course catalog
    students/    students, student.access.ts (advisor-based visibility)
    enrollments/ student-course enrollments (seat accounting)
    trainers/    trainer profiles
    assignments/ trainer-course assignments, teaching.access.ts (trainer scope)
    diplomas/    diplomas (ordered course lists)
    campaigns/   campaigns, campaign.metrics.ts (derived metrics), campaign.ref.ts
    reports/     report endpoints, shared aggregations (leadReports, academyReports), reportRange (Dubai calendar)
    dashboard/   role-aware dashboard summary
    health/
  routes/        /api/v1 router
  scripts/       seed and index-sync commands
  types/         Express request typing (req.auth)
  utils/         ApiError, response, logger, password, tokens, pagination
tests/           Vitest + Supertest (globalSetup starts the test MongoDB)
```

## Security defaults

- Helmet security headers; `X-Powered-By` removed; `Cache-Control: no-store` on token responses.
- CORS allows only `CORS_ORIGINS`, with credentials. Requests from other origins are rejected with 403,
  which together with `SameSite` cookies blocks cross-site use of the refresh cookie.
- Role, permissions and status always come from the database, never from the token body or the client.
- Responses are built from allow-listed DTOs: password hashes, token hashes and token versions never leave the server.
- Logs redact `Authorization`, cookies and password/token fields; request bodies are never logged.
- Production refuses to start with insecure cookies, the email outbox, or a bcrypt cost below 10.
- Rate limiters use process memory: fine for one instance; use a shared store if you scale out.
