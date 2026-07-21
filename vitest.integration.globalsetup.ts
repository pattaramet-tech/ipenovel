// globalSetup for the integration project (vitest.integration.config.ts,
// `pnpm test:integration`). Runs once before any integration test file
// loads.
//
// 1. Requires TEST_DATABASE_URL - never falls back to DATABASE_URL. If
//    unset, the whole integration run aborts immediately with a clear
//    message (never a silent skip - an integration suite that can't find
//    its database has nothing meaningful to test).
// 2. Validates it against the connection-string guard
//    (server/test-helpers/testDatabaseGuard.ts) - the database name must be
//    EXACTLY "ipenovel_test", then re-verifies that live via a real
//    "SELECT DATABASE()" query (server/test-helpers/liveTestDatabaseCheck.ts)
//    before anything else runs.
// 3. Injects the verified test connection into server/db.ts's getDb()
//    singleton via __setDbForTests() so every pre-existing test file's
//    server/db.ts function calls (claimDailyCheckin, validateAndApplyCoupon,
//    etc.) transparently run against the real test database - WITHOUT this
//    file ever reading or writing process.env.DATABASE_URL. This is the
//    redesign required after the daily check-in incident review: see
//    docs/INCIDENT_DAILY_CHECKIN_ROLLBACK.md and the explicit instruction
//    "no test/reset/seed/cleanup/migration command may touch DATABASE_URL."
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
