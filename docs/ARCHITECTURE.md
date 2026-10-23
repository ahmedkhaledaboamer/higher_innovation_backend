# Architecture & Design Decisions

Source of requirements: `Educational_CRM_Backend_Blueprint_AR.docx`.
This file records how the backend interprets that blueprint, including where it was ambiguous.

**Database:** MongoDB with Mongoose, replacing the blueprint's PostgreSQL + Prisma at the
project owner's request. The sections below describe what that changes.

## Request flow

```
HTTP request
  → requestLogger (request id, access log)
  → helmet → cors → API rate limiter → body/cookie parsers
  → module router  (/api/v1/<module>)
      → [route rate limiter] → authenticate → authorize(permission) → validate(Zod)
      → controller   (reads req, calls service, sends response)
      → service      (business rules, record-level checks, transactions)
      → Mongoose model (MongoDB)
  → notFound / errorHandler (one JSON error shape)
```

Rules:

- **Controllers** contain no business logic: they read the validated request, call one service method and send the response.
- **Services** own business rules, record-level authorization and transactions. They throw `ApiError` for expected failures.
- **Services use Mongoose models directly.** No repository layer until there is a concrete need (blueprint §1).
- **Zod validates requests; Mongoose schemas guard the data.** Zod rejects bad input with field-level
  messages before any query runs and strips unknown fields. Schema rules and unique indexes are the last line of defense.
- **Responses go through DTOs** (`toUserDto`): an allow-list of fields, so secrets cannot leak by accident.
- **No `asyncHandler`.** Express 5 forwards rejected promises from async handlers and middleware to the error handler natively.

## Folder structure

```
src/
  config/        env.ts (validated settings), cors.ts
  database/      mongoose.ts (connect, ping, transactions), setup.ts (index sync, seed logic)
  docs/          openapi.ts (Swagger; request schemas generated from Zod)
  mail/          mailer.ts (SMTP / outbox), templates.ts
  middlewares/   requestLogger, authenticate, authorize, validate, rateLimiter, notFound, errorHandler
  modules/<name>/ <entity>.model.ts / <name>.routes.ts / .controller.ts / .service.ts / .schema.ts
  routes/        index.ts (v1 router: mounts every module)
  scripts/       seed.ts, sync-indexes.ts (CLI entry points)
  types/         express.d.ts (req.auth)
  utils/         ApiError, response, logger, password, tokens, pagination, schemas
  app.ts         builds the Express app (no listen, so tests can use it)
  server.ts      connects the DB, checks transaction support, listens, graceful shutdown
tests/           Vitest + Supertest against a real in-memory mongod replica set
```

## Authentication

