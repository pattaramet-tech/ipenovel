// Runs as a globalSetup for BOTH the default/"unit" project (vitest.config.ts,
// what `pnpm test` runs) and the integration project
// (vitest.integration.config.ts) - a floor-level safety net, not the whole
// guard. It does exactly one thing: if DATABASE_URL happens to be set to
// anything that looks production-like, abort the ENTIRE test run before a
// single test file loads.
//
// Why this matters even for the "unit" project: ~80 pre-existing test files
// in server/**/*.test.ts call server/db.ts's functions directly (which read
// DATABASE_URL, not TEST_DATABASE_URL) with no allowlist check of their own
// - see docs/TEST_INFRASTRUCTURE.md for the file-by-file audit. This check
// protects all of them without editing any of them. It is deliberately
// permissive when DATABASE_URL is simply unset (the existing, safe default
// in this sandbox and presumably in most CI runs) - only an explicitly
// production-shaped value is rejected.
//
// The integration project's own globalSetup (vitest.integration.globalsetup.ts)
// is stricter still: it requires TEST_DATABASE_URL and a POSITIVE test-name
// match, not just "doesn't look like production."
import { looksLikeProductionDatabase, parseDatabaseUrl, redactDatabaseUrl } from "./server/test-helpers/testDatabaseGuard";

export default function setup() {
  const url = process.env.DATABASE_URL;
  if (!url) return;

  const parsed = parseDatabaseUrl(url);
  if (!parsed) {
    // Unparseable - let individual tests fail on their own (server/db.ts's
    // getDb() already handles a bad connection string gracefully), this
    // check only exists to block a *recognizable* production URL.
    return;
  }

  if (looksLikeProductionDatabase(parsed)) {
    throw new Error(
      `Refusing to run any tests: DATABASE_URL (${redactDatabaseUrl(url)}) looks production-like. ` +
        `Tests must never run against a production database. Either unset DATABASE_URL (DB-dependent ` +
        `tests will skip cleanly) or point it at a database whose name clearly identifies it as ` +
        `disposable (e.g. contains "test"). See docs/TEST_INFRASTRUCTURE.md.`
    );
  }
}
