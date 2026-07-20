# Test Infrastructure — Isolation, Safety, and the Unit/Integration Split

## Post-incident redesign (branch `fix/daily-checkin-safe`)

The daily check-in production incident (see
`docs/INCIDENT_DAILY_CHECKIN_ROLLBACK.md`) surfaced that the design
described in most of this document (below) briefly relied on
`vitest.integration.globalsetup.ts` temporarily assigning
`process.env.DATABASE_URL = TEST_DATABASE_URL` for the duration of the
integration run, and on a *pattern-match* ("contains a `test`/`ci`
segment") rather than an *exact-match* test-database-name check. Both were
tightened on this branch:

- **`EXPECTED_TEST_DATABASE_NAME`** (`server/test-helpers/testDatabaseGuard.ts`)
  is now the single literal `"ipenovel_test"` - `isAllowedTestDatabaseName()`
  requires an exact match, not a pattern.
- **`server/test-helpers/liveTestDatabaseCheck.ts`** adds a second,
  independent check: a live `SELECT DATABASE()` query against the actual
  connected server, asserted to be exactly `"ipenovel_test"`. This is not
  redundant with the URL-string check - a connection string can claim any
  path while the server resolves the session to a different default
  database; this check catches that case, which a string check alone
  cannot.
- **`server/db.ts`'s `__setDbForTests()`** is a narrow, test-only
  dependency-injection hook on the `getDb()` singleton. `getDb()` still
  falls back to its original `DATABASE_URL`-based connection when no
  override is set - zero behavior change for production. Integration test
  setup now injects a connection built directly from `TEST_DATABASE_URL`
  through this hook, so every pre-existing `server/db.ts` function
  (`claimDailyCheckin`, `validateAndApplyCoupon`, ...) transparently runs
  against the real test database **without `vitest.integration.globalsetup.ts`
  ever reading or writing `process.env.DATABASE_URL`**.
- **`scripts/migrate-test-db.ts`** is a dedicated migration runner that
  reads only `TEST_DATABASE_URL`, separate from `scripts/migrate.mjs` (the
  production runner, unchanged, still `DATABASE_URL`-only). It runs the
  connection-string guard, then the live `SELECT DATABASE()` check, then
  drizzle's programmatic `migrate()` - only after both checks pass.
- **`server/test-helpers/resetTestDatabase.ts`** + **`scripts/test-db-prepare.ts`**
  (`pnpm test:db:prepare`) - migrates, then deletes all rows from the
  tables this repo's fixtures/tests actually use, re-verifying the live
  `SELECT DATABASE()` check immediately before the delete step (never
  trusts an earlier step's check as still valid without re-checking).
- **`scripts/test-ci.ts`** now calls `runTestDbMigration()` +
  `resetTestDatabase()` in-process instead of spawning
  `scripts/migrate.mjs` with a `DATABASE_URL` environment override.
- **Integration tests clean up their own data deterministically**: ordinary
  fixture-based integration tests use `server/test-helpers/fixtures.ts`'s
  `deleteFixtures()`, scoped to exactly the IDs each test created (never a
  blanket delete of a shared table). The one exception -
  `server/migration-0027-idempotency.integration.test.ts`, which
  intentionally drops/recreates schema objects - always restores full
  schema state in a `finally` block regardless of pass/fail, so no other
  test file in the same run is left in a broken state.

None of this changes the "not yet verified against a real database in this
sandbox" status below - it changes *what* would be verified once one is
available.

This document is otherwise the result of an earlier test-suite-stabilization
pass triggered by
A/B verification showing non-deterministic release-gate results (87 vs 88
new failures across runs, with different test names each time) once a real
test database became available in Manus's environment. It explains what was
built, what was fixed, what remains as documented test debt, and - most
importantly - **what could and could not be verified from this sandbox**,
which has no `DATABASE_URL`/`TEST_DATABASE_URL` at all.

## Why the old baseline had 224 skipped, and why Manus has 0

Every DB-dependent test in this repo follows one of two patterns:

1. **Guarded** (`if (!db) return` / `if (!(await getDb())) return`, or this
   pass's new `requireTestDb()`): the test's assertions never run without a
   database, and vitest counts it as **passed with 0 assertions** - not
   "skipped" in the JSON reporter's `numPendingTests` sense, but
   functionally a no-op. (Note: vitest's JSON `numPendingTests` field
   specifically counts `it.skip`/`it.todo`, not "ran but asserted
   nothing" - the 224 "skipped" in the historical baseline are genuine
   `.skip`/`.todo` markers elsewhere in the suite, unrelated to DB
   availability. That number is unaffected by whether a database is
   present and was **224 before this pass and remains 224 after** -
   confirmed by this pass's own runs. It was never the "224 skipped" that
   changed with Manus's database; it was the ~700+ tests that had been
   silently no-op'ing via the guarded pattern above that suddenly started
   asserting for real once Manus's test run had `DATABASE_URL` pointed at
   an actual database.)
2. **Unguarded** (a large minority - see the dependency map below): calls
   `server/db.ts` functions directly with no guard at all. Without a
   database these throw ("Database not available") and are counted as
   **failed** - this is the origin of most of the 200-failure baseline
   documented in `docs/TEST_BASELINE.md`. *With* a database, these run for
   real and can pass, fail on a real assertion, or fail on a real
   infrastructure bug (duplicate key, missing fixture, race condition) -
   which is exactly the class of failure the A/B verification surfaced
   (171 failed / 1128 passed / 0 skipped in one Manus run).

So: **"0 skipped" in Manus's run and "224 skipped" in this sandbox describe
two completely different axes** - skipped (`.skip`/`.todo`) vs. no-op'd
(guarded-but-no-DB). Manus's DB availability changed how many of the
guarded tests actually exercised their assertions (previously silent,
now real), not the `.skip`/`.todo` count.

## Root cause of the A/B non-determinism (87 vs 88, different names each run)

This sandbox cannot reproduce the 87/88-failure numbers directly (no DB
here), but the architecture explains the mechanism with high confidence,
and this pass's fixes target exactly it:

1. **No isolation between test files sharing one database.** Vitest's
   default (`fileParallelism: true`) runs test files concurrently across
   worker processes. Dozens of files insert/update/delete rows in shared
   tables (`novels`, `orders`, `users`, `coupons`, ...) with **no fixture
   scoping and, in several files, no cleanup at all** - two files running
   at the same time against the same database can observe each other's
   in-flight writes. `novels-browse-pagination.test.ts` is the clearest
   example: its previous version queried the *entire* `novels` table with
   no fixtures of its own ("static data", per its own now-removed comment)
   - if another file inserted or deleted a novel mid-test, its row-count
   and pagination-boundary assertions would non-deterministically differ
   run to run.
2. **Non-unique fixture keys under concurrency.** `server/status-sync.test.ts`
   generated its unique suffix from `Date.now()` alone - two `beforeEach`
   invocations in the same millisecond (routine when multiple files run in
   parallel) produced the same `openId`/`episodeNumber` and hit a
   duplicate-key error. `server/coupon.test.ts` used `Date.now() +
   Math.random()*10000`, which is far less likely to collide but still not
   guaranteed, and - more importantly - has no database guard at all
   either (see below).
3. **No database safety guard anywhere.** Every one of the ~25 files listed
   in the dependency map below calls `server/db.ts` functions directly,
   which resolve their connection from `DATABASE_URL`, with **zero
   allowlist/blocklist check**. If `DATABASE_URL` in a CI/Manus environment
   ever pointed at something other than a disposable test database, these
   tests would run real destructive writes against it. This was the
   single highest-priority gap this pass closed (PART B below).

Given non-uniqueness (#2) plus zero isolation (#1), the *specific* set of
tests that happen to collide with each other's data varies by scheduling -
which worker picks up which file first, how fast each file's setup
completes, whether two `Date.now()` calls land in the same millisecond -
none of which is deterministic across separate `vitest run` invocations.
That is the direct mechanism behind "88 new failures, but a different list
each time."

## What was fixed in this pass (verifiable without a database)

### PART B — Database safety gate (fully verified, no DB needed to prove the logic)

- **`server/test-helpers/testDatabaseGuard.ts`** - pure string-parsing
  logic (no DB connection): `checkTestDatabaseUrl()`/
  `assertSafeTestDatabaseUrl()` require a database name with a bounded
  `test`/`ci` segment (e.g. `ipenovel_test`) and reject anything matching
  a production-shaped blocklist (`prod`/`production`/`live`/`master` in
  the name *or* host), even if the name also happens to contain "test".
  `redactDatabaseUrl()` never includes username/password in any log line.
  **21/21 tests pass for real** (`server/test-helpers/testDatabaseGuard.test.ts`)
  - this is genuine, unconditional coverage, not DB-guarded.
- **`server/test-helpers/testDb.ts`** - `getTestDb()`/`requireTestDb()`
  read `TEST_DATABASE_URL` only. There is no fallback branch to
  `DATABASE_URL` to remove - it was never written.
- **Floor-level protection for the ~80 not-yet-migrated legacy files**
  (which still call `server/db.ts` functions, i.e. read `DATABASE_URL`):
  `vitest.setup.database-safety.ts`, wired as `globalSetup` on
  **both** `vitest.config.ts` (the default/"unit" project, what `pnpm
  test`/`pnpm test:unit` run) and the integration project. If
  `DATABASE_URL` is set to anything production-shaped, the **entire test
  run aborts before a single test file loads** - verified for real in
  this sandbox: setting `DATABASE_URL` to a fabricated production-looking
  string reliably aborted the run with exit code 1 and a clear message;
  leaving it unset (this sandbox's normal state) runs tests exactly as
  before.
- **`vitest.integration.config.ts` + `vitest.integration.globalsetup.ts`** -
  the stricter tier for new/migrated integration tests
  (`server/**/*.integration.test.ts`, none exist yet as of this pass -
  see "what's not done" below): requires `TEST_DATABASE_URL`, validates it
  with the same allowlist/blocklist, and (only after validation passes)
  sets `process.env.DATABASE_URL` equal to it for the duration of that
  project's run, so pre-existing `server/db.ts`-based test logic can be
  reused inside integration tests without a second, parallel database
  connection silently diverging from the first. Verified for real: running
  `pnpm test:integration` without `TEST_DATABASE_URL` aborts immediately
  with a clear message (no silent skip).

### PART D — Unit/integration project split (Vitest 2.1.9 options verified against the installed package, not guessed)

Checked `node_modules/vitest/dist/**/*.d.ts` directly before using any
option name:

- `fileParallelism?: boolean` - confirmed real; its doc comment in
  vitest's own types states *"Setting this to false will override
  maxWorkers and minWorkers options to 1"* - exactly the sequential
  single-worker execution PART D asked for, without needing to separately
  guess at `maxWorkers`/`minWorkers` values.
- `sequence?.concurrent?: boolean` - confirmed real (`SequenceOptions`).
- `globalSetup?: string | string[]` and `name?: string` - confirmed real.
- `defineWorkspace`/`defineProject` (from `vitest/config`) - confirmed
  real; this is Vitest 2.x's actual workspace API (a `projects` array
  field inside a single `vitest.config.ts`, as in Vitest 3.x, does **not**
  exist in this installed 2.1.9 - `vitest.workspace.ts` +
  `defineWorkspace([...])` is the correct 2.x mechanism, verified by
  reading the type exports rather than assumed from newer Vitest docs).

Two projects exist:

- **`vitest.config.ts`** (`name: "unit"`, what `pnpm test`/`pnpm
  test:unit` run) - unchanged `include` pattern
  (`server/**/*.test.ts`/`*.spec.ts`), so **zero files were renamed or
  removed from this project** and `docs/test-baseline-snapshot.json`'s
  recorded failures remain directly comparable file-for-file. Given this
  project still contains ~80 not-yet-isolated legacy files (see the
  dependency map), `fileParallelism: false` was applied here too, as a
  conservative floor - see "trade-off" note below.
- **`vitest.integration.config.ts`** (`name: "integration"`, `pnpm
  test:integration`) - `include: ["server/**/*.integration.test.ts"]`,
  `fileParallelism: false`, `sequence.concurrent: false`,
  `testTimeout`/`hookTimeout: 20000` (raised from the 5s default - a
  deliberate, justified increase for real network I/O per query, not a
  blind bump to hide a hang; see PART F's "don't just raise timeouts"
  rule this is held to). No files exist under this pattern yet in this
  pass - see "what's not done."
- **`vitest.workspace.ts` was removed on `fix/daily-checkin-safe`.** It
  originally existed only for discoverability (`defineWorkspace(["./vitest.config.ts",
  "./vitest.integration.config.ts"])`) since the actual `test:unit`/
  `test:integration` scripts always invoked each config file directly via
  `-c`. That turned out not to be inert: Vitest 2.1.9 auto-detects a
  `vitest.workspace.ts` in the root and runs it in **workspace mode even
  when `-c <file>` is passed**, silently running *both* projects together
  regardless of which single config was requested. This had no observable
  effect while the integration project had zero matching files (its
  `globalSetup` never had a reason to run), but broke the moment the first
  `server/**/*.integration.test.ts` file was added (this branch's
  `server/migration-0027-idempotency.integration.test.ts`) - `pnpm
  test:unit` started failing outright with
  `vitest.integration.globalsetup.ts`'s "TEST_DATABASE_URL required" error,
  even though `test:unit` is supposed to be completely independent of the
  integration project. Deleting the workspace file restored `pnpm
  test:unit`'s isolation (verified: back to running only the unit
  project's ~89 files). `--project=unit`/`--project=integration` selection
  is no longer available as a result - not used by anything in this repo.

**Trade-off, stated plainly**: `fileParallelism: false` on the unit
project measurably slows `pnpm test`/`pnpm test:unit` in this sandbox -
observed **~71s** (sequential) vs. the pre-existing **~10-13s** (parallel,
recorded in earlier phases' reports) for the same 87 files with no
database at all, where the only cost is process/worker startup overhead
per file rather than any real I/O. This is an accepted, temporary cost:
correctness (no shared-database race between legacy files) was prioritized
over speed, given this is the directly-evidenced root cause above. Revisit
once the legacy-file migration (see "what's not done") is complete enough
that the unit project no longer contains DB-writing files at all.

### Test files fixed as reference implementations (all three verified to compile and to no-op cleanly in this no-DB sandbox)

| File | Root cause found | Fix |
|---|---|---|
| `server/status-sync.test.ts` | No DB guard at all (would throw without a DB, or write to *any* configured DATABASE_URL including production with no allowlist); `Date.now()`-only uniqueness (collision risk under parallel execution); zero cleanup (permanent row growth in a shared DB) | Added `if (!(await getDb())) return` guards to every hook/test; replaced `Date.now()` with `crypto.randomUUID()`; added `afterEach` cleanup deleting exactly this test's rows in FK-safe order, rethrowing on failure |
| `server/novels-browse-pagination.test.ts` | DB-dependent tests queried the *entire* `novels` table with no fixtures of its own - "page 2 never repeats page 1", "hasNextPage" cardinality, etc. all depended on however many novels happened to exist at that instant, including rows other concurrently-running files were inserting/deleting | Added a `beforeAll`/`afterAll` that seeds 8 isolated fixture novels under two unique tags and scopes every assertion via `search: TAG` - results are now independent of ambient data regardless of what else runs concurrently; added an explicit "search tag never matches an unrelated novel" test; restored (rather than dropped) the search+filter+sort composition test using its own isolated free-episode fixture |
| `server/daily-checkin.test.ts` | Fixture "users" were hardcoded literal integers (900001-900011) - functionally safe here (no FK constraint on `dailyCheckins.userId`/`coupons` to `users`) but assumed a specific ID range was permanently unused rather than asking the database, and didn't clean up the `users` rows it never actually created | Added a `createRealTestUserId()` helper that inserts a real `users` row via `db.upsertUser`/`getUserByOpenId` and returns the database-assigned ID; replaced every hardcoded literal (including the `COUPON_USER + 1`..`+6` offset-arithmetic scheme) with real per-scenario user IDs; cleanup now also deletes the created `users` rows |

None of these files were renamed or moved - all three keep their exact
prior path, so `docs/test-baseline-snapshot.json`'s recorded entries for
them remain valid, file-for-file, for comparison (see `docs/TEST_BASELINE.md`
for what changed in this run's failure count as a result).

### PART E — Fixtures and reset (built, only unit-tested for their own logic)

`server/test-helpers/fixtures.ts` - factories (`createTestUser`,
`createTestNovel`, `createTestEpisode`, `createTestOrder`,
`createTestOrderItem`, `createTestPayment`, `createTestCoupon`) that each
insert one real row via `getTestDb()` and return the ID the database
actually assigned - never an assumed ID. `uniqueTestTag()` uses
`crypto.randomUUID()`, never `Date.now()`. `deleteFixtures()` deletes a
caller-supplied set of IDs in FK-safe (child-before-parent) order and
**rethrows** on any failure (never swallows a cleanup error).

**Important scoping rule, learned while building this**: `fixtures.ts`
(via `getTestDb()`, `TEST_DATABASE_URL`) must never be imported into the
same file as `server/db.ts`'s functions (which read `DATABASE_URL`) -
mixing the two would silently read/write two different database
connections unless an operator happens to set both env vars to the exact
same value. This is why the three reference-fixed files above deliberately
do **not** import `fixtures.ts` - they stay on `server/db.ts` + a local
uniqueness/cleanup fix, consistent with their non-`.integration.test.ts`
naming and their place in the unit project (where only the floor-level,
"not obviously production" check applies, not the integration project's
env-var bridging). `fixtures.ts` is reserved for future
`*.integration.test.ts` files that exclusively use `getTestDb()` for all
of their database access.

### PART H — Release gate hardening (fully verified, including negative tests)

`scripts/release-gate-check.mjs` now additionally checks, none of which
existed before this pass:

- **Collection errors**: a test file that fails before running a single
  `it()` (syntax error, throwing at module scope, bad import) is detected
  explicitly, separate from a normal assertion failure. Verified for real:
  an injected file that `throw`s at module scope was correctly reported
  as a collection error and failed the gate.
- **Test/file count floor**: `docs/test-baseline-snapshot.json` now
  carries a `meta` block (`minimumExpectedTotalTests`,
  `minimumExpectedFileCount`) recorded from this pass's own measured run
  in this sandbox (1379 tests, 87 files) - if a future run reports fewer
  than that, the gate fails loudly rather than silently accepting fewer
  tests as "fine."
- **Failure-to-skip conversion**: any test present in the baseline's known
  *failures* that is now *skipped* (rather than passing or still failing)
  fails the gate with an explicit message - directly blocks the "wrap a
  failing test in `it.skip` to make the gate pass" pattern this task
  explicitly forbids. Verified logically (code review) though not
  exercised with a live example in this pass, given no committed test
  currently has this shape.
- Process crash / signal termination and missing-JSON-output detection
  (already present before this pass) are unchanged and still active.

The snapshot's actual **failure list is byte-for-byte unchanged** from the
prior baseline (verified via a diff script: 0 added, 0 removed, exactly
200 in both) - only the wrapping `meta` object was added. See
`docs/TEST_BASELINE.md` for why the list itself was deliberately **not**
updated even though this pass's fixes are believed to have resolved 10 of
those 200 (status-sync.test.ts) in this sandbox.

### PART K — Scripts

- `pnpm test:unit` = `vitest run -c vitest.config.ts` (equivalent to
  today's `pnpm test`, named explicitly).
- `pnpm test:integration` = `vitest run -c vitest.integration.config.ts`.
- `pnpm test:ci` (`scripts/test-ci.ts`, run via `tsx`) - validates
  `TEST_DATABASE_URL`, runs `scripts/migrate.mjs` against it (the exact
  same safe, lock-protected migration runner used for the production
  `pnpm start` path - see `docs/DAILY_CHECKIN_DEPLOYMENT_FIX.md` - never a
  separate, unaudited test-migration path), then unit tests, then
  integration tests, preserving the first non-zero exit code across all
  steps. Verified: refuses cleanly (exit 1, clear message) without
  `TEST_DATABASE_URL`.
- `pnpm test:repeat [N]` (`scripts/test-repeat.mjs`) - runs the suite N
  times (default 3) and fails if total/passed/failed/pending counts OR the
  exact set of failing test names differ between any two runs. This is the
  script used for PART G/L's "3 consecutive runs, identical results"
  requirement - see the Deliverable section for this pass's actual
  results.
- `pnpm test`/`pnpm test:gate` are **unchanged** in what they invoke -
  this pass added capability without altering their existing, working
  behavior.

## Dependency map: which test files write to which tables (audited, not exhaustive)

Built by grepping every flagged/DB-touching file for `db.create*`/
`db.update*`/`db.delete*`/`db.upsert*` calls. This is the file-by-file
audit `docs/TEST_BASELINE.md`'s root-cause categories are based on.

| Table(s) written | Test files (non-exhaustive - representative of the shared-state risk) |
|---|---|
| `users` | `status-sync.test.ts` (fixed), `daily-checkin.test.ts` (fixed), `tests/phase1-2.test.ts`, `tests/final-regression.test.ts` |
| `novels` | `status-sync.test.ts` (fixed), `novels-browse-pagination.test.ts` (fixed), `browse-catalog-fix.test.ts`, `story-status-sync.test.ts` |
| `episodes` | `status-sync.test.ts` (fixed), `novels-browse-pagination.test.ts` (fixed) |
| `orders`/`orderItems`/`payments` | `status-sync.test.ts` (fixed), `wallet-rollback.test.ts`, `wallet-rollback-real.test.ts`, `wallet-checkout-real-integration.test.ts`, `tests/final-regression.test.ts` |
| `coupons` | `coupon.test.ts`, `daily-checkin.test.ts` (fixed), `tests/final-regression.test.ts` |
| `dailyCheckins` | `daily-checkin.test.ts` (fixed) only |
| `walletTopups` | `wallet-rollback-real.test.ts`, `wallet-checkout-real-integration.test.ts`, `wallet-topup-bonus-ocr.test.ts` |
| `banners` | `home-banners.test.ts` |

**Not yet migrated / fixed in this pass** (documented test debt, in
priority order for a follow-up pass):

1. **`server/coupon.test.ts`** - no DB guard at all (throws/writes without
   one); `Date.now()`+`Math.random()` uniqueness (lower collision risk
   than pure `Date.now()`, but still not a real UUID); no cleanup at all.
   Same failure shape as status-sync.test.ts before this pass's fix -
   directly reusable pattern.
2. **`server/browse-catalog-fix.test.ts`** - `beforeAll` has no guard
   (only `afterAll`'s cleanup checks `getDb()`); its `limit: 100` query for
   "should return published novels" could plausibly be pushed past its
   fixture by ambient/concurrently-inserted novels in a shared,
   growing database - same class of issue `novels-browse-pagination.test.ts`
   had, not yet applied here.
3. **`server/story-status-sync.test.ts`** - same missing-`beforeAll`-guard
   shape as `browse-catalog-fix.test.ts`.
4. **`server/wallet-rollback-real.test.ts`,
   `server/wallet-checkout-real-integration.test.ts`,
   `server/wallet-topup-bonus-ocr.test.ts`** - no DB guard on their
   fixture-creation helpers; not yet audited for unique-key collision risk
   under parallel execution.
5. **`server/tests/phase1-2.test.ts`, `server/tests/final-regression.test.ts`** -
   no DB guard; multi-table fixture chains (user → order → items →
   payment) with no cleanup.
6. **~70 further files** not touching mutable tables directly (OCR/slip
   verification, admin read-only queries, wallet bonus *calculation* tests
   with the separately-documented missing-`await` bug from
   `docs/TEST_BASELINE.md`, etc.) - lower risk, not audited line-by-line in
   this pass.

None of these were touched in this pass - fixing all of them was out of
scope for what can be responsibly done and verified without a live
database in one sitting (see "What could not be verified" below). The
three reference fixes above establish the pattern; extending it to the
rest is the immediate next piece of test debt.

## What could NOT be verified in this sandbox (read before treating this as done)

This sandbox has no `DATABASE_URL` or `TEST_DATABASE_URL` at any point
during this pass - every claim above about *logic* (guard behavior,
config option validity, script exit codes, fixture code compiling and
type-checking) is real and verified; every claim about *actual database
behavior* is not, and must not be read as verified:

- Whether the reference-fixed files (`status-sync.test.ts`,
  `novels-browse-pagination.test.ts`, `daily-checkin.test.ts`) actually
  pass against a real database has **not** been checked - only that they
  compile, no-op cleanly without a DB, and are constructed correctly by
  code review.
- `scripts/migrate.mjs`'s `GET_LOCK`/`RELEASE_LOCK` concurrency protection
  (from the prior deployment-fix pass) has never been exercised against a
  real MySQL server from this sandbox, and neither has `scripts/test-ci.ts`'s
  full migrate→unit→integration→cleanup flow.
- `fixtures.ts`'s factories and `deleteFixtures()` have never actually
  inserted or deleted a row - their correctness rests on matching
  `drizzle/schema.ts`'s column definitions by code review, not execution.
- The "87 vs 88 new failures, different names each run" claim from A/B
  verification was never reproduced here - the root-cause analysis above
  is architectural (grep-based code audit), not confirmed by rerunning the
  exact failing scenario.
- **Full-suite 0-failures determinism has not been achieved or claimed.**
  `pnpm test`/`pnpm test:unit` in this sandbox still show the same ~190
  known, pre-existing, DB-connectivity-caused failures as before this
  pass (10 fewer than the 200-entry baseline, from the status-sync.test.ts
  fix) - this pass improves the *infrastructure* around those failures,
  it does not eliminate them, because eliminating the remaining ~180
  requires a live database this sandbox doesn't have.

**Recommended next step**: run `pnpm test:ci` (or `pnpm test:integration`
and `pnpm test:unit` separately) with a real `TEST_DATABASE_URL` in
Manus's environment, then `pnpm test:repeat 3` there too, before treating
any of this as proven against a real database. See `docs/TEST_BASELINE.md`
for the full GO/NO-GO reasoning.

## How to run this locally / in CI

```bash
# Unit tests only - safe, no database needed, matches pnpm test's failure count
pnpm test:unit

# Prepare the disposable test database: validate -> live-verify -> migrate -> reset
export TEST_DATABASE_URL="mysql://user:pass@host:3306/ipenovel_test"
pnpm test:db:prepare

# Integration tests - requires a real, disposable test database
export TEST_DATABASE_URL="mysql://user:pass@host:3306/ipenovel_test"
pnpm test:integration

# Full CI flow: validate -> migrate -> unit -> integration -> preserve exit code
export TEST_DATABASE_URL="mysql://user:pass@host:3306/ipenovel_test"
pnpm test:ci

# Determinism check - run the suite 3x and fail if results differ
pnpm test:repeat 3

# Release gate - compare against the known-failure baseline
pnpm test:gate
```

**Never point `TEST_DATABASE_URL` or `DATABASE_URL` (while running tests)
at a database whose name doesn't clearly identify it as disposable** (e.g.
`ipenovel_test`, `ipenovel_ci`) - every layer in this document exists to
make that mistake loud and immediate instead of silently destructive.

## Concurrency policy

- **Unit project**: `fileParallelism: false` (temporary, see trade-off
  note above) - files run one at a time regardless of DB involvement.
- **Integration project**: `fileParallelism: false` and
  `sequence.concurrent: false` - permanently, by design (multiple
  integration files sharing one test database must never race each
  other; this repo does not currently provision a separate database per
  worker, so true parallel integration execution is out of scope for this
  pass - see PART D's task brief for the per-worker-database design this
  would require if ever needed).

## Analyzing a flaky test

1. Run it alone: `npx vitest run -c vitest.config.ts path/to/file.test.ts`.
   If it passes alone but fails in the full suite, suspect shared state
   (see the dependency map above for what else touches the same tables).
2. Run `pnpm test:repeat 3` scoped to just that file
   (`node scripts/test-repeat.mjs 3 -- path/to/file.test.ts`) to confirm
   non-determinism concretely rather than guessing from a single run.
3. Check for: hardcoded/non-unique fixture values (`Date.now()` alone is
   never enough), a missing `if (!db) return`/`requireTestDb()` guard, a
   missing `afterEach`/`afterAll` cleanup, or an assertion that depends on
   total row counts/ambient data rather than fixtures the test itself
   created and scoped to (e.g. via a unique `search`/tag filter).
4. Never fix a flaky test by adding `it.skip`, deleting it, or loosening
   its assertion to tolerate the non-determinism - fix the isolation bug.

---
No secrets appear in this document or in any file added/changed for this
pass.
