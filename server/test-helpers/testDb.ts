// The ONLY sanctioned way for a new/migrated integration test to obtain a
// database connection. Never reads DATABASE_URL, ever, under any
// circumstance - there is no fallback branch to remove, by construction.
// See docs/TEST_INFRASTRUCTURE.md.
import { drizzle } from "drizzle-orm/mysql2";
import { assertSafeTestDatabaseUrl, redactDatabaseUrl } from "./testDatabaseGuard";

let _testDb: ReturnType<typeof drizzle> | null = null;
let _testDbUrl: string | null = null;

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

  const parsed = assertSafeTestDatabaseUrl(url);
  console.log(`[testDb] Connecting to test database: ${redactDatabaseUrl(url)}`);
  void parsed;

  _testDb = drizzle(url!);
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

export async function closeTestDb(): Promise<void> {
  if (!_testDb) return;
  try {
    await (_testDb as any).$client?.end?.();
  } catch (error) {
    console.warn("[testDb] Failed to close test database connection cleanly:", (error as any)?.message);
  } finally {
    _testDb = null;
    _testDbUrl = null;
  }
}
