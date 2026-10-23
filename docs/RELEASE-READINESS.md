# Release readiness and staging preparation

Status: **not production-ready.** Everything below was verified locally (tests, builds, configuration
checks) unless it is explicitly marked *unverified*. No staging or production environment has been
used; nothing was deployed; no production database, Atlas cluster or SMTP server was contacted.

Repositories:

| | Path | Version control |
|---|---|---|
| API | `academy-crm-api` | Git initialised (branch `main`, **no commits**); `.env` ignored, `.env.example` placeholders only (F-03) |
| Frontend | `Higher-Innovation-Academy-CRM` | Git, branch `integration/backend-api`, all integration work uncommitted |

Checkpoints (archives of both projects; the API archives deliberately exclude `.env` and
`.env.example`): `../_checkpoints/20261019-155044/` (before release readiness; verified by a restore drill:
archives intact, frontend tracked diff reproduces byte-for-byte) and `../_checkpoints/20261019-163015/`
(before the D53–D56 phase).

---

## 1. Findings by severity

| ID | Severity | Finding | Status |
|---|---|---|---|
| F-01 | **Critical (release blocker)** | `.env.example` contained a real MongoDB Atlas connection string with user name and password. The same credentials are in `.env` and were also shared earlier in an IDE selection. | Placeholder written to `.env.example`. **Password rotation and Atlas review by the owner still required** (checklist §2). |
| F-02 | **High (release blocker)** | `MONGODB_URI` in `.env` (and formerly `.env.example`) holds **two** connection strings pasted together (`mongodb+srv://…?retryWrites=…mongodb://127.0.0.1…`). The old validator only checked the prefix, so this reached the driver. | Validator now requires exactly one connection string, no whitespace/quotes, and never echoes the value (D51). The current `.env` is **rejected at startup** until the owner keeps one of the two. `.env` was not edited. |
| F-03 | High | The API folder was not under version control: no history, no review trail, no rollback by revision. | Repository initialised (no commits, nothing pushed); first commit is the owner's decision after F-01. |
| F-04 | Medium | Duplicate-contact race (D37): simultaneous creates/conversions/edits/restores could create unintended duplicates. | **Fixed** with transactional contact locks; approved follow-up rules D53–D56 implemented (restore conflicts, UAE phones, Owner/Admin edit override, cross-type warnings). 44 concurrency/rule tests. |
| F-13 | Medium | Phone data written before D53 is not re-canonicalised: an old UAE record stored as `0501234567` and a new one stored as `+971501234567` are not detected as duplicates. | Accepted until a reviewed migration (plan in ARCHITECTURE.md, "Historic phone data"); search matches both forms meanwhile. |
| F-14 | Low | Lead form re-initialised itself when the page reloaded the lead after a failed save, wiping the user's input and the error. | Fixed (form resets only when opened or switched to another lead). |
| F-16 | **Critical (part of F-01)** | The real Atlas password and cluster host also occur in the development assistant's local session log (from the IDE selection shared earlier) and were therefore sent with the conversation. A pattern-based secret scan missed them; an exact-value scan (counts only) found them. | Rotation (F-01) is mandatory. No other copy found by exact-value scan in project files, builds, Git history, checkpoints or scratch files; editor local history not scanned (owner check, docs/STAGING.md §1.5). |
| F-17 | High | Nothing stopped a staging deployment from being pointed at the production database. | Fixed in code: `DEPLOY_ENV=staging` requires production mode, a `*staging*` database name and production-host fingerprints, and refuses a matching host; `connectDatabase()` stays blocked until `STAGING_CONNECTIVITY_APPROVED=true`; offline `npm run preflight:staging` (docs/STAGING.md). |
| F-18 | High | Staging-isolation review (before connectivity approval) found bypasses: Atlas shard host names, trailing-dot and percent-encoded host spellings, and `@` in options escaped the host check; `connectDatabase(uri)` only checked the configured URI; `NODE_ENV=production` without `DEPLOY_ENV` skipped all isolation; contradictory flags were ignored; `*staging*` substring match; IP hosts and disabled TLS validation unchecked; connection errors could carry nested causes. | Fixed in code with offline tests (`tests/staging-isolation.test.ts`): normalised host parsing that fails closed; parent-domain fingerprint matching; `DEPLOY_ENV` mandatory in production mode and consistent with `NODE_ENV`; production must match the fingerprints; tests only reach loopback hosts; `connectDatabase` re-validates the actual URI, checks the hosts the cluster reports after connecting, and sanitises errors; static test that no other code opens a connection. Remaining: DNS/SRV can only be verified after connecting (post-connect check covers it); Atlas Private Endpoint/peering names not covered by the domain fingerprint must be added explicitly. |
| F-19 | High | Final offline isolation review: (a) Mongoose's automatic model initialisation (`autoCreate`, default on, and `autoIndex`) and the replay of queued queries ran on connection open, **before** the post-connect host check; reproduced locally (collections created on a refused target). (b) Staging relied on a production deny-list being complete. (c) Numeric IPv4 spellings, non-ASCII names, empty labels and socket paths were not canonicalised. (d) Tests: "loopback" was accepted without checking the database name or what the server reports (port-forward), direct test connections were unchecked, and the E2E drop guard accepted `localhost:pw@remote` and a remote second seed. | Fixed: probe-first verification, application connection opened with automatic operations held and released only after re-verification, topology watch (`src/database/mongoose.ts`); staging allow-list `STAGING_DB_HOST_SHA256` (3-label minimum for parents); canonical host parsing cross-checked against the driver's own parser at the boundary, with a 5,000-case differential test; test mode requires loopback hosts, a `test`/`e2e` database and loopback members; `tests/helpers/localDatabase.ts`; E2E URI parser and a guarded drop that checks the server's own member list. Remaining: name-based checks cannot see a DNS alias to a production mongos; the backstop is project-scoped Atlas credentials. |
| F-20 | High | Go/no-go review B1: a staging allow-list entry for any 3+-label domain authorised every host beneath it, so a broad or shared zone could admit unrelated hosts. Review A2: the docs claimed the topology watch closes the connection before a new server is used. | Fixed: allow-list fingerprints match exact canonical connection-string hosts only; reported members and SRV targets must be listed exactly or lie strictly beneath the parent domain of a verified seed with at least three labels (driver's SRV rule, stricter); unverified seeds extend no trust; the deny-list is checked first and only blocks. `docs/STAGING.md` now states the topology watch is best effort. Regression tests in `tests/staging-isolation.test.ts`. |
| F-21 | High | Local review R1: the member-domain allowance was derived from every verified seed, including plain `mongodb://` seeds, which the driver's SRV parent-domain rule does not cover; a seed in a shared hosting zone admitted other tenants' hosts. R7: the missing `STAGING_DB_HOST_SHA256` error still mentioned cluster-domain fingerprints. | Fixed: only the exactly verified SRV name of a `mongodb+srv://` string (single host, at least four labels) extends to its parent domain; for `mongodb://` every reported member, and every server added later, must be listed exactly; the error now describes exact host fingerprints. Regression tests in `tests/staging-isolation.test.ts`. |
| F-15 | Low | Lists swap their rows for a loading skeleton on every refetch, so an open row menu closes if a debounced search answers. | Open (UX only); E2E waits for the search response. |
| F-05 | Medium | Frontend ships `react-router-dom@6.30.6`, affected by two moderate advisories (open redirect via backslash paths; SSR hydration). Fix needs React Router 7 (major upgrade). | SSR advisory not applicable (client-only SPA). Open-redirect exposure reviewed: the only dynamic redirect (post-login `from`) now accepts only same-app paths. Upgrade to v7 needs approval. |
| F-06 | Medium | API `.gitignore` ignored `.env`, `.env.test`, `.env.*.local` but **not** `.env.production`, `.env.staging`, `.env.local`. | Fixed: `.env`, `.env.*`, `!.env.example` (verified in a scratch repository). |
| F-07 | Medium | `TRUST_PROXY` defaults to 0. Behind a load balancer every client shares the proxy's IP, so rate limits (incl. login brute-force limits) would apply to all users together and logs would show the proxy IP. | Configuration item for staging (§5). |
| F-08 | Low | No startup check for the MongoDB version although reports use `$dateTrunc` (5.0+). | Fixed: startup refuses MongoDB < 5.0 (D52). |
| F-09 | Low | Frontend type-check reported 203 errors; `vite build` does not type-check, so builds passed regardless. | Fixed: `tsc --noEmit` exits 0 with unchanged strict settings and no suppressions (§4). |
| F-10 | Low | 15 advisories in frontend **development** tooling (Vite dev server, ESLint/TypeScript-ESLint, Tailwind build chain). Not shipped to users; relevant to developer machines (e.g. Vite dev-server path traversal). | Open; all fixes are major upgrades. Do not expose the Vite dev server on a network. |
| F-11 | Low | If the API cannot connect at boot, the driver error is logged. Driver messages can contain host names (not passwords). | Accepted; config validation errors never include values (tested). |
| F-12 | Info | Two duplicate Arabic translation keys had different values; the later one silently won (e.g. "Enrolled" shown as "enrolled since" on count labels). | Fixed; identical duplicates removed. |

---

## 2. Credential remediation checklist (owner)

Values were never printed, copied into reports, or included in the checkpoint archives.

- [ ] **Rotate the MongoDB Atlas database user password** used in `MONGODB_URI` (F-01). Treat the old password as compromised: it was in `.env.example` (a file normally committed) and in an IDE selection shared during development.
- [ ] In Atlas: review *Database Access* (remove unused users), *Network Access* (no `0.0.0.0/0` unless required), and the project's access/activity logs for unexpected connections.
- [ ] Fix `.env`: keep exactly **one** connection string in `MONGODB_URI` (F-02). For local development use the local replica set; Atlas only for environments that need it.
- [ ] Rotate `JWT_ACCESS_SECRET` in any environment that used a value shared with others. Rotating it invalidates every current access token; the API answers `INVALID_TOKEN` (not `TOKEN_EXPIRED`), so the frontend ends those sessions and users sign in again once.
- [ ] Store staging/production secrets in the platform's secret store (not in files on disk, not in the repo, not in frontend `VITE_*` variables).
- [ ] Git history cleanup: **not needed today** — the frontend repository's full history (all refs) contains no connection strings or credentials (checked), and the API has no repository. If the API folder was ever copied into another repository, check that repository's history too.
- [ ] Before `git init` of the API: confirm `git status` lists `.env.example` but not `.env`.

---

## 3. Security review: evidence

"Tested" = an automated test asserts it. "Config" = enforced by configuration validation (tested in
`tests/env.test.ts`). "Code review" = reviewed, no dedicated test. "Unverified" = needs a live environment.

| Area | Property | Evidence |
|---|---|---|
| Access tokens | Short-lived JWT (default 15 min, max 60), algorithm pinned to HS256, issuer/audience checked; forged, malformed and expired tokens rejected; suspended/deleted users rejected immediately | Tested (`auth.test.ts`) |
| Refresh tokens | Opaque, stored hashed, rotated on every use; reuse of a rotated token revokes the whole family; concurrent refresh with one token succeeds once | Tested (`auth.test.ts`) |
| Logout | Logout revokes the session and clears the cookie; logout-all ends every session including existing access tokens (tokenVersion) | Tested |
| Frontend session | Access token only in memory; refresh cookie httpOnly; single refresh shared across parallel requests and tabs; expiry triggers exactly one refresh | Tested (E2E `auth.spec.ts`) |
| Password reset | No account enumeration; token stored hashed; single use; expires (30 min default); newer link invalidates older; ends sessions; cannot reactivate suspended accounts | Tested (`password-reset.test.ts`) |
| Invitations | Single use; expire after `INVITE_TTL_HOURS` | Tested (`security-evidence.test.ts`, new) |
| Brute force | Per-account login rate limit; global API rate limit headers | Tested (`auth.test.ts`, `app.test.ts`) |
| CORS | Only configured origins, with credentials; others 403 | Tested (`app.test.ts`) |
| Cookies | httpOnly, `SameSite=Strict`, path `/api/v1/auth`; `Secure` required in production; `SameSite=None` refused without `Secure` | Tested + Config |
| Headers | Helmet defaults, framework header removed | Tested (`app.test.ts`) |
| Proxy trust | `TRUST_PROXY` hop count (default 0) | Code review; must be set for staging (F-07) |
| Errors | Unexpected errors are 500 `Internal server error` in production, no message/stack | Tested (`security-evidence.test.ts`, new) |
| Validation | Every route validates params/query/body with Zod; unknown fields stripped; malformed JSON 400; oversized bodies 413 | Tested (`middleware.test.ts`, `app.test.ts`) |
| Mass assignment | Server-managed fields (owner, advisor, status, studentNumber, conversion, passwordHash, role…) ignored or refused | Tested (users, leads, conversion, academy tests) |
| Object-level access | Sales: own leads/advised students only, 404 outside scope, filters cannot widen scope; Trainer: taught courses only, reduced fields, no writes; role hierarchy for user management | Tested (`leads-access`, `academy-access`, `trainer-access`, `users` tests) and E2E role matrix (all 7 roles, UI + API) |
| Reports | Routes need `reports:read` + read-all data access; dashboard sections per permission and scope; query parameters cannot widen a section; archived records excluded; day boundaries in Asia/Dubai | Tested (`dashboard.test.ts`, `reports.test.ts`, E2E `reports.spec.ts`) |
| Logging | Authorization header, cookies, Set-Cookie, passwords and tokens redacted | Tested (`security-evidence.test.ts`, new) |
| Secrets in bundle | Frontend bundle contains no connection strings, JWTs, secrets or test credentials | Checked (scan of `dist/`) |
| Config secrets | `MONGODB_URI` and other config errors never print values | Tested (`env.test.ts`) |
| Dependencies | API: 0 vulnerabilities (all and production-only). Frontend: 2 moderate in shipped code (F-05), 15 in dev tooling (F-10) | `npm audit` |
| Database privileges | Least-privilege DB user (readWrite on the app database only; no admin roles) | **Unverified** (live Atlas) |
| Backups | Point-in-time restore / snapshot schedule and a tested restore | **Unverified** |
| Deployment secrets | Secret store, rotation, access control | **Unverified** |

---

## 4. TypeScript and build audit

| | Before | After |
|---|---|---|
| Frontend `npx tsc --noEmit` | exit 2, 203 errors | **exit 0** |
| API `npx tsc --noEmit` | exit 0 | exit 0 |

Compiler settings unchanged (`strict`, `noUnusedLocals`, `noUnusedParameters` on). No `@ts-ignore`,
`@ts-expect-error`, `@ts-nocheck` or `any` added. `vite build` strips types without checking them, so the
build passing never proved type safety; `npm run typecheck` is now a usable gate.

What the 203 errors were and how they were resolved:

| Count | Error | Category | Resolution |
|---|---|---|---|
| 158 | TS6133 unused `React` import | Legacy + integrated (automatic JSX runtime makes the import dead) | Removed the import line/default specifier only where the compiler reported it unused |
| 17 + 16 | TS2749 `BoxIcon` used as a type (+ its unused import) | Shared UI used by integrated screens (`Button`, `Input`, `Widget`, `EmptyState`, `Dropdown`, `Tabs`, …). The props silently degraded to `any` | Typed as `LucideIcon`; no call site needed changes |
| 8 | TS1117 duplicate object keys | Translations; 2 had different values (runtime wording bug) | Resolved per key (F-12) |
| 1 | TS2322 `Card` | Shared UI: DOM drag/animation handlers conflict with framer-motion's | Those four handlers excluded from `CardProps` (none used) |
| 1 | TS2322 `Uploads` | Mock documents module: passed an `icon` prop `Widget` never supported | Prop removed (rendering unchanged) |
| 2 | TS2554 `useApiQuery` | Dead legacy hook, imported nowhere | File deleted |

Remaining TypeScript issues: none. Lint: 0 errors, 52 warnings (unused variables in legacy mock
screens, `react-hooks/exhaustive-deps` in legacy screens, fast-refresh export warnings); none affect
integrated behaviour.

---

## 4a. Contact rules (D37, D53–D56): behaviour and API contract

Full rules and decisions: [ARCHITECTURE.md](ARCHITECTURE.md) ("Duplicate contacts under concurrency").

| Operation | Same-type duplicate (active, same email **or** canonical phone) | Override | Cross-type match |
|---|---|---|---|
| `POST /leads`, `POST /students` | 409 `DUPLICATE_LEAD` / `DUPLICATE_STUDENT` | `allowDuplicate: true` — Owner/Admin only, else 403 `FORBIDDEN_FIELD` | `warnings[]` |
| `PATCH /leads/:id`, `PATCH /students/:id` (contact changed) | 409 | `allowDuplicate: true` — Owner/Admin only (D55), logged with ids | `warnings[]` (changed values only) |
| `POST /leads/:id/convert` | 409 `DUPLICATE_STUDENT` | `allowDuplicate: true` — `students:update_all` (Owner/Admin) | `warnings[]` (other leads; not the converted one) |
| `POST /leads/:id/restore`, `POST /students/:id/restore` | 409 `DUPLICATE_LEAD` / `DUPLICATE_STUDENT`, record stays archived (D54) | none | none |
| Any of the above with a UAE-country record and an unreadable local phone | 400 `VALIDATION_ERROR`, `errors[0].path = "phone"` (D53) | — | — |

Warning shape (success envelope, only when non-empty):
`warnings: [{ code: "CONTACT_MATCHES_STUDENT" | "CONTACT_MATCHES_LEAD", message, fields: ["email"|"phone"], matches: [{ id, studentNumber? | reference? }] }]`
— limited to records the caller may read; callers without read access to the other type get none.

All writes in the table take the contact locks inside one transaction (snapshot reads, majority writes),
so concurrent requests are serialised per contact value; aborted attempts leave no record, no partial
state and no lock increment.

## 4b. Verification results (this phase, local only)

| Command (where) | Exit | Result |
|---|---|---|
| `npx tsc --noEmit` (API) | 0 | no errors |
| `npx vitest run` (API) | 0 | 29 files, **338 tests passed** (incl. 12 D37 + 32 contact-rule tests) |
| `npm run build` (API) | 0 | — |
| `npm audit --omit=dev` (API) | 0 | 0 vulnerabilities |
| `node dist/scripts/sync-indexes.js` + `diffIndexes` (API, throwaway local DB `academy_crm_indexcheck`, dropped afterwards) | 0 | 15 collections, all in sync, MongoDB 8.2.6 |
| `npx tsc --noEmit` (frontend) | 0 | no errors |
| `npx eslint .` (frontend) | 0 | 0 errors, 52 warnings (legacy) |
| `npx vite build` (frontend) | 0 | — |
| `npx playwright test` (frontend, real API + throwaway local DB) | 0 | **37 passed**, incl. 7-role matrix and 4 contact-rule scenarios |
| Secret scans (frontend HEAD, working tree, full history, `dist/`; API files and `dist/`; checkpoints) | — | Only the owner's `.env` contains credentials; other matches are placeholders/test fixtures |

What the tests prove and what they do not:

- **Implemented tests, independently re-run:** concurrency tests delay every duplicate-check query so
  requests overlap deterministically; with the lock disabled, 7/11 D37 tests and 5/6 new race tests fail
  (verified by temporarily disabling `lockContacts`, then restoring the file byte-for-byte).
- **Runtime behaviour verified locally:** single-node replica set (mongodb-memory-server and a local
  `mongod`, both 8.2.6), one API process.
- **Not verified:** multi-node replica sets / Atlas (write-conflict and retry timing under real
  replication latency, failover during a transaction), several API instances behind a load balancer,
  production load. The design relies on documented MongoDB transaction semantics (write conflicts on the
  same document; majority write concern), but this has to be exercised on staging.

## 5. Staging checklist (preparation only — nothing here has been run against staging)

### Platform

- [ ] Node.js **22.12+** (developed and tested on Node 24). Use the same major in staging and production.
- [ ] MongoDB **5.0+** (reports use `$dateTrunc`; startup refuses older), **replica set or Atlas** (transactions; startup refuses a standalone server). Tested on MongoDB 8.2; 7.0+ recommended.
- [ ] A **separate staging database** (never the production cluster) and a database user with `readWrite` on that database only.

### API environment (`NODE_ENV=production`)

| Variable | Staging value / rule |
|---|---|
| `NODE_ENV` | `production` (enables the production checks below) |
| `DEPLOY_ENV` | `staging` (required with `NODE_ENV=production`; see docs/STAGING.md §3) |
| `PRODUCTION_DB_HOST_SHA256` | Production cluster-domain fingerprint (required for staging and production) |
| `STAGING_DB_HOST_SHA256` | Exact fingerprints of the staging connection-string hosts (required for staging; allow-list) |
| `MONGODB_URI` | Exactly one staging connection string, from the secret store |
| `JWT_ACCESS_SECRET` | ≥ 32 random characters, unique to staging (`node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`) |
| `CORS_ORIGINS` | The staging frontend origin(s) only, e.g. `https://crm-staging.example.com` |
| `FRONTEND_URL` | Staging frontend URL (used in reset/invitation links) |
| `COOKIE_SECURE` | `true` (required in production mode; HTTPS everywhere) |
| `COOKIE_SAMESITE` | `strict` when frontend and API are same-site (same domain or subdomains); `none` only if they are on different sites (then `COOKIE_SECURE=true` is enforced) |
| `COOKIE_DOMAIN` | Unset unless the cookie must be shared across subdomains |
| `TRUST_PROXY` | Number of proxies in front of the API (usually `1` behind one load balancer) — F-07 |
| `MAIL_TRANSPORT` | `smtp` (production mode refuses `outbox`) with a **sandbox** SMTP for staging (see below) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | Sandbox credentials from the secret store |
| `BCRYPT_ROUNDS` | ≥ 10 (enforced); default 12 |
| `LOG_LEVEL` | `info` |
| `API_DOCS_ENABLED` | Off by default in production; enable only if staging Swagger is wanted |
| Rate limits, TTLs | Defaults are reasonable (`RATE_LIMIT_MAX=300/15 min`, `AUTH_RATE_LIMIT_MAX=10/15 min`, access 900 s, refresh 7 days, reset 30 min, invite 72 h) |

The API refuses to start with any invalid or unsafe setting and names the variable (never its value).

### Frontend build

- [ ] Build with `VITE_API_URL=https://<staging-api>/api/v1` (or `/api/v1` if a reverse proxy serves the API on the frontend's origin — simplest; no CORS, cookies first-party).
- [ ] No secrets in any `VITE_*` variable (they are public). Re-run the bundle scan on the staging build.
- [ ] Serve over HTTPS with SPA fallback (all unknown paths → `index.html`).

### Database preparation (staging only; do not run against production without approval)

1. Take a snapshot/backup of the staging database (even if empty).
2. `npm run build`, then `npm run db:indexes:prod` — creates collections and indexes for every model, including the new `contactlocks` collection. Production does not build indexes automatically.
3. `npm run db:seed:prod` with `SEED_OWNER_EMAIL`/`SEED_OWNER_PASSWORD` (one-time first Owner; idempotent for roles).
4. Migrations/backfills: **none required** by this release. `contactlocks` starts empty and fills as contacts are written; existing records are not affected. Existing duplicates (if any were created before the fix) remain and are not merged.

### Health, readiness, logs

- [ ] Liveness `GET /api/v1/health` (process up); readiness `GET /api/v1/health/ready` (MongoDB answers). Point the load balancer at readiness.
- [ ] Startup refuses: invalid config, unreachable DB, standalone MongoDB, MongoDB < 5.0.
- [ ] Logs are JSON (pino) with redaction of auth headers, cookies, passwords and tokens. Ship to the log platform; confirm no `Authorization`/`Cookie` values appear (search for `Bearer ` and `crm_refresh=`).

### SMTP test procedure (no real recipients)

1. Use an SMTP sandbox that captures mail (e.g. Mailpit/MailHog in the staging network, or a provider's sandbox inbox). Never point staging at the production mail account.
2. Invite a user from the staging UI; confirm the message arrives in the sandbox with a link to the **staging** `FRONTEND_URL`.
3. Accept the invitation; confirm the link fails a second time.
4. Request a password reset; confirm one message, a working link, and that an older link stops working.
5. Locally, `MAIL_TRANSPORT=outbox` (non-production) writes messages to `.outbox/` instead — that is what the automated tests use.

### Test accounts (one per role)

Create through the UI as the seeded Owner (invite → sandbox email → set password), using an address
domain the team controls or the sandbox: Owner (seeded), Admin, Marketing, Sales ×2 (to check
isolation), HR, Trainer (then link a trainer profile to it), Viewer. Store their passwords in the team
password manager; delete or deactivate them after staging sign-off.

### Smoke tests (staging, after deploy)

The local E2E suite (`npm run test:e2e` in the frontend) automates all of these against a throwaway local
database; repeat them by hand (or point a copy of the suite at staging) with the test accounts:

1. **Authentication**: sign in, reload (session restored), sign out; wrong password shows the API message; cookie is `HttpOnly; Secure; SameSite`; an expired access token is refreshed once.
2. **Lead conversion**: create a lead, assign to Sales A, add a note, attribute to a running campaign, convert; second conversion → "already converted"; Sales B cannot open the lead.
3. **Duplicate contacts**: second lead with the same email → 409; Admin can "Save anyway"; Sales sees no override; restoring an archived lead whose email is now in use → refused, stays archived; a UAE lead typed `050 …` is found when searching `+971 50 …` and duplicates it.
4. **Cross-type warning**: a lead with a student's email is saved and shows a warning; Marketing (no student access) sees no warning.
5. **Enrollment**: one-seat course → enroll → second student cannot take the seat; withdrawing frees it.
6. **Trainer isolation**: link the Trainer account to a profile, assign a course; the trainer sees only that course's students and cannot edit.
7. **Campaign attribution**: start/pause/complete; Draft campaigns refuse attribution; spend update changes cost per lead.
8. **Reporting**: today's lead count on Reports matches the leads created; Sales sees "My new leads" only; Viewer/Marketing see reports; Sales/HR/Trainer do not.
9. **Roles**: each role sees only its screens (role matrix in `e2e/roles.spec.ts`).

---

## 6. Staging runbook (ordered; for the owner/operator — not executed)

Stop at any failed step; nothing here touches production.

**A. Secrets and configuration**
1. Rotate the Atlas database user password (F-01); create a **separate staging database user** with `readWrite` on the staging database only (no `atlasAdmin`, no access to production databases).
2. Fix the local `.env` (F-02) — one connection string. Never copy production values into staging.
3. Generate a new staging `JWT_ACCESS_SECRET` (≥ 32 random characters). Put every secret in the platform secret store; none in files, repos or `VITE_*`.
4. Set the API variables from §5 (`NODE_ENV=production`, `CORS_ORIGINS`, `FRONTEND_URL`, `COOKIE_SECURE=true`, `COOKIE_SAMESITE`, `TRUST_PROXY`, `MAIL_TRANSPORT=smtp` + sandbox SMTP, `BCRYPT_ROUNDS`, `LOG_LEVEL=info`). Start the API once: it must refuse to start on any invalid value and name only the variable.

**B. Atlas / database checks (staging cluster only)**
5. Network access list: only the staging API's egress addresses. TLS is on by default for Atlas.
6. Confirm server version ≥ 5.0 and replica set (the API checks both at boot; startup log "Connected to MongoDB").
7. Backups: enable continuous backup / snapshots; **rehearse a restore** of the staging database into a scratch cluster or database and record how long it took.
8. Take a snapshot immediately before the first deploy.

**C. Indexes and data**
9. `npm run build`, then `npm run db:indexes:prod` against **staging** (creates all 15 collections' indexes, incl. `contactlocks`). Index builds on populated collections can take time; run outside working hours. Rollback: indexes added by this release can be dropped with no data change; the previous API version ignores `contactlocks`.
10. `npm run db:seed:prod` once with `SEED_OWNER_*` (first Owner; roles idempotent).
11. No migrations or backfills in this release. Do **not** run a phone re-canonicalisation (F-13) without the reviewed migration plan.

**D. Edge: HTTPS, proxy, CORS, cookies, rate limits**
12. HTTPS end to end (redirect HTTP → HTTPS; HSTS at the proxy).
13. Reverse proxy forwards `X-Forwarded-For`/`-Proto`; set `TRUST_PROXY` to the number of proxies. Verify: two different client IPs get separate rate-limit counters (`RateLimit-Remaining` header), and the API log shows the client IP, not the proxy's.
14. CORS: a request from an unlisted origin gets 403; the staging frontend origin works with credentials.
15. Cookies: `crm_refresh` is `HttpOnly; Secure; SameSite=Strict` (or `None` only for cross-site setups), `Path=/api/v1/auth`.
16. Rate limits: 11 wrong passwords for one account within the window → 429.

**E. Email**
17. Sandbox SMTP only (§5 SMTP test procedure): invitation and reset emails arrive in the sandbox, links point to staging, links work once.

**F. Application**
18. Load-balancer health check on `GET /api/v1/health/ready`.
19. Run the smoke tests above with the seven test accounts. For the contact-lock behaviour, also send two identical "create lead" requests at the same time (e.g. two browser tabs or a small script) and confirm one 201 and one 409.
20. Check logs for absence of `Bearer `, `crm_refresh=`, passwords and connection strings; confirm `duplicate_contact_allowed` events carry ids only.

**G. Sign-off**
21. Record results, open issues and accepted risks; production is a separate, approved step.

## 6a. Recovery and rollback

| Situation | Action |
|---|---|
| API release fails health/readiness | Keep the previous API build running (blue/green or keep the old instance until the new one is ready); switch traffic back. |
| Problem after traffic switch | Redeploy the previous API build artefact and previous frontend build (both stateless). |
| Database | This release adds the `contactlocks` collection and no schema migrations or backfills; the previous API version runs against the same data unchanged (it ignores `contactlocks`, which can stay or be dropped). Restore from the pre-deploy snapshot only if data was damaged. |
| Contact-lock problems (e.g. unexpected 409s or transaction timeouts under load) | Roll back the API build; data written meanwhile stays valid. Investigate with the `contactlocks` documents (write counters keyed by `entity:kind:sha256(value)`; they contain no email or phone). |
| Configuration | Keep the previous environment/secret versions in the secret store so they can be re-applied. |
| Frontend only | Re-publish the previous `dist/`. Note: the previous frontend ignores `warnings` and offers no "Save anyway" on edits; the API contract is backward compatible. |
| Leaked secret | Rotate immediately (database user, `JWT_ACCESS_SECRET` — signs everyone out once, SMTP credentials); review access logs. |

Prerequisites: build artefacts are versioned and kept; a snapshot is taken before each deploy; a restore
has been rehearsed (step 7).

---

## 6b. Related documents

- [STAGING.md](STAGING.md): credential rotation, Atlas review, least-privilege staging user, local `.env` fix, staging variables, preflight, connectivity gate, go/no-go checklist.
- [PHONE-DATA-REPORT-PLAN.md](PHONE-DATA-REPORT-PLAN.md): read-only analysis plan for historic UAE phone data (not run).
- [staging.env.template](staging.env.template): staging variables, placeholders only.

## 7. Explicitly unverified

- MongoDB **Atlas**: connectivity, TLS, network access list, database-user privileges, backups/point-in-time restore, server version. The current `.env` cannot be used until F-02 is fixed, and Atlas was not contacted.
- **SMTP**: no real or sandbox SMTP server was used; only the local outbox transport.
- **Deployment**: hosting platform, HTTPS/TLS, reverse proxy and `TRUST_PROXY`, secret store, log shipping, monitoring/alerting, autoscaling, CDN/caching headers for the SPA.
- Behaviour under production-like latency and load: contact locks and transaction retries are tested on a single-node replica set with one API process only (see §4b).
- Historic phone data: no migration run; impact unknown until the read-only report in the migration plan is run on staging data.
- Cross-site cookie behaviour in real browsers if frontend and API are deployed on different sites.
