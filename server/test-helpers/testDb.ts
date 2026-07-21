// The ONLY sanctioned way for a new/migrated integration test to obtain a
// database connection. Never reads DATABASE_URL, ever, under any
// circumstance - there is no fallback branch to remove, by construction.
// See docs/TEST_INFRASTRUCTURE.md.
//
// Connects via a mysql2 pool built from buildTestDbConnectionOptions()
// (TLS required, TLSv1.2 minimum, certificate verification never disabled)
// rather than calling drizzle(url!) directly - a real Manus integration run
// against TiDB Cloud failed with "Connections using insecure transport are
// prohibited" when this used a plain URL string with no TLS options. See
// testDbConnectionOptions.ts for the full rationale.
import mysql from "mysql2";
import { drizzle } from "drizzle-orm/mysql2";
import { redactDatabaseUrl } from "./testDatabaseGuard";
import { assertLiveTestDatabaseName } from "./liveTestDatabaseCheck";
import { buildTestDbConnectionOptions } from "./testDbConnectionOptions";

let _testDb: ReturnType<typeof drizzle> | null = null;
let _testPool: mysql.Pool | null = null;
let _testDbUrl: string | null = null;
let _liveVerifiedForUrl: string | null = null;

/**
 * Returns a drizzle connection to the test database, or throws with a
 * clear, actionable message if TEST_DATABASE_URL is missing or unsafe.
 * Unlike server/db.ts's getDb() (which quietly returns null when
 * unconfigured, appropriate for optional production behavior), this is
 * loud by design - an integration test that can't get a database has no
 * meaningful way to run at all, so silently no-op'ing here would hide a
 * real setup problem instead of surfacing it. Callers that want a
 * "skip cleanly if not configured" test should check
 * `process.env.TEST_DATABASE_URL` themselves before calling this - see
 * requireTestDb() below for that pattern.
 */
export function getTestDb() {
  const url = process.env.TEST_DATABASE_URL;
  if (_testDb && _testDbUrl === url) return _testDb;

  // buildTestDbConnectionOptions() runs the URL-string safety gate
  // (assertSafeTestDatabaseUrl) internally and throws before any connection
  // is attempted if the URL is missing or its database name isn't exactly
  // "ipenovel_test".
  const options = buildTestDbConnectionOptions(url);
  console.log(`[testDb] Connecting to test database: ${redactDatabaseUrl(url)}`);

  const pool = mysql.createPool(options);
  _testPool = pool;
  _testDb = drizzle({ client: pool });
  _testDbUrl = url!;
  return _testDb;
}

/**
 * The pattern every integration test file should use: skip cleanly (no-op,
 * matching this repo's established `if (!db) return` convention) when no
 * test database is configured at all, but throw loudly if one IS
 * configured and turns out to be unsafe (a misconfigured TEST_DATABASE_URL
 * pointing at something production-like must never be silently ignored -
 * that's a setup bug to fix, not a reason to skip).
 */
export function requireTestDb() {
  if (!process.env.TEST_DATABASE_URL) return null;
  return getTestDb();
}

/**
 * Like getTestDb(), but also runs the live "SELECT DATABASE()" check
 * (see liveTestDatabaseCheck.ts) before returning - required before any
 * migration, reset, seed, or other destructive setup step, not just before
 * ordinary per-test fixture reads/writes (those go through getTestDb()
 * directly once this has been called once per process, e.g. from
 * vitest.integration.globalsetup.ts). Cached per URL so repeat calls in the
 * same process don't re-run the query every time.
 */
export async function ensureVerifiedTestDb() {
  const db = getTestDb();
  const url = process.env.TEST_DATABASE_URL!;
  if (_liveVerifiedForUrl !== url) {
    await assertLiveTestDatabaseName(db);
    _liveVerifiedForUrl = url;
  }
  return db;
}

export async function closeTestDb(): Promise<void> {
  if (!_testPool) return;
  try {
    // Closes the actual pool this module created and retained (_testPool),
    // not a reference recovered from inside drizzle's internals - reliable
    // regardless of how drizzle-orm happens to expose the underlying
    // client in any given version.
    await _testPool.promise().end();
  } catch (error) {
    console.warn("[testDb] Failed to close test database connection cleanly:", (error as any)?.message);
  } finally {
    _testDb = null;
    _testPool = null;
    _testDbUrl = null;
    _liveVerifiedForUrl = null;
  }
}