| Piece | Design |
|---|---|
| Access token | JWT, HS256 pinned on verify, 15 min, claims `sub` (user id) and `ver` (user's `tokenVersion`), plus `iss`/`aud`. Sent as `Authorization: Bearer`. |
| Refresh token | 256-bit random value (not a JWT) in the `crm_refresh` cookie: `HttpOnly`, `Secure` (prod), `SameSite` (default `Strict`), `Path=/api/v1/auth`, 7 days. |
| Storage | `refreshtokens` collection: SHA-256 hash, `family` (one per login), expiry (TTL index deletes expired rows), revocation reason. |
| Rotation | Each refresh atomically marks the token `ROTATED` and issues a new one in the same family, inside a transaction. |
| Reuse detection | Presenting a `ROTATED` token, or losing the race for the same token, revokes the whole family. |
| Instant revocation | `authenticate` loads the user on every request and requires `ACTIVE` status and `claims.ver === user.tokenVersion`. Password change/reset, logout-all and suspension increment `tokenVersion`. |
| Passwords | bcrypt (`BCRYPT_ROUNDS`, default 12, prod ≥ 10). Policy: 10+ chars, a letter and a digit, ≤ 72 bytes. Unknown emails still run a bcrypt compare (no timing leak). |
| Reset / invite | `actiontokens` collection: SHA-256 hash, purpose `PASSWORD_RESET` (30 min) or `INVITE` (72 h), single use (atomic `usedAt` claim), older unused tokens deleted on reissue, TTL index. |
| Enumeration | Login returns one `INVALID_CREDENTIALS` for unknown email, wrong password and not-yet-activated invite. Forgot-password always returns 202 and sends in the background. |
| CSRF | Cookie is only used by `/auth/refresh` and `/auth/logout`; `SameSite` plus the CORS origin check (non-allowed origins get 403 before any handler) block cross-site calls. |
| Registration | None. Owner/Admin create INVITED accounts (`POST /users`); the user sets a password through the invite link. The first Owner comes from `npm run db:seed`. |

### Transactions

Used where several documents must change together: creating a user + invite token; reset-password
(consume token, set password, revoke sessions); change-password (set password, revoke sessions, new
session); refresh rotation; suspension (status + session revocation). The server and the seed
command call `assertTransactionSupport()` at startup and refuse to run on a standalone `mongod`.
Emails are sent after the transaction commits, never inside it (the driver may retry a transaction).

## Authorization

Two layers:

1. **Permission check** at the route: `authorize(PERMISSIONS.USERS_CREATE)`. Roles map to permissions in
   [`src/modules/roles/permissions.ts`](../src/modules/roles/permissions.ts), in code, so they cannot be changed through the API.
2. **Record-level check** in the service, where the record is known: staff hierarchy (below), and from
   Phase 3, "Sales sees only leads assigned to them".

### Permission matrix

| Permission | Owner | Admin | Marketing | Sales | HR | Trainer | Viewer |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| users:read | ✓ | ✓ | | | ✓ | | |
| users:create / users:update / users:assign_role | ✓ | ✓ | | | | | |
| roles:read | ✓ | ✓ | | | ✓ | | |
| leads:read_all | ✓ | ✓ | ✓ | | | | ✓ |
| leads:read_assigned / leads:update_assigned | ✓ | ✓ | | ✓ | | | |
| leads:create | ✓ | ✓ | ✓ | ✓ | | | |
| leads:update_all / leads:assign / leads:archive | ✓ | ✓ | | | | | |
| courses:read | ✓ | ✓ | ✓ | ✓ | | ✓ | ✓ |
| courses:write (create / edit / archive) | ✓ | ✓ | | | | | |
| students:read_all | ✓ | ✓ | | | | | ✓ |
| students:read_assigned / students:update_assigned | ✓ | ✓ | | ✓ | | | |
| students:read_teaching ¹ | ✓ | ✓ | | | | ✓ | |
| students:create | ✓ | ✓ | | ✓ | | | |
| students:update_all / students:assign / students:archive | ✓ | ✓ | | | | | |
| enrollments:read | ✓ | ✓ | | ✓ | | ✓ ¹ | ✓ |
| enrollments:write | ✓ | ✓ | | ✓ | | | |
| trainers:read | ✓ | ✓ | | | ✓ | | ✓ |
| trainers:write (profiles, assignments, archive) | ✓ | ✓ | | | | | |
| trainers:read_own | ✓ | ✓ | | | | ✓ | |
| campaigns:read | ✓ | ✓ | ✓ | | | | ✓ |
| campaigns:write (create / edit / status / archive / restore) | ✓ | ✓ | ✓ | | | | |
| reports:read ² | ✓ | ✓ | ✓ | | | | ✓ |

¹ Since Phase 6, trainers read students and enrollments **only of courses with an open assignment** for their
own trainer profile, with reduced fields. Owner/Admin also hold `students:read_teaching` (they hold every
permission), but `students:read_all` takes precedence. Diplomas use `courses:read` / `courses:write`.

² Each report also requires read-all access to the data it aggregates (see Dashboard and reports below), so a
report never shows totals over records its caller could not list. Phase 8 changed no permission.

**Phase 6 permission changes**: added `students:read_teaching` and `trainers:read_own` (TRAINER only, plus
Owner/Admin by "all permissions"); TRAINER also gained `enrollments:read`. No other role changed.
Lead permissions are enforced since Phase 3; course, student and enrollment permissions since Phase 4. Trainer,
campaign and report permissions are defined so the whole matrix can be reviewed; they are enforced as those modules ship.
Enrollment routes require both the enrollment permission and access to the student: you see and change the
enrollments of the students you can see and change.
`leads:update_*` also covers status changes and adding notes. HR and Trainer have no lead access: no
business requirement for it was identified.

### Staff hierarchy

- Nobody can create an Owner or assign the Owner role through the API (seed only).
- Owner manages Admin and every role below; Admin manages roles below Admin only.
- To change a user's role, the actor must outrank both the current role and the new role.
- Nobody can change their own role or status.
- Suspending or deactivating a user revokes all their sessions immediately; a role change applies on their next request.

### Frontend role mapping

The frontend currently has two role lists (`types/index.ts` `UserRole`, and the Settings mock roles).
The API uses the blueprint's seven roles; suggested mapping when the frontend switches to the API:

| Frontend role | API role | Note |
|---|---|---|
| Owner (Settings) | `OWNER` | |
| Administrator / Admin | `ADMIN` | |
| Academic Manager | `ADMIN` | No academic-only role in the blueprint; a dedicated role can be added later as a new key + permission set. |
| Advisor / Sales Manager / Sales Agent | `SALES` | Manager vs agent differs only in lead visibility, which `leads:read_all` could grant later. |
| Marketing Manager / Marketing Executive | `MARKETING` | |
| HR Manager / HR Employee | `HR` | |
| Instructor | `TRAINER` | |
| Finance | `VIEWER` (for now) | Payments are a later phase. |

The API returns `role` as the stable key (`SALES`) plus `roleName` (`Sales`) for display. `GET /roles`
returns `level` and `isSystem`, matching the frontend's `Role` type. Statuses are upper-case
(`ACTIVE`, `INVITED`, `SUSPENDED`, `INACTIVE`) and map one-to-one to the frontend's `UserStatus`.

## Leads (Phase 3)

**Model** (`leads` collection), shaped after the frontend's `Lead` / `PipelineLead` types:
reference (`LD-1001`, from an atomic counter), fullName, email, phone (+ `phoneNormalized`), country, city,
profession, source, utm, status, statusChangedAt, lostReason, priority, tags, budget, assignedTo / assignedAt /
assignedBy, nextFollowUpAt, notesCount, archivedAt / archivedBy, createdBy, timestamps.
Notes live in `leadnotes` (one document per note).

**Visibility** ([`lead.access.ts`](../src/modules/leads/lead.access.ts)): every query is built as
`{ $and: [scope, ...requestConditions] }` where `scope` comes only from the session:

| Caller has | Read scope | Write scope (details, status, notes) |
|---|---|---|
| `leads:read_all` / `leads:update_all` | every lead | every lead |
| `leads:read_assigned` / `leads:update_assigned` (Sales) | `assignedTo = me` | `assignedTo = me` |
| neither | 403 at the route | 403 at the route |

Out-of-scope leads answer 404 (indistinguishable from nonexistent). Writes repeat the scope and
`archivedAt: null` inside the update filter itself, so a lead reassigned or archived between the read and
the write is not modified.

**Rules**

- Create: Sales-created leads are assigned to the creator; others are unassigned unless a `leads:assign`
  holder sends `assignedTo`. Sending `assignedTo` or `allowDuplicate` without the permission is 403
  `FORBIDDEN_FIELD` (explicit, rather than silently ignored, because the caller would otherwise lose the lead).
- Server-controlled fields (reference, notesCount, archive fields, createdBy, statusChangedAt, phoneNormalized)
  are not in any request schema, so Zod strips them. Status, assignment and archiving are not editable
  through `PATCH /leads/:id`.
- Duplicates: email and phone are deliberately **not** unique indexes (people enquire twice; families share
  phones). Creating or editing a lead to match an active lead's email or normalised phone is 409
  `DUPLICATE_LEAD`. Only `leads:update_all` holders can override on create; only they see which lead matched.
- Assignment target: existing, `ACTIVE`, role holding `leads:update_assigned` (Sales, Admin, Owner).
- Status: any of the 8 statuses except `REGISTERED` (set by conversion in Phase 5). A `REGISTERED` lead's
  status is final. `lostReason` only with `LOST`.
- Archive instead of delete; archived leads are excluded from default lists and are read-only.
- Notes: creating a note and incrementing `notesCount` happen in one transaction.
- Queries are built only from Zod-validated values. Express 5's default query parser does not turn
  `?status[$ne]=x` into an object, and such keys are stripped by Zod anyway.

**Indexes**: `reference` (unique); `{archivedAt, assignedTo, createdAt}`, `{archivedAt, status, createdAt}`,
`{archivedAt, createdAt}`, `{archivedAt, source}`; partial indexes on `email`, `phoneNormalized`,
`nextFollowUpAt`; `leadnotes {lead, pinned, createdAt}`. Search uses case-insensitive regexes, which scan;
fine at CRM scale, revisit (e.g. Atlas Search) beyond ~100k leads.

## Courses, students and enrollments (Phase 4)

**Relationship** (blueprint §4, §7): `Student 1 ──< Enrollment >── 1 Course`, with a unique index on
`{ student, course }`, so a student is enrolled in a course at most once. Re-joining after WITHDRAWN changes that
enrollment's status. The frontend's mock data (one `courseId` per student) is a simplification the blueprint
explicitly rejects.

**Courses**: catalog data visible to every `courses:read` role (not scoped: it is not personal data).
`code` is unique forever (upper-cased), `price` a whole amount, `seats` optional. Status `DRAFT / UPCOMING / ACTIVE`
plus archive. Only UPCOMING/ACTIVE, non-archived courses with a free seat accept enrollments.

**Students**: scoped exactly like leads, by `advisor` (frontend `advisorId`). Sales see and change only the students
they advise; students they create are advised by them; only `students:assign` holders choose advisors.
Duplicate email/phone rules as for leads. Archiving requires no active enrollments.

**Enrollments**: visibility and write access follow the student. Status `NOT_STARTED / IN_PROGRESS / COMPLETED /
WITHDRAWN` with no transition rules (academic progression, attendance and payments belong to later phases).
`price` is copied from the course at enrollment time.

**Counters kept in transactions** (both count every status except WITHDRAWN):

| Counter | Changed when | Guard |
|---|---|---|
| `course.enrolledCount` | enroll; leave or enter WITHDRAWN | conditional `$inc` only if `enrolledCount < seats` and the course is open and not archived, so no overbooking even under concurrency |
| `student.activeEnrollments` | same | archive matches only `activeEnrollments: 0`, so archiving cannot race a new enrollment |

The enrollment insert, both counters and the scope check run in one transaction. Concurrency is exercised in the
tests (4 simultaneous requests for 1 seat: exactly 1 succeeds; 2 simultaneous duplicate enrollments: 1 succeeds).

**Course edits**: `seats` cannot drop below `enrolledCount`, and a course with enrolled students cannot return to
DRAFT; both are checked inside the update filter. Price changes never touch existing enrollments.

**Indexes**: courses `code` (unique), `{archivedAt, status, startDate}`, `{archivedAt, createdAt}`;
students `studentNumber` (unique), `{archivedAt, advisor, createdAt}`, `{archivedAt, status, createdAt}`,
`{archivedAt, createdAt}`, partial `email` and `phoneNormalized`; enrollments `{student, course}` (unique),
`{course, status}`, `{status, enrolledAt}`.

Enrollment visibility for advisors is computed as `student in (ids of students they advise)`. Fine for
hundreds or a few thousand students per advisor; denormalise the advisor onto enrollments if that grows.

## Lead → Student conversion (Phase 5)

`POST /leads/:id/convert` ([`leadConversion.service.ts`](../src/modules/leads/leadConversion.service.ts)).

**Permission**: route requires lead edit access (`leads:update_all` or `leads:update_assigned`) **and**
`students:create`; the service applies the lead write scope, so Sales can convert only leads assigned to them
(others answer 404). Effective roles: Owner, Admin, Sales. No role gained permissions.

**Transaction** (requires a replica set; the server already refuses to start without one):

1. Claim the lead: `findOneAndUpdate({ $and: [writeScope, { _id, archivedAt: null, status: { $ne: 'REGISTERED' },
   convertedStudent: null }] }, { status: 'REGISTERED', convertedStudent: <new id>, convertedAt, convertedBy })`.
   No match → abort; the reason (404 / archived / already converted) is determined after the abort.
2. `nextSequence('student')` with the session, so an aborted conversion does not consume a student number.
3. Insert the student with `conversion { lead, leadReference, source, utm, convertedAt, convertedBy }`.

**Exactly once, two independent guards**: (a) the conditional claim: concurrent requests write-conflict on the
lead document, the driver retries the loser, which then no longer matches; (b) the unique partial index on
`student.conversion.lead` (and on `lead.convertedStudent`). Verified by mutation testing: with (a) removed, (b)
alone still yields exactly one student; with both removed, five concurrent requests produced five students.

**Rollback**: any error inside the callback aborts everything: no student, no REGISTERED lead, no consumed
number. Tested by forcing a unique-index violation on the student insert after the lead was claimed.

**Advisor**: the lead's assignee if `ACTIVE` and their role holds `students:update_assigned`; otherwise null.
Never taken from the request.

**Field mapping**: fullName, email, phone, phoneNormalized, country, city, profession from the lead; request
values (optional) override for the student only; `dateOfBirth` and `status` from the request.

**Duplicates**: the Phase 4 student policy (`assertNoDuplicateStudent`, shared with `POST /students`): 409
`DUPLICATE_STUDENT`, match details only for `students:read_all` callers, override only for `students:update_all`.
Known limitation: two *different* leads with the same email converted at the same instant can both pass this
check, because email/phone are intentionally not unique indexes (shared family contacts). Same lead twice is
impossible (see above).

**Protected fields**: `lead.convertedStudent/convertedAt/convertedBy` and `student.conversion` are in no request
schema (Zod strips them), `REGISTERED` is rejected by the status endpoint, and a REGISTERED lead's status is
final. The convert body cannot set advisor, number, creator or attribution.

**No enrollment** is created: the frontend's Convert action sends only the lead id, and the blueprint's
"Enrollment if needed" is left to the existing enrollment endpoint.

## Trainers, assignments, diplomas (Phase 6)

**Trainer vs User**: a separate `trainers` collection. The blueprint models Trainer with an optional `userId`,
the frontend's Trainer is a business profile (title, specialization, capacity, bio), and not every trainer
signs in. Credentials stay on `users`. `trainer.user` (unique when set) must be an existing, non-INACTIVE
TRAINER-role user; the link is what drives a trainer's data access.

**Assignments** (`trainerassignments`): role `PRIMARY / ASSISTANT`, status `SCHEDULED / ACTIVE` (open) or
`COMPLETED / CANCELLED` (final). `isOpen` is stored so partial unique indexes can target open rows:
`{trainer, course}` unique where `isOpen` and `{course}` unique where `isOpen && role = PRIMARY`. Ending keeps
the row (`endedAt`, `endedBy`, `endedReason`); re-assigning creates a new row.

**Counters and races**: `trainer.openAssignments` and `course.openAssignments` change in the same transaction
as the assignment, through conditional updates (trainer not archived and ACTIVE/ON_LEAVE; course not archived).
Archiving a trainer or course writes the same documents and ends open assignments in its transaction, so the
two operations serialise: an assignment can never stay open on an archived trainer or course (tested with
concurrent requests).

**Teaching scope** ([`teaching.access.ts`](../src/modules/assignments/teaching.access.ts)), computed per request:
courses = open assignments of the caller's trainer profile, if the profile is not archived and not INACTIVE.
Students: `_id ∈ distinct(enrollments.student where course ∈ courses)`. Enrollments: `course ∈ courses`, so a
trainer never sees a student's enrollments in other courses. Applied through the same `withScope` AND as
Sales scopes; out-of-scope ids answer 404. `withScope` now only accepts plain filter objects, so forgetting
`await` on an async scope is a compile error.

**Reduced views** for teaching access: `StudentTeachingDto` (id, studentNumber, fullName, email, status) and
`EnrollmentTeachingDto` (no price, currency, enrolledBy). Withdrawn enrollments in their courses stay visible
(the roster history of their own course).

**Diplomas** (`diplomas`): name (unique, case-insensitive collation index), level, duration, price (whole AED),
status `UPCOMING / ACTIVE / CLOSED`, ordered `courses` (max 50, multikey index), archive. Adding a course
requires it to exist and not be archived; courses archived later remain listed with `archived: true`.
No enrollments or charges are created.

**Money** ([`config/money.ts`](../src/config/money.ts)): single currency AED; integers in whole dirhams; a code
constant rather than configuration, because changing it would reinterpret stored amounts.

### Duplicate contacts under concurrency (D37): fixed with contact locks

**Status: fixed** (release-readiness phase). Before, two requests creating or converting *different*
records with the same email/phone at the same instant could both pass the pre-insert duplicate check,
because email and phone are deliberately not unique (families share them).

**Duplicate rule (unchanged):** a record is a duplicate when another **non-archived** record of the same
type (lead vs lead, student vs student) has the same email (trimmed, lowercased by validation) **or** the
same normalised phone (`utils/phone.ts`: digits only, `+` kept, leading `00` becomes `+`; UAE local numbers become `+971…` when the country is the UAE, D53). Response:
409 `DUPLICATE_LEAD` / `DUPLICATE_STUDENT`, with details that name the matching record only to callers who
can see all records. `allowDuplicate` (lead/student managers) still creates the record. Records are never merged.

**Mechanism** ([`database/contactLock.model.ts`](../src/database/contactLock.model.ts)):

1. Collection `contactlocks`, one document per `<entity>:<email|phone>:<sha256 of the normalised value>` (hashed so the collection holds no contact data; same value → same key).
2. Lead create, student create, lead→student conversion, and lead/student updates that change email or
   phone run in one transaction: increment the lock document of each contact value being introduced,
   then run the duplicate check inside the transaction, then write.
3. Two transactions on the same value write the same lock document. MongoDB fails one with a
   WriteConflict (TransientTransactionError); Mongoose's `connection.transaction` re-runs the callback; the
   re-run starts a new snapshot, sees the committed record, and returns 409. A first-time upsert race on a
   lock key (duplicate key on `_id`) is re-run by `withContactTransaction`.
4. `allowDuplicate` still takes the locks (serialised, not blocked).
5. A 409 thrown inside the transaction aborts it: no record and no lock increment persist (tested:
   `writes` counts committed transactions only).
6. Conversion claims the lead **before** taking the contact locks, so simultaneous conversions of the same
   lead still answer `LEAD_ALREADY_CONVERTED`.
7. Reference numbers for lead/student create are drawn **before** the transaction so creates do not
   contend on the counter (gaps were already allowed). Conversion keeps its counter inside its transaction.

**Tests:** `tests/duplicate-contacts.test.ts` (11 cases: simultaneous lead creates, phone formats,
allowDuplicate under concurrency, simultaneous student creates, conversion vs conversion and vs student
create, simultaneous contact changes, rollback/lock bookkeeping). A test hook delays every duplicate-check
query so the requests overlap deterministically; with the lock disabled, 7 of the 11 fail.

**Approved follow-up rules (owner decision, implemented):**

| Rule | Behaviour | Response |
|---|---|---|
| D54 Restore | Restoring an archived lead/student runs lock → same-type duplicate check (excluding itself) → restore in one transaction. A conflict with a non-archived record of the same type is refused; the record stays archived; the aborted lock write is rolled back. No override on restore. | 409 `DUPLICATE_LEAD` / `DUPLICATE_STUDENT`, message "This lead/student cannot be restored: an active … already has this email or phone", `errors[]` as for create (record numbers only for callers who can see all records). Not archived: 409 `LEAD_NOT_ARCHIVED` / `STUDENT_NOT_ARCHIVED`. |
| D53 Phone | `normalizePhone(phone, country)` (`utils/phone.ts`). A leading-`0` local number becomes `+971…` **only** when the record's country is explicitly the UAE (`United Arab Emirates`, `UAE`, `U.A.E.`, `AE`, `The United Arab Emirates`, Arabic name; case, spaces and dots ignored). In that context `971…` and `+971 0…` are also canonicalised; foreign `+`/`00` numbers are kept. An unreadable UAE-context number (no `0`/`971` prefix, national part not 8–9 digits) is rejected. Every other country, or no country, keeps the historic behaviour (digits only, `+`/`00` → `+`). Writes, duplicate checks, contact locks and warnings all use the same value. When only the country changes, the canonical phone is recomputed and checked. Stored data is not reinterpreted (see "Historic phone data"). | 400 `VALIDATION_ERROR`, `errors: [{ path: "phone", message: "Enter a valid UAE number, e.g. 050 123 4567 or +971 50 123 4567" }]` |
| D55 Edit override | `PATCH /leads/:id` and `PATCH /students/:id` accept `allowDuplicate` (default `false`). `true` is allowed only for `leads:update_all` / `students:update_all` holders — Owner and Admin. It skips only the same-type duplicate check for the contact values being introduced; authentication, route permissions, record scope, validation and contact locks all still apply. `allowDuplicate` alone is not an update (400). Each use is logged once through the application logger: `{ event: "duplicate_contact_allowed", entity, action, actorId, recordId }` (ids only; there is no separate audit store). | Other roles sending `true`: 403 `FORBIDDEN_FIELD` (same as on create). Without the flag: 409 as before. |
| D56 Cross-type | After a successful lead create/edit, student create/edit or conversion, active records of the **other** type with the same email or canonical phone are reported as a warning; the write is never refused, merged, linked or changed because of them. Matches are searched only inside the caller's read scope for the other type (Sales: own leads / advised students); callers without read access to the other type get no warning. Archived records are ignored. Conversion excludes the converted lead itself. Edits warn only about contact values that changed. Same-type duplicates remain 409. | Success envelope gains `warnings` (present only when non-empty): `[{ code: "CONTACT_MATCHES_STUDENT" \| "CONTACT_MATCHES_LEAD", message, fields: ["email" \| "phone"], matches: [{ id, studentNumber? \| reference? }] }]` (at most 5 matches). |

**Transactions:** `runInTransaction` now always uses `readConcern: snapshot` and `writeConcern: majority`
(`TRANSACTION_OPTIONS`), so the guarantees do not depend on cluster defaults. The lock relies on
WiredTiger write conflicts inside multi-document transactions (MongoDB 4.0+; the API requires 5.0+ and a
replica set or Atlas); a conflicting transaction is retried by Mongoose/the driver until it can see the
committed write. Majority write concern keeps a committed lock and record from being rolled back on a
primary failover.

**Historic phone data (not migrated):** records written before D53 keep their stored `phoneNormalized`
(e.g. a UAE lead stored as `0501234567`). New UAE writes are stored as `+971501234567`, so an old local
record and a new international one are not detected as duplicates until migrated. Migration plan
(requires owner approval, staging first): (1) read-only report of active leads/students whose country is
UAE and whose `phoneNormalized` starts with a single `0`, with the canonical value each would get and any
same-type collisions it would create; (2) review collisions manually (they are real duplicates or
families); (3) back up; (4) update `phoneNormalized` only (never `phone`) for non-colliding records in
batches, taking the contact locks per record; (5) re-run the report. Until then, search also matches the
local form ("050…" finds "+97150…").

## Campaigns (Phase 7)

**Model** (`campaigns`), reconciled from the blueprint (name, platform, status, budget, start/end, utmSource,
utmMedium, utmCampaign) and the frontend `MarketingCampaign`: code, name, platform (frontend's 8 platforms),
objective, description, course (ref), owner (ref, active user with `campaigns:write`), budget and spent (whole
AED), dates, `utm` block, status, archive. Not stored: impressions, clicks, visitors, revenue, daily series,
breakdowns (they require ad-platform and payment integrations).

**Access**: role-level only (no per-record scope): campaigns are business data, not personal data.
`campaigns:read` (Owner, Admin, Marketing, Viewer), `campaigns:write` (Owner, Admin, Marketing). No permission
definitions changed in Phase 7. The route check runs before any lookup, so other roles get the same 403 for
existing and nonexistent ids.

**Status machine** (`CAMPAIGN_TRANSITIONS`): DRAFT→SCHEDULED|RUNNING; SCHEDULED→RUNNING|DRAFT;
RUNNING→PAUSED|COMPLETED; PAUSED→RUNNING|COMPLETED; COMPLETED final. The update filter includes the status that was
read, so concurrent transitions cannot both apply. The blueprint does not define transitions; this table is the
documented project rule (D38).

**Uniqueness**: `code` unique; `utm.campaign` unique with case-insensitive collation, partial on string values
(campaigns without a UTM campaign never conflict). Names may repeat across periods.

**Attribution** (`lead.campaign`, `campaignAttributedAt`, `campaignAttributedBy`):

| Situation | Rule |
|---|---|
| New lead with `campaignId` | Caller needs `campaigns:read` (else 403 `FORBIDDEN_FIELD`, so Sales cannot probe campaign ids); campaign must exist (400), not be archived (409) and be RUNNING/PAUSED/COMPLETED (409 `CAMPAIGN_NOT_STARTED` for DRAFT/SCHEDULED) |
| Editing a lead | `PATCH /leads/:id` never touches the campaign (field not in the schema) |
| Changing attribution | `PATCH /leads/:id/campaign` (`leads:update_all` + `campaigns:read`: Owner, Admin); same validation for the new campaign; source/utm untouched; archived leads 409 |
| Campaign completed/archived later | Existing attributions kept; references show `archived: true`; no new attributions to archived campaigns |
| Conversion | Snapshot `student.conversion.campaign`; later re-attribution of the lead does not change it |
| Pre-Phase 7 leads/students | No stored field reads as `null` (unattributed); no backfill needed |

The campaign check runs **before** the duplicate check in lead creation, so the Phase 5 duplicate-check-to-insert
window is not widened. (The contact race itself was fixed later; see D37.)

**Metrics** (`campaign.metrics.ts`): one aggregation `$match { campaign ∈ ids, archivedAt: null } → $group
{ campaign, status }` per list page or detail request, using the partial index `{campaign, archivedAt, status}`.
Nothing is persisted, so concurrent lead creation, reassignment, conversion, archiving and re-attribution cannot
make totals drift (tested). `qualifiedLeads` = leads currently QUALIFIED, MEETING_SCHEDULED, PAYMENT_PENDING or
REGISTERED (current status, not history). Metric-based sorting is not offered (it would need the aggregation in the
list query); acceptable at current scale.

**Indexes**: campaigns `code` (unique), `unique_utm_campaign`, `{archivedAt, status, startDate}`,
`{archivedAt, platform}`, `{archivedAt, createdAt}`; leads `{campaign, archivedAt, status}` (partial).

## Dashboard and reports (Phase 8)

**Requirements inventory** (frontend `types/dashboard.ts`, `types/reports.ts`; blueprint §10 "dashboard.service",
§16 "Marketing Reports", Step 10): implemented where an authoritative data source exists; everything depending on
payments, ad platforms, call logs, activity feeds, tasks or targets is reported as unsupported, not invented.

**Endpoints**: `GET /dashboard/summary` (any signed-in user; sections by permission, computed inside the caller's
lead/student/enrollment scopes); `GET /reports/leads/summary|timeseries|breakdown` (`reports:read` + `leads:read_all`);
`GET /reports/campaigns` (`reports:read` + `campaigns:read`); `GET /reports/academy` (`reports:read` +
`students:read_all` + `enrollments:read` + `courses:read`). Reports also apply the caller's lead scope (empty for
read-all roles) as defence in depth. The dashboard accepts only `from`/`to`; no filter can widen a section.

**Calendar**: Asia/Dubai (`config/reporting.ts`), fixed UTC+4 (no DST), a code constant like the currency. MongoDB
buckets with `$dateTrunc` in the same timezone (weeks start Monday); JS generates the same keys to zero-fill.
Range limits: day 92, week 371, month/summary 1830 days.

**Definitions** (single source: `leads/lead.metrics.ts`, reused by campaign metrics):

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

**Consistency**: no persisted counters were added; every number is computed from the source records per request.
A response runs several aggregations in parallel, so under concurrent writes two sections can reflect slightly
different moments (documented, not a snapshot). Within one aggregation the counts are consistent.
`students.withActiveEnrollments` relies on `student.activeEnrollments`, which is maintained in the enrollment
transactions (Phase 4), so it is exact and counts each student once.

**Performance** (100,000 leads, 20,000 students, 30,000 enrollments, 50 courses/campaigns on a local replica set;
mean of 5 runs after warm-up): 30-day lead summary ~12 ms, 365-day ~100 ms, one salesperson's 365 days ~13 ms, daily
series over 90 days ~93 ms, monthly series over 365 days ~214 ms, breakdowns ~85–110 ms, follow-ups due ~9 ms,
platform performance ~197 ms, academy aggregations 1–90 ms. Every range query uses an index (verified with
`explain()`). The first probe found three collection scans / poor plans; partial `$type: date` indexes are not
eligible for date-range queries, so they were replaced:

| Query | Index added in Phase 8 |
|---|---|
| leads converted in range (`archivedAt: null`, `convertedAt` range) | `leads {archivedAt: 1, convertedAt: 1}` |
| follow-ups due (`archivedAt: null`, `nextFollowUpAt <`) | `leads {archivedAt: 1, nextFollowUpAt: 1}` |
| enrollments in range | `enrollments {enrolledAt: 1}`, `{completedAt: 1}`, `{withdrawnAt: 1}` |

No existing index was removed. Platform performance groups all attributed leads (lifetime) and is the first
candidate for optimisation if lead volume grows by an order of magnitude; it loads only non-archived campaigns
(`_id, platform, budget, spent`) into memory, which is small by nature.

## Data model

One collection per entity. Relationships are stored as ObjectId references (`ref`) and loaded with
`populate()` or explicit queries, not embedded, because every entity is listed, filtered and updated on its own.

```
Role 1 ──< User             user.role             → Role                    (Phase 2)
User 1 ──< RefreshToken     refreshtoken.user     → User                    (Phase 2)
User 1 ──< ActionToken      actiontoken.user      → User                    (Phase 2)
User 1 ──< Lead             lead.assignedTo       → User      (optional)    (Phase 3)
Lead 1 ──< LeadNote         leadnote.lead         → Lead                    (Phase 3)
Campaign 1 ──< Lead         lead.campaign         → Campaign  (optional; kept when campaign archived)   (Phase 7)
Campaign >── 0..1 Course    campaign.course       → Course    (optional)    (Phase 7)
Course 1 ──< Lead           lead.interestedCourse → Course    (optional)    (Phase 3)
Lead 1 ── 0..1 Student      student.conversion.lead → Lead (unique when set); lead.convertedStudent → Student (unique when set)   (Phase 5)
Student 1 ──< Enrollment >── 1 Course              unique index (student, course)   (Phase 4)
User 1 ──< Student          student.advisor       → User      (optional)    (Phase 4)
Trainer 1 ──< TrainerAssignment >── 1 Course     unique open (trainer, course); one open PRIMARY per course   (Phase 6)
User 1 ── 0..1 Trainer      trainer.user          → User      (optional, unique when set)   (Phase 6)
Diploma >──< Course         diploma.courses: [ObjectId → Course]   (ordered, many-to-many)   (Phase 6)
```

Enrollment and TrainerAssignment are separate collections, not arrays inside Student or Trainer: they
carry their own data (status, progress, payment, dates) and are queried from both sides.
`Diploma.courses` is a plain array because the link carries no data except order; it matches the
frontend's `Diploma.courseIds[]` and is implemented with the Courses phase.

### What MongoDB does differently, and how the code handles it

| Concern | PostgreSQL would do it | Here |
|---|---|---|
| Foreign keys | The database rejects a reference to a missing row | Services check that referenced documents exist before saving. |
| Deletion rules | Enforced by the database | Services enforce them: in-use Course/Campaign/Trainer/Role are archived, not deleted; owned children are removed in the same transaction. |
| Unique constraints | `UNIQUE` | Unique indexes in the schema; partial indexes for optional unique fields. |
| Multi-document atomicity | Transactions everywhere | Transactions need a replica set (checked at startup). |
| Migrations | Migration files | No schema migrations. Indexes are declared in schemas, auto-built in development, built by `npm run db:indexes` in production. Data reshaping, if ever needed, gets a one-off script in `src/scripts/`. |
| IDs | UUID | ObjectId, exposed as the string `id`. |
| Expiring rows | Cron job | TTL indexes (`expiresAt`) delete expired tokens automatically. |

## Decisions log

| # | Topic | Decision |
|---|---|---|
| D1 | Diploma ↔ Course | Many-to-many via `diploma.courses` (owner decision). Built with the Courses phase. |
| D2 | User ↔ Role | Role 1 ──< User. One role per user. |
| D3 | Role names | Blueprint's 7 roles (owner decision). Mapping to frontend roles above. |
| D4 | Registration | No public registration; invitations by Owner/Admin; first Owner by seed (owner decision). |
| D5 | Refresh tokens | Hashed, rotated, reuse-detected, httpOnly cookie (see Authentication). |
| D6 | Password reset email | Nodemailer: SMTP in production, file outbox in development and tests (owner decision). |
| D7 | Lead `source` vs `campaign` | `source` = enum (channel); `campaign` = optional reference. |
| D8 | Lead course | Optional reference `interestedCourse`. |
| D9 | Lead statuses | Frontend set: New, Contacted, Interested, Qualified, Payment Pending, Registered, Lost. `REGISTERED` set only by conversion. |
| D10 | Trainer access | Trainer-role users link to a Trainer document; record-level checks go through TrainerAssignment. |
| D11 | Lead visibility | Sales: only leads assigned to them (`leads:read_assigned`). Others per the matrix (owner decision). Enforced in Phase 3. |
| D12 | Enrollment duplicates | Unique index (student, course); re-enrollment updates the existing document. |
| D13 | Lead→Student conversion | Implemented in Phase 5: one transaction (conditional lead claim + student insert); partial unique index on `student.conversion.lead` as the database backstop. No automatic enrollment or merge (D29, D31). |
| D14 | Staff accounts | Created as INVITED with no password; the invite link reuses the reset-password endpoint and activates the account. |
| D15 | Permission storage | In code, not the database. Custom roles/permissions would need a `Permission` collection later. |
| D16 | Lead name | Single `fullName` (frontend and landing-page forms), not the blueprint's first/last name. |
| D17 | Lead statuses | Union of the frontend's lead statuses and pipeline stages: adds `MEETING_SCHEDULED` to D9's list. |
| D18 | Lead course / campaign | Campaign reference implemented in Phase 7. The lead's interested-course reference is still not stored (not in any phase scope so far). |
| D19 | Lead deletion | Archive/restore only (`leads:archive`, replacing the unused `leads:delete`). |
| D20 | Out-of-scope leads | 404, not 403, so ids of other salespeople's leads cannot be confirmed. |
| D21 | Follow-ups | One `nextFollowUpAt` field for now; the frontend's follow-up / activity / communication entities are later blueprint models. |
| D22 | Student visibility | Advisor-based, mirroring leads (Sales: only students they advise). Replaces the unscoped `students:read/write` placeholders. |
| D23 | Diplomas | Implemented in Phase 6 (owner decision): `diploma.courses: [Course]`, many-to-many, frontend `courseIds[]`. |
| D24 | Money | Single currency AED, whole dirhams as integers (`config/money.ts`); `currency` returned with prices. Revisit with Payments (minor units, discounts). |
| D25 | Trainer student access | Phase 6: read-only, limited to courses with an open assignment, reduced fields. |
| D26 | Course taxonomy | Category, instructor, curriculum, requirements, rating and image are not stored: not in the blueprint's Course model, or belonging to later phases (trainers). |
| D27 | Enrollment rules | Only seat accounting and "course is open" rules. No progression, attendance or payment rules. Duplicate enrollment is 409; re-join by status change. |
| D28 | Conversion permission | Composed from existing permissions (lead edit scope + `students:create`), no new `leads:convert` permission. |
| D29 | Conversion and enrollment | Conversion never enrolls; the frontend's Convert action has no course selection. |
| D30 | Conversion attribution | Stored on the student (`conversion` block) as a snapshot of the lead's source and UTM, plus the link both ways. |
| D31 | Duplicate on conversion | Same policy as creating a student; no merge and no "link to existing student" option (could be added later). |
| D32 | Trainer entity | Separate `trainers` collection with optional unique link to a TRAINER-role user; no credentials. |
| D33 | Assignment lifecycle | Open (SCHEDULED/ACTIVE) vs final (COMPLETED/CANCELLED); no hard delete; one open per trainer+course; one open PRIMARY per course. |
| D34 | Archive cascade | Archiving a trainer or course ends its open assignments (CANCELLED with reason) in the same transaction; restore does not reopen. Archived courses stay listed in diplomas. |
| D35 | INACTIVE trainers | Keep their assignments but lose teaching access and cannot be newly assigned; ON_LEAVE can be assigned. |
| D36 | Diploma permissions | Reuse `courses:read` / `courses:write` (catalog data). |
| D37 | Duplicate-contact race | Fixed with transactional contact locks (see "Duplicate contacts under concurrency"); duplicate rule unchanged; follow-up rules D53–D56 approved and implemented. |
| D38 | Campaign status machine | Project rule (blueprint silent): DRAFT/SCHEDULED/RUNNING/PAUSED/COMPLETED with the documented transitions; archive separate. |
| D39 | Campaign identifiers | Unique `code` and case-insensitive unique `utm.campaign`; names may repeat. |
| D40 | Attributable campaigns | RUNNING, PAUSED, COMPLETED and not archived; history kept on archive. |
| D41 | Who attributes | On create: `campaigns:read` holders (Owner, Admin, Marketing). Changing later: Owner/Admin. Sales never. |
| D42 | Campaign metrics | Derived per request from leads (no counters); archived leads excluded; ad/revenue metrics not provided. |
| D43 | Spend | `spent` stored as a manual whole-AED figure entered by Marketing (frontend field; no ad integration). |
| D44 | Reporting timezone | Asia/Dubai, fixed UTC+4, inclusive calendar days; code constant. **Pending confirmation by the owner.** |
| D45 | Report access | `reports:read` plus read-all access to the aggregated data; Sales/Trainer use the scoped dashboard only. No permission changes. |
| D46 | Lead metric basis | Cohort by `createdAt` with current status; conversions by `convertedAt`; archived excluded; funnel from current status. |
| D47 | Converted vs enrolled | Separate metrics; "enrolled" requires an Enrollment record; distinct students only. |
| D48 | Campaign money in reports | Lifetime budget/spend; cost ratios over lifetime leads; `leadsInRange` separate; no revenue/ROAS. |
| D49 | Counters | None added; per-request aggregation; multi-query responses are not snapshots. |
| D50 | Unsupported reports | Sales/Revenue reports, insights, alerts, revenue/ROAS/ad metrics, calls/tasks: no data source. |
| D51 | `MONGODB_URI` validation | Exactly one connection string, no whitespace or quotes; errors never echo the value. |
| D52 | MongoDB version | 5.0 or later (reports use `$dateTrunc`); checked at startup next to the replica-set check. |
| D53 | UAE phone canonicalisation | Leading-0 local numbers become +971 only when the country is explicitly the UAE; ambiguous UAE-context numbers 400; no global reinterpretation of stored data. |
| D54 | Restore and duplicates | Restore is refused (409 DUPLICATE_LEAD/DUPLICATE_STUDENT) when an active same-type record has the contact; locked and transactional; no override. |
| D55 | Duplicate override on edit | `allowDuplicate` on PATCH for Owner/Admin only (403 FORBIDDEN_FIELD otherwise); skips only the same-type check; locks still taken; logged with ids. |
| D56 | Cross-type matches | Non-blocking `warnings` in the success envelope, limited to the caller's read scope; never merge or link. |
| D57 | Transaction concerns | All transactions use snapshot reads and majority writes. |
