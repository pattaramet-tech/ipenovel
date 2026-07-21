# Daily Check-in Production Fix — Root Cause, Migration Safety, and UI/Nav Bugs

## A. Root cause of the production DB error

### What was checked

- `drizzle/0027_add_daily_checkin_and_coupon_cap.sql` — present, correct SQL
  for `CREATE TABLE dailyCheckins` + `ALTER TABLE coupons ADD
  maxDiscountAmount` + `CREATE INDEX dailyCheckins_userId_idx`.
- `drizzle/meta/_journal.json` — has an entry for `0027_add_daily_checkin_and_coupon_cap`
  (`idx: 27`), correctly following `0026`.
- `drizzle/schema.ts` — has `dailyCheckins` and `coupons.maxDiscountAmount`.
  Re-ran `DATABASE_URL=<placeholder> npx drizzle-kit generate`: **"No schema
  changes, nothing to migrate"** — `schema.ts` and the migration chain are
  in sync. **Migration 0027 is not missing or malformed. The journal and
  schema agree with each other.**
- `package.json` — `"start": "NODE_ENV=production node dist/index.js"`
  (before this fix). **No migration step anywhere in `build` or `start`.**
  `"db:push": "drizzle-kit generate && drizzle-kit migrate"` exists but is a
  manual, developer-invoked command - nothing in this repo ever calls it
  automatically.
- `drizzle.config.ts` — standard config, requires `DATABASE_URL`, nothing
  unusual.
- Deployment/startup config in the repo: searched for `Procfile`,
  `render.yaml`, `Dockerfile`, and any `*manus*` file. Found `.manus/db/`
  (a folder of timestamped `db-query-*.json` files - logs of ad hoc queries
  run through an editor/agent tool, not deployment configuration) and
  `.manus-logs/` (browser console/network/session-replay logs from a prior
  agent session). **Neither is a build/start/release configuration file.**
  There is no evidence in this repository of any automated migration step,
  release-phase command, or pre-deploy hook, for this or any prior phase.

### Conclusion

**The root cause is that this repository's deploy pipeline has never had an
automated migration step.** `pnpm start` boots the compiled server directly
against whatever schema the database already happens to have. Every prior
migration (`0000` through `0026`) reaching production depended on someone
manually running `pnpm db:push` (or equivalent) against production at some
point - this is a pre-existing gap in the deployment process, not something
Phase 5 introduced. Phase 5 is simply the first migration whose absence
became immediately, visibly broken, because `dailyCheckins`/
`coupons.maxDiscountAmount` are queried by `dailyCheckin.getStatus`, which
is called from the Home page on every page load (before this fix moved it
to `/profile`) - so a missing table/column surfaced as a raw error on the
site's front page instead of on a less-visited path.

This is **not**: "migration 0027 has a bug", "the journal is out of sync
with the schema", or "the migration was partially generated". It is: **no
one and nothing ever told production to run it.**

### What this sandbox cannot determine

This sandbox has no `DATABASE_URL` and no network path to the real
production database - **no claim in this document should be read as "the
production database was inspected and found to be in state X."** What
*can* be said: given a deploy pipeline with zero migration execution, the
production schema is almost certainly still at whatever migration was last
applied by a manual `db:push` run, which could be anywhere from "everything
through 0026, nothing of 0027" (most likely, if 0027 was simply never
attempted) to a genuinely partial state (if someone previously ran `pnpm
db:push` against production, which would call `drizzle-kit generate` *and*
`migrate` together - `generate` runs first and is safe/read-only against
schema.ts, but if a `migrate` invocation was interrupted mid-way, e.g. the
process was killed between the `CREATE TABLE` and `ALTER TABLE` statements
of 0027, the table could exist without the column).

**Before applying anything else to production, run this against the real
production database** (read-only, safe to run any time) to determine which
case applies:

