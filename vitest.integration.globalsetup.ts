// globalSetup for the integration project (vitest.integration.config.ts,
// `pnpm test:integration`). Runs once before any integration test file
// loads.
//
// 1. Requires TEST_DATABASE_URL - never falls back to DATABASE_URL. If
//    unset, the whole integration run aborts immediately with a clear
//    message (never a silent skip - an integration suite that can't find
//    its database has nothing meaningful to test).
// 2. Validates it against the same allowlist/blocklist used everywhere
//    else in this repo's test safety net (server/test-helpers/testDatabaseGuard.ts)
//    - the database name must positively look like a test database (e.g.
//    contain "test"), not merely "not obviously production."
// 3. Points every pre-existing test file's server/db.ts getDb() calls at
//    the SAME validated database, by setting process.env.DATABASE_URL to
//    the same value as TEST_DATABASE_URL for the duration of this run -
//    this is what lets ~80 not-yet-migrated legacy test files run safely
//    against the test database without editing every one of them (see
//    docs/TEST_INFRASTRUCTURE.md for which files are/aren't migrated to
//    the new getTestDb()-based pattern). It never introduces a
//    DATABASE_URL that wasn't already validated as safe in step 2.
//
// See docs/TEST_INFRASTRUCTURE.md for the full integration test lifecycle
// (migrate -> reset -> seed -> run -> cleanup) that wraps this at the
// `pnpm test:integration`/`pnpm test:ci` script level.
import { assertSafeTestDatabaseUrl, redactDatabaseUrl } from "./server/test-helpers/testDatabaseGuard";

export default function setup() {
  const testUrl = process.env.TEST_DATABASE_URL;

  if (!testUrl) {
    throw new Error(
      "Integration tests require TEST_DATABASE_URL to be set to a disposable test database connection " +
        'string (e.g. "mysql://user:pass@host:3306/ipenovel_test"). Integration tests never fall back ' +
        "to DATABASE_URL. See docs/TEST_INFRASTRUCTURE.md for how to provision one."
    );
  }

  assertSafeTestDatabaseUrl(testUrl);
  console.log(`[integration setup] Using test database: ${redactDatabaseUrl(testUrl)}`);

  const previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = testUrl;

  return () => {
    if (previousDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previousDatabaseUrl;
    }
  };
}
