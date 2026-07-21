# Incident Audit — Daily Check-in Production Rollback

Written before any code was restored on `fix/daily-checkin-safe`, per the
explicit instruction to audit first. This traces the complete request path,
migration path, startup path, and test setup for the daily check-in
feature as it existed prior to rollback - not just the single cause already
documented in `docs/DAILY_CHECKIN_DEPLOYMENT_FIX.md` (restored later in this
branch), which this audit treats as one confirmed factor among several,
not the whole picture.

## Timeline (from git history, verified via `git log`/`git show`)

| Commit | What happened |
|---|---|
| `7dce4ba` | Daily check-in feature added: `dailyCheckins` table, `coupons.maxDiscountAmount` column, migration `0027`, `dailyCheckin.getStatus`/`claim` tRPC routes, `DailyCheckinCard` mounted **on Home** (unauthenticated-safe server-side, but reachable by every logged-in visitor of the highest-traffic page). No automated migration step existed anywhere in the deploy pipeline at this point - `package.json`'s `start` was `NODE_ENV=production node dist/index.js`, nothing else. |
| `3cf7025` | A release-gate/baseline retest - no functional change to the feature. |
| `55bcc42` | Production incident response: raw SQL/DB error was reaching the client on Home (`dailyCheckin.getStatus` had no try/catch), migration `0027` had never run automatically, and the check-in card was moved from Home to the authenticated-only Profile page. `scripts/migrate.mjs` (a lock-protected, TEST/PROD-agnostic migration runner) and `package.json`'s `start` change (`node scripts/migrate.mjs && node dist/index.js`) were added here - **this is the first commit in this feature's history that runs any migration automatically at all**. |
| `c385b63`, `4d93c03`, `ebb3be1` | Test-suite stabilization: `TEST_DATABASE_URL`-gated test helpers, isolated integration test project, release-gate hardening. Infrastructure only - no production behavior change. |
| (external) | An automated `Manus <dev-agent@manus.ai>` process rolled `origin/main` back through several checkpoints (`ac87701` → `4104f58` "Rollback to 2528fcb6" → `2ad6183` → `d915e06` "Rollback to 4104f583"), landing on `d915e06`, which matches the tree at commit `23744a6` (**the commit immediately before daily check-in was ever added**) - i.e. the entire feature, its fix, and the test infrastructure were all discarded together, not selectively. |
| (external, discovered during this task) | A further automated checkpoint (`87c3296`, same author) **partially reintroduced** `drizzle/0027_*.sql`, `drizzle/meta/0027_snapshot.json`, and the `dailyCheckins`/`maxDiscountAmount` schema entries on top of `d915e06`, without reintroducing any of the application code that queries them (`server/routers.ts`'s `dailyCheckin` routes, `server/db.ts`'s `claimDailyCheckin`, `DailyCheckinCard.tsx` are all still absent from that commit). This is evidence the automated rollback/checkpoint process is not fully reliable or idempotent - see "Contributing factor 5" below. This branch is built from `d915e06` specifically (not the drifted `origin/main` tip) - see the deliverable report for why.

## Request path (what a browser visit actually triggered)

Before `55bcc42`: `Home.tsx` unconditionally rendered `<DailyCheckinCard />`
→ the card's own `trpc.dailyCheckin.getStatus.useQuery()` fired on every
Home page load → the server procedure (`publicProcedure`) checked
`ctx.user`: unauthenticated visitors got `{ authenticated: false }` with no
DB touch, but **every authenticated visitor** reached
`db.getDailyCheckinStatus(ctx.user.id)`, which did

```sql
select dailyCheckins.id, dailyCheckins.checkinDate, dailyCheckins.status,
  dailyCheckins.issuedAt, coupons.id, coupons.code, coupons.discountType,
  coupons.discountValue, coupons.maxDiscountAmount, coupons.minPurchaseAmount,
  coupons.expiresAt
from dailyCheckins inner join coupons ...
```

with **no try/catch** in the router at that point (added only in `55bcc42`).
If the table/column didn't exist in the connected database, the raw driver
error (including table/column names and the query shape) propagated
straight through tRPC's default error serialization to the client, where
`DailyCheckinCard.tsx` interpolated `error.message` directly into visible
text. **Blast radius**: Home is the single highest-traffic route in this
app and requires no navigation to reach - this is why the symptom was
immediately visible rather than confined to a rarely-visited page.

## Migration path

`drizzle/0027_add_daily_checkin_and_coupon_cap.sql` (as committed in
`7dce4ba`) was syntactically correct and matched `schema.ts` exactly
(`drizzle-kit generate` reported no drift at every phase of this session).
**The migration itself was never the defect** - the defect was that nothing
in the deploy pipeline ever executed it:

- `package.json`'s `start` script, at `7dce4ba`, was
  `"NODE_ENV=production node dist/index.js"` - no migration step.
- `db:push` (`drizzle-kit generate && drizzle-kit migrate`) existed but is
  a manual, developer-invoked command; nothing in the repo or its scripts
  ever called it automatically.