```sql
-- 1. Does dailyCheckins exist at all?
SELECT COUNT(*) AS dailyCheckins_table_exists
FROM information_schema.tables
WHERE table_schema = DATABASE() AND table_name = 'dailyCheckins';

-- 2. Does coupons.maxDiscountAmount exist?
SELECT COUNT(*) AS maxDiscountAmount_column_exists
FROM information_schema.columns
WHERE table_schema = DATABASE() AND table_name = 'coupons' AND column_name = 'maxDiscountAmount';

-- 3. Does the userId index on dailyCheckins exist (only meaningful if #1 is 1)?
SELECT COUNT(*) AS userId_index_exists
FROM information_schema.statistics
WHERE table_schema = DATABASE() AND table_name = 'dailyCheckins' AND index_name = 'dailyCheckins_userId_idx';

-- 4. What does drizzle itself think has been applied?
SELECT id, hash, created_at, FROM_UNIXTIME(created_at / 1000) AS applied_at
FROM __drizzle_migrations
ORDER BY created_at DESC
LIMIT 5;
-- (if this table doesn't exist yet, no migration has EVER been recorded as
-- applied by drizzle in this database - it was fully hand-managed before now)
```

Interpreting the results:

| dailyCheckins exists | maxDiscountAmount exists | Meaning | Action |
|---|---|---|---|
| No | No | 0027 never started | The fixed migration runner (below) applies it cleanly in one pass. |
| Yes | No | 0027 partially applied (table created, `ALTER TABLE` never ran - the exact failure mode this task anticipated) | The rewritten, idempotent 0027 (see below) skips the `CREATE TABLE` safely and applies only the missing `ALTER TABLE`/index. |
| Yes | Yes | 0027 already fully applied by some manual process | The rewritten 0027 is a safe no-op (every statement is guarded). |

**No data was deleted or assumed in this document.** If table #1 is "Yes",
any existing `dailyCheckins`/`coupons` rows are left completely untouched -
the repair only ever adds a missing column or index, never drops or
rewrites anything.

## Migration deployment fix

### What changed

1. **`drizzle/0027_add_daily_checkin_and_coupon_cap.sql` was rewritten to be
   idempotent** - `CREATE TABLE IF NOT EXISTS`, and the `ALTER TABLE`/
   `CREATE INDEX` are now wrapped in an `information_schema`-checked
   dynamic-SQL guard (`SET @exists = (SELECT COUNT(*) FROM
   information_schema...); SET @sql = IF(@exists = 0, '<ALTER/CREATE
   INDEX>', 'DO 0'); PREPARE ... FROM @sql; EXECUTE ...; DEALLOCATE
   PREPARE ...`). This was necessary because drizzle's mysql migrator
   (`node_modules/drizzle-orm/mysql-core/dialect.js`) runs every pending
   migration's statements in one fail-fast loop with no per-statement
   error recovery - if 0027 is ever left partially applied, a bare re-run
   would hit `CREATE TABLE` again ("table already exists") on the very
   first statement and never reach the missing `ALTER TABLE`. The rewrite
   makes every statement safe to re-run regardless of which of the three
   states in the table above production is actually in. **The intended end
   schema is unchanged - only how safely it's reached.**
