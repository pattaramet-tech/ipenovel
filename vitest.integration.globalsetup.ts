// globalSetup for the integration project (vitest.integration.config.ts,
// `pnpm test:integration`). Runs once, before any test file is collected,
// in the CLI's own main process - NOT in the worker (thread or forked
// process) that later actually runs test files. That distinction matters
// for what this file can and cannot do (see point 3 below).
//
// 1. Requires TEST_DATABASE_URL - never falls back to DATABASE_URL. If
//    unset, the whole integration run aborts immediately with a clear
//    message (never a silent skip - an integration suite that can't find
//    its database has nothing meaningful to test).
// 2. Validates it against the connection-string guard
//    (server/test-helpers/testDatabaseGuard.ts) - the database name must be
//    EXACTLY "ipenovel_test", then re-verifies that live via a real
//    "SELECT DATABASE()" query (server/test-helpers/liveTestDatabaseCheck.ts)
//    before anything else runs. This is what makes a misconfigured
//    TEST_DATABASE_URL fail loudly and immediately rather than lazily inside
//    whichever test file happens to touch the database first.
// 3. Also calls __setDbForTests() on ITS OWN copy of server/db.ts, purely
//    for symmetry/documentation - this has no effect on any test file,
//    since a worker gets a completely separate module registry from this
//    process and never observes a mutation made here. The mutation that
//    actually matters for test files is made by vitest.integration.setupfile.ts
//    (configured via `setupFiles`, not `globalSetup`), which runs inside
//    each worker's own registry. See that file for the full story of why
//    this split is required, not a redundant duplicate.
//
// See docs/TEST_INFRASTRUCTURE.md for the full integration test lifecycle
// (pnpm test:db:prepare -> run -> cleanup) that wraps this at the
// `pnpm test:integration`/`pnpm test:ci` script level.
import { assertSafeTestDatabaseUrl, redactDatabaseUrl } from "./server/test-helpers/testDatabaseGuard";
import { ensureVerifiedTestDb, closeTestDb } from "./server/test-helpers/testDb";
import { __setDbForTests } from "./server/db";

export default async function setup() {
  const testUrl = process.env.TEST_DATABASE_URL;

  if (!testUrl) {
    throw new Error(
      "Integration tests require TEST_DATABASE_URL to be set to a disposable test database connection " +
        'string whose database name is exactly "ipenovel_test" (e.g. "mysql://user:pass@host:3306/ipenovel_test"). ' +
        "Integration tests never fall back to DATABASE_URL. See docs/TEST_INFRASTRUCTURE.md."
    );
  }

  assertSafeTestDatabaseUrl(testUrl);
  console.log(`[integration setup] Connection string validated: ${redactDatabaseUrl(testUrl)}`);

  const db = await ensureVerifiedTestDb();
  console.log('[integration setup] Live "SELECT DATABASE()" check passed - injecting verified test connection.');

  __setDbForTests(db);

  return async () => {
    __setDbForTests(null);
    await closeTestDb();
  };
}
