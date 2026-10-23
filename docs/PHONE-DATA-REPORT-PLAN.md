# Historic phone data: read-only duplicate report (plan only)

Status: **plan only — nothing has been queried or changed.** Running the report needs owner approval and
an isolated copy of the data. The migration that may follow is a separate, later decision.

## Why

Since D53, a lead or student whose country is the UAE has its phone canonicalised for comparison:
`050 123 4567` → `+971501234567`. Records written earlier kept the old canonical form (digits only:
`0501234567`). So the same number can exist as `0501234567` on an old record and `+971501234567` on a new
one, and the duplicate rule (same type, active, same email **or** same canonical phone) does not see them
as the same. The report finds those cases so a person can decide what to do; it changes nothing.

## Where and how it runs (read-only guarantees)

1. **Never against production.** Run against a **restored copy** of a production snapshot in an isolated
   environment (the staging project, a database named like `academy_report_<date>`), or against staging
   data. The report script refuses to start unless `DEPLOY_ENV=staging` and the database name contains
   `staging` or `report` (same isolation rules and production-host fingerprints as staging).
2. A dedicated database user with the built-in **`read`** role on that one database only.
3. The script contains no write operations (only `find`/aggregate with projections), uses
   `readPreference=secondaryPreferred`, and opens the connection with the read-only user. A code review of
   the script is part of the approval.
4. Canonical values are computed **in the script** with the API's own `normalizePhone(phone, country)`,
   so the report uses exactly the rules the API enforces.

## What it reads

Active (non-archived) leads and students: `_id`, `reference`/`studentNumber`, `country`, `phone` (as
typed), `phoneNormalized` (stored), `email`, `fullName`, `createdAt`. Archived records are counted
separately (they matter for D54 restore conflicts later), not grouped.

## Record classification

For each record compute `candidate = normalizePhone(phone, country)`:

| Class | Rule | Meaning |
|---|---|---|
| `UNCHANGED` | `candidate == phoneNormalized` | already canonical; nothing to do |
| `UAE_LEGACY_LOCAL` | country is UAE, stored value starts with a single `0`, candidate `+971…` | would change if migrated |
| `UAE_INVALID` | country is UAE and `normalizePhone` throws (unreadable number) | needs a manual phone fix |
| `AMBIGUOUS_COUNTRY` | country empty/unknown and stored value looks like a UAE local number (`^0[2-9]\d{7,8}$`, e.g. `05…`) | might be Emirati; **never** changed automatically |
| `OTHER_COUNTRY` | any other country | out of scope (no reinterpretation) |
| `NO_PHONE` | no phone | out of scope |

## Grouping into potential duplicates (same type only)

Group active records of the **same type** by their **candidate** value. A group is reported only if it has
2+ records **and** at least one record's stored value differs from its candidate (i.e. the match is only
visible after canonicalisation; groups that already match today are already governed by D37).

| Group confidence | Rule | Suggested human decision |
|---|---|---|
| `CONFIRMED_SAME_NUMBER` | every record in the group is UAE-country or was typed with `+971`/`00971` | the number is certainly the same; decide whether it is the same person |
| ↳ `LIKELY_SAME_PERSON` | … and the records also share an email, or the same normalised full name | review for a manual merge decision (archive one, keep history) |
| ↳ `SHARED_NUMBER` | … with different names and emails | probably a family/shared phone: keep both (Owner/Admin may keep duplicates on purpose, D55) |
| `AMBIGUOUS` | the group only exists if an `AMBIGUOUS_COUNTRY` record is assumed to be Emirati | do not migrate; ask the record owner to confirm the country through the UI (the edit then applies D53 and the normal duplicate check) |

Cross-type matches (a lead and a student with the same candidate number) are listed for information
only, matching D56 (warnings, never merges).

## Output and handling

- **Summary (shareable):** counts per class, per group confidence, per entity type; no personal data.
- **Detail (restricted):** one row per record in a reported group: group id, confidence, entity type,
  record reference/number, record id, class, country, **masked** phone (`+97150•••4567`: country code,
  first two digits and last four), whether email/name match within the group. Full names only if the
  reviewer is authorised to see those records. Stored encrypted, access limited to the reviewers, deleted
  after the decision is recorded.
- No real phone numbers or emails in tickets, chat or committed files.

## Human review before any migration

1. Reviewer (Owner/Admin) works through the detail file group by group and records one decision per group:
   `MIGRATE` (update the stored canonical value only), `KEEP_SHARED` (migrate; both records stay — a
   deliberate shared number), `MANUAL_MERGE` (handled in the UI by a person; nothing automatic),
   `FIX_PHONE` (correct the number in the UI), `CONFIRM_COUNTRY` (ambiguous; owner of the record confirms
   in the UI), or `SKIP`.
2. A second person checks a sample of decisions.
3. Decisions are stored as a list of record ids → decision (no contact data).

## Later migration (separate approval, not part of this task)

Only records with an approved `MIGRATE`/`KEEP_SHARED` decision; dry run first (prints counts and record
ids only); backup/snapshot before; one transaction per record that takes the contact lock (D37), updates
only `phoneNormalized` (never the typed `phone`), and stores the previous value for rollback; idempotent
and resumable; re-run the report afterwards to confirm the groups are resolved. Never assumes the UAE for
`AMBIGUOUS_COUNTRY` records.