2. **`scripts/migrate.mjs`** (new) - a dedicated, safe migration runner.
   See its file-header comment for full reasoning; summary:
   - Requires `DATABASE_URL` - refuses to run (exit 1) without it, never
     silently no-ops.
   - Runs **only** already-committed migrations via drizzle-orm's
     programmatic `migrate()` (`drizzle-orm/mysql2/migrator`) - never
     `drizzle-kit generate`. No new migration can ever be created by this
     script, by design (item 2 of the task's safety requirements).
   - Uses a MySQL named lock (`GET_LOCK`/`RELEASE_LOCK`, scoped to one
     dedicated non-pooled connection, never a connection pool) so that if
     multiple instances of the app start at the same time, only one
     actually runs the migration statements - the rest wait for the lock,
     then find nothing pending and return immediately. Failure to acquire
     the lock within 60s is a hard failure (exit 1), never a silent skip.
   - Any migration failure is a hard failure (`process.exitCode = 1`,
     never caught-and-ignored) - see `package.json`'s `start` script below
     for why that's what actually stops the deploy.
   - Deliberately does **not** shell out to the `drizzle-kit` CLI:
     `drizzle-kit` is listed under `devDependencies` in `package.json`, not
     `dependencies` - it is not guaranteed to be installed wherever this
     script runs in a production environment (some platforms prune
     devDependencies before running the app). `drizzle-orm` and `mysql2`
     are both regular `dependencies`, so this script only depends on
     packages guaranteed to be present.
3. **`package.json`**:
   - Added `"db:migrate": "node scripts/migrate.mjs"` - a migrate-only
     command, as requested, that never calls `generate`.
   - Changed `"start"` from `"NODE_ENV=production node dist/index.js"` to
     `"node scripts/migrate.mjs && NODE_ENV=production node dist/index.js"`.
     The `&&` is the actual enforcement of "migration failure must stop
     deployment, not open the app with the old schema": if
     `scripts/migrate.mjs` exits non-zero, the shell never runs
     `node dist/index.js` at all - the process manager sees the `start`
     command itself fail, which on virtually every PaaS (including what's
     inferable about Manus's model from this repo: a single `start`
     command boots the app, there's no separate health-check-then-promote
     step visible here) means the deploy is reported as failed rather than
     serving traffic on a broken schema.
   - `db:push` (`drizzle-kit generate && drizzle-kit migrate`) is
     unchanged and still exists for local development schema-diffing -
     it is **not** used by `start` or `db:migrate`, satisfying "ห้ามใช้
     db:push เป็น startup command หากมันยังมี drizzle-kit generate."

### Why not a separate "release command"?

No evidence was found in this repository of Manus supporting a distinct
pre-deploy/release-phase command separate from the app's own start command
(no config file, no documented convention, nothing beyond the single
`start` script). Per the task's explicit instruction not to guess without
checking, this document does **not** assume Manus has such a feature.

**If Manus's dashboard does expose a "pre-deploy"/"release command" setting
external to this repo** (this can only be confirmed by an operator with
Manus dashboard access, not from inside this sandbox), the strictly better
configuration is to set that release command to `pnpm db:migrate` and run
it once, before instances start - that avoids running the lock-acquisition
dance on every instance boot at all. This document's fallback (running
`scripts/migrate.mjs` as part of `start`) is designed to be correct and
safe **either way** - if a release command already handles it, every
instance's own `scripts/migrate.mjs` call at boot will find nothing pending
and return almost immediately (a fast, harmless no-op); if no release
command exists, the `start`-embedded call is what actually protects
production.

### Concurrency: multiple instances starting at once

Evaluated explicitly, per the task's requirement. Two failure modes matter:

1. **Two instances both try to run the same pending migration's DDL at the
   same time.** Solved by the `GET_LOCK` wrapper in `scripts/migrate.mjs` -
   only the lock holder executes DDL; others wait, then see the migration
   is already recorded in `__drizzle_migrations` and skip it.
2. **A repeat deploy re-attempts an already-applied migration.** Drizzle's
   migrator itself already handles this (it checks `__drizzle_migrations`
   before re-running anything) - and the idempotent rewrite of 0027 means
   even in the one scenario where drizzle's own bookkeeping could be wrong
   (a partial prior application that was never recorded because the
   original run threw before reaching the tracking-row insert), a re-run
   converges to the correct schema instead of erroring.

### Rollback plan

Both `dailyCheckins` (new table) and `coupons.maxDiscountAmount` (new
nullable column) are purely additive - nothing was dropped, resized, or
retyped, and no existing row was rewritten. If a rollback is ever needed:
`DROP TABLE dailyCheckins;` and `ALTER TABLE coupons DROP COLUMN
maxDiscountAmount;` - both safe, both lose only data that didn't exist
before Phase 5 (any check-ins already claimed since the fix in this task).
Reverting `scripts/migrate.mjs`/`package.json`'s `start` script (i.e. going
back to booting without a migration step) is a plain code revert with no
data implications either way.

