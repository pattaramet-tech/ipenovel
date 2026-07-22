// Per-worker setup for the integration project (vitest.integration.config.ts).
//
// Why this file exists, and why vitest.integration.globalsetup.ts's own
// __setDbForTests() call is NOT sufficient by itself: Vitest always runs
// globalSetup in the CLI's own main process, before any test file is even
// collected - it never runs inside the worker (thread or forked process)
// that actually executes test files. server/db.ts's getDb() override is a
// plain module-level variable, and a worker gets its OWN fresh instance of
// server/db.ts (a separate module registry from the main process) - so a
// mutation made from globalSetup's copy of the module is invisible to every
// test file's copy. Empirically confirmed: instrumenting getDb() showed
// globalSetup's __setDbForTests(realDb) landing on one module instance while
// every test file's getDb() call read a completely different instance whose
// override was always null, making every real production code path
// (claimDailyCheckin, getOrCreateCart, etc.) fail with "Database not
// available" - independent of any Daily Check-in change, reproduced on an
// unrelated pre-existing file (checkout-after-slip-upload-diagnosis) and on
// a pristine git checkout with no working-tree changes at all.
//
// setupFiles (unlike globalSetup) runs inside each worker's own module
// registry - the same one the test file and every production function it
// calls actually execute in - so calling __setDbForTests() here reaches the
// getDb() the tests actually invoke. vitest.integration.globalsetup.ts keeps
// its job of failing the whole run immediately and loudly if
// TEST_DATABASE_URL is missing or unsafe, before any file even starts.
import { beforeAll } from "vitest";
import { __setDbForTests } from "./server/db";
import { ensureVerifiedTestDb } from "./server/test-helpers/testDb";

beforeAll(async () => {
  if (!process.env.TEST_DATABASE_URL) return;
  const db = await ensureVerifiedTestDb();
  __setDbForTests(db);
});