- Every migration from `0000` through `0026` reaching production therefore
  depended entirely on a human manually running `db:push` against
  production at some point after each merge - an unverifiable,
  undocumented, and un-audited manual step with no CI gate.

`55bcc42` fixed the *mechanism* (an automated, lock-protected
`scripts/migrate.mjs` wired into `start`) but that fix necessarily shipped
*after* `7dce4ba` had already been live with no such mechanism - meaning
there was a real window in which the app queried a schema no automated
process had ever created.

## Startup path

Confirmed via `package.json` diffs across this history: no readiness/health
check anywhere in this codebase (`server/_core/healthCheck.ts`) verifies
schema state before serving traffic, at any point in this history
(before or after `55bcc42`). `getReadinessStatus()` checks `SELECT 1`
(connectivity) and a fixed env-var list, never "does this specific
migration exist in `__drizzle_migrations`." This means even with
`55bcc42`'s automated migration step, a *failed* migration would currently
be caught only by `scripts/migrate.mjs`'s own exit code aborting `start`
(verified working in the prior session's investigation) - there is still
no independent readiness signal confirming schema state at runtime.

## Test setup (as it existed at `7dce4ba`/before `c385b63`)

`server/daily-checkin.test.ts` at `7dce4ba` used the established
`if (!db) return` guard convention correctly (no-ops without a DB) - the
test suite itself never caused the incident. However, it (and every other
DB-touching test file in this repo at that point) read its database
connection through `server/db.ts`'s `getDb()`, which resolves from
`DATABASE_URL` with **no allowlist/blocklist check of any kind**. Nothing
prevented a misconfigured CI/local environment from running these tests
against a real, non-test `DATABASE_URL`. This was not the proximate cause
of the *production* incident (tests don't run in production), but it is a
real, separate risk this branch closes per the new safety requirements
below - and it directly explains why "should tests be able to touch
DATABASE_URL at all" is treated as a hard requirement this time, not an
optional improvement.

## Root cause (primary)

**No automated migration execution existed anywhere in the deploy
pipeline when the daily check-in feature first shipped.** The application
code assumed `dailyCheckins`/`coupons.maxDiscountAmount` existed; nothing
had ever created them in the production database at deploy time. This is
a deployment-process defect, not a defect in the migration SQL or the
application logic that queried it.

## Contributing factors (none of these alone would have caused the
## incident, but each widened its blast radius or delayed detection)

1. **No error containment**: the router let a raw driver error reach the
   client verbatim. Even with the migration gap, a try/catch + generic
   message would have prevented users from seeing SQL/schema details -
   this is a defense-in-depth gap, independent of the migration-ordering
   bug.
2. **Placement on Home, not gated by navigation**: mounting the check-in
   card on the highest-traffic, no-navigation-required page maximized how
   many authenticated users hit the failing query, and how fast the
   problem was noticed (a double-edged outcome - faster detection, but
   also a much larger number of users who saw a broken page).
3. **No schema-state readiness signal**: nothing in `healthCheck.ts`
   would have caught "the app is about to serve traffic against a schema
   it doesn't have" before this incident, and still doesn't after
   `55bcc42` - a monitoring gap, not fixed by this branch (out of scope;
   noted as a remaining risk in the deliverable report).
4. **No test-database safety boundary**: every DB-dependent test in this
   repo (at every point in this feature's history prior to this branch)
   could, in principle, run destructive setup against whatever
   `DATABASE_URL` happened to be configured, with no verification it was
   a disposable test database. Not the proximate cause of the production
   incident, but a real latent risk this branch is required to close.
5. **Unreliable automated rollback/checkpoint process**: discovered during
   this recovery task itself (not part of the original incident) - the
   external `Manus dev-agent` process that performs rollback/checkpoint
   commits on `origin/main` has, at least twice now, produced commits
   whose actual file content contradicts their own commit message
   (`2ad6183` and `87c3296` both reintroduced daily-checkin files while
   claiming to reflect a rollback/sync state). This means `origin/main`
   cannot currently be trusted as a moving reference for "the current
   production state" - only a specific, independently-verified commit SHA
   can be, which is why this recovery branch is built from the explicit
   SHA `d915e06994142540d833abd3186e89bf629e4fc4` rather than from
   `origin/main` at the time this branch was created. This is a process/
   tooling risk outside this repository's code, but is documented here
   because it directly affects how safely *any* future rollback or
   recovery on this repository can be trusted without independent
   verification.

## What this branch does and does not change

This branch restores the feature, its deployment fix, and the test
infrastructure as new commits (not by moving a branch pointer), then adds
the stricter test-database safety design required for this recovery (exact
`ipenovel_test` database-name match, zero `DATABASE_URL` access from any
test/reset/seed/cleanup/migration command, a dedicated
`TEST_DATABASE_URL`-only migration runner) and the specific regression
tests listed in the task. It does **not** touch `main`, does not run any
migration against any database, and does not deploy - see the deliverable
report for exactly what was verified locally versus what still requires a
real test database to confirm.