## B. Raw SQL/DB error no longer reaches the client

Root cause: `server/routers.ts`'s `dailyCheckin.getStatus` procedure had no
try/catch around `db.getDailyCheckinStatus(ctx.user.id)` - any thrown error
(a raw MySQL error given the missing table/column, but this would be true
of *any* unexpected DB error, not just this specific incident) propagated
straight through tRPC's default error serialization to
`error.message` on the client, which `DailyCheckinCard.tsx` then
interpolated directly into the visible error text
(`` `โหลดข้อมูลเช็กอินไม่สำเร็จ: ${error.message}` ``).

Fixed in two independent layers:

1. **Server** (`server/routers.ts`): `getStatus` now wraps its DB call in
   try/catch, logs the real error server-side only
   (`console.error("[dailyCheckin.getStatus] failed", { userId,
   message })`), and throws a new `TRPCError` with a fixed, generic
   message ("Unable to load check-in information. Please try again.") -
   never the original error's `.message`, `.stack`, table/column names, or
   query parameters. `claim` already had this pattern from Phase 5 and was
   left as-is (already correct - the task asked to double check it, and it
   already never leaked anything).
2. **Client** (`client/src/components/DailyCheckinCard.tsx`): the error
   state no longer reads `error.message` **at all** - it always renders
   the fixed, translated `t("checkin.error")` string
   ("ไม่สามารถโหลดข้อมูลเช็กอินได้ กรุณาลองใหม่อีกครั้ง" /
   "Unable to load check-in information. Please try again."), and the
   claim mutation's `onError` always shows `t("checkin.error")` too, never
   `err.message`. This is a second, independent layer - even if a future
   server change ever regressed the server-side fix, the client would
   still never echo raw error detail, by construction (the error text
   literally doesn't reference `error`/`err` anywhere in the component).

The retry button (`t("checkin.retry")`, calling `refetch()`) is unchanged
and still works - only the message shown alongside it changed.

No secrets (tokens, cookies, `DATABASE_URL`) were ever part of what leaked
- the leak was schema/query shape (table name, column name, the fact that
a `dailyCheckins`⋈`coupons` join exists), which is still sensitive (informs
an attacker about internal schema) even though it's not a credential.
`scripts/migrate.mjs` and the router's `console.error` calls were both
written to log only `error.code`/`error.message`/`error.sqlState` fields
(or a small explicit subset), never the raw error object, never a
connection string, matching this same principle for server-side logs too.

## C. Daily Check-in moved from Home to Profile

- `client/src/pages/Home.tsx`: removed the `DailyCheckinCard` import and
  its render (previously right after the banner carousel). Home's
  `home.getSections` query and its own novel sections are completely
  unaffected - `DailyCheckinCard` was always its own independent query, so
  removing it doesn't touch anything else on the page.
- `client/src/pages/ProfilePage.tsx`: added the import and mounted
  `<DailyCheckinCard />` directly after the `<h1>โปรไฟล์ของฉัน</h1>` header
  and before the "ข้อมูลส่วนตัว" (Personal Info) card - matching the
  requested order exactly (Profile header → check-in card → personal info
  → wallet/points → quick links → bookshelf, all of which were already in
  that relative order and untouched).
- **Only mounted in one place**: confirmed via a repo-wide grep for
  `DailyCheckinCard` - the only import/usage outside the component's own
  definition file is `ProfilePage.tsx`.
- **Auth gating comes from `ProfilePage.tsx`'s existing structure, not a
  new guard**: the page already does `if (!user) return <login card>;`
  before its main return - `<DailyCheckinCard />` is only reached past that
  point, so its `dailyCheckin.getStatus` query is never fired for a
  signed-out visitor. This was true without adding any new condition,
  since the component sits after the existing early return.
- **Spacing**: `DailyCheckinCard`'s outer margin was changed from Home's
  large section spacing (`mb-12 sm:mb-16 md:mb-20`, sized for Home's big
  banner/section rhythm) to `mb-8`, matching every other section on
  `ProfilePage` (the header, the Personal Info card, the Wallet/Points
  grid all use `mb-8`). Since Home no longer renders this component at
  all, there's no longer a second call site that would need the old,
  larger spacing.
- All states (loading skeleton, error+retry, unauthenticated login CTA,
  claimable, already-checked-in) are unchanged in logic - only their copy
  (see below) and margin changed.
- Mobile: the card's internal layout (`flex-col` stacking to `sm:flex-row`,
  full-width buttons below the `sm` breakpoint) was already responsive from
  Phase 5 and is untouched.

## D. `nav.profile` fix

Root cause: `Navbar.tsx` used `t("nav.profile") || "โปรไฟล์"`, but
`useLanguage()`'s `t()` function
(`translations[language][key] || translations["en"][key] || key`) falls
back to returning **the key string itself** when a key is missing from
both language maps - which is truthy, so the `|| "โปรไฟล์"` fallback in
Navbar never actually triggered. `"nav.profile"` was never defined in
either the `th` or `en` translation blocks in
`client/src/contexts/LanguageContext.tsx` - confirmed by grepping every
`"nav.*"` key in that file before this fix; it was the only nav key
missing a definition.

Fixed by adding the real translations (fixing the root cause, not just the
symptom):

```ts
// th block
"nav.profile": "โปรไฟล์",
// en block
"nav.profile": "Profile",
```

`Navbar.tsx`'s two call sites (desktop, line ~118, and mobile, line ~219)
were simplified from `{t("nav.profile") || "โปรไฟล์"}` to `{t("nav.profile")}`
- the fallback is no longer needed now that the key exists, and leaving it
would misleadingly suggest the key might still be missing. Both call sites
still navigate to `/profile` (unchanged `onClick={() => navigate("/profile")}`)
and the signed-in username chip (`{user?.name?.split(" ")[0]}`) next to it
was not touched.

Every other `"nav.*"` key referenced anywhere in `Navbar.tsx` was checked
against both language blocks - all already had real translations; only
`nav.profile` was missing. No other translation keys were added or changed
(explicitly out of scope per the task).

## E. Daily check-in copy

All check-in-related UI text was moved into `LanguageContext.tsx` under a
new `checkin.*` key group (both `th` and `en` blocks), matching this
codebase's existing per-feature key grouping convention (`nav.*`,
`home.*`, etc.) instead of hardcoding strings in the component or scattering
them elsewhere. No i18n system refactor was done - same flat
`Record<string,string>` + `t(key)` lookup as everywhere else in this file.

| Key | th | en |
|---|---|---|
| `checkin.title` | เช็กอินรายวัน รับคูปองส่วนลด | Daily Check-in: Get a Discount Coupon |
| `checkin.description` | เช็กอินได้วันละ 1 ครั้ง | Check in once per day |
| `checkin.loginPrompt` | เข้าสู่ระบบเพื่อรับคูปองส่วนลดทุกวัน | Sign in to get a discount coupon every day |
| `checkin.claimButton` | เช็กอินรับคูปอง | Check In for a Coupon |
| `checkin.claiming` | กำลังเช็กอิน... | Checking in... |
| `checkin.alreadyCheckedIn` | เช็กอินวันนี้แล้ว | Checked in today |
| `checkin.retry` | ลองใหม่อีกครั้ง | Try again |
| `checkin.error` | ไม่สามารถโหลดข้อมูลเช็กอินได้ กรุณาลองใหม่อีกครั้ง | Unable to load check-in information. Please try again. |
| `checkin.couponCode` | รหัสคูปอง | Coupon code |
| `checkin.expires` | หมดอายุ | Expires |

The word "ฟรี!" was removed from both the unauthenticated-prompt and
claimable-state headlines (previously "เช็กอินรายวัน รับคูปองส่วนลดฟรี!" /
"เช็กอินวันนี้ รับคูปองส่วนลดฟรี!") - both now use the single, consistent
`checkin.title` string without it, per the task's instruction not to
overuse "ฟรี!".

**Coupon terms were not changed** - still 5% off, capped at ฿10, ฿50
minimum purchase, 7-day validity. These come entirely from
`server/_core/dailyCheckinConfig.ts`'s `DEFAULT_DAILY_CHECKIN_CONFIG`
(unchanged), never from the UI copy - the UI only ever displays whatever
numbers the server returns, it never hardcodes "5%"/"฿10"/"฿50"/"7 days"
anywhere.

---
No secrets appear in this document or in any file added/changed for this
fix.

## F. Follow-up: the same failure recurred in production - migration 0030

**Confirmed production symptom (unchanged from PART A/B above):** the
Profile page loads normally; only the Daily Check-in card shows the
generic `checkin.error` text and Retry reproduces the same result. A
read-only production schema check (no application code path touched, no
row data read) confirmed:

- `dailyCheckins` does **not** exist in production.
- `coupons.maxDiscountAmount` **does** already exist in production.
- `__drizzle_migrations` exists, and its recorded high-water mark is
  already **past** migration 0027 - the migration responsible for
  creating `dailyCheckins`.

In other words: **0027 was skipped, or `dailyCheckins` disappeared after
its migration history had already advanced past it.** This is not a defect
in 0027's SQL - its `CREATE TABLE IF NOT EXISTS dailyCheckins` is correct
and idempotent, exactly as designed in PART A. The problem is that
drizzle-orm's MySQL migrator resumes purely by comparing each journal
entry's `when` timestamp against the single latest recorded `created_at`
in `__drizzle_migrations` - never by re-checking whether each migration's
target objects still actually exist (the same class of bug this repo's
`docs/INCIDENT_MIGRATION_0024_EPISODES_CONTENT.md` already documented and
fixed the same way, via migration 0028). Once a database's recorded
high-water mark passes 0027's timestamp, 0027 is skipped forever regardless
of what its SQL says or whether `dailyCheckins` is present. **Editing 0027,
or manually rerunning it, cannot fix an already-recorded database.**

**The fix:** `drizzle/0030_repair_missing_daily_checkins.sql` - a new,
forward-only migration with a timestamp newer than every existing entry.
Because it is newer than anything already recorded, drizzle's migrator
(and the real production `scripts/migrate.mjs`, unchanged) will always
attempt it, regardless of where a given database's history high-water mark
currently sits. It recreates `dailyCheckins` (`CREATE TABLE IF NOT EXISTS`,
identical shape to what 0027 already declares and what `drizzle/schema.ts`
already requires), and re-verifies `dailyCheckins_userId_idx` and
`coupons.maxDiscountAmount` using the same guarded pattern 0027 already
uses - so it is also correct standalone on any environment where those are
genuinely missing, not only production's specific confirmed state.

**No production data is dropped or rewritten.** Every statement in 0030 is
additive and guarded (`CREATE TABLE IF NOT EXISTS`, or an
`information_schema`-checked `ADD COLUMN`/`CREATE INDEX`) - there is no
`DROP`, `TRUNCATE`, `RENAME`, `DELETE`, or `UPDATE` anywhere in the file.
If `dailyCheckins` already has rows on it by the time 0030 runs, they are
left completely untouched.

See `server/migration-0030-repair-missing-daily-checkins.integration.test.ts`
for real-database coverage, including a regression scenario that
reproduces the exact confirmed production state (migration history
recorded through 0029, `dailyCheckins` physically absent) and proves 0030
repairs it.
