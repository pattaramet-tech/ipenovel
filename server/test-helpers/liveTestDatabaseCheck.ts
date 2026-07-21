// Live (connection-required) counterpart to testDatabaseGuard.ts's
// connection-string checks. That file is deliberately pure/dependency-free
// so its logic can be unit-tested without a database; this file is the
// opposite by necessity - it runs an actual "SELECT DATABASE()" query
// against the connected server and refuses to proceed unless the result is
// EXACTLY EXPECTED_TEST_DATABASE_NAME ("ipenovel_test").
//
// Why this exists in addition to the URL-string check: a connection string
// can claim any path/database name, but what the server actually resolves
// the session's default database to can differ (aliasing, a proxy that
// rewrites the target, a misconfigured default-database override, etc.).
// The URL check alone is "does the request look safe"; this is "is the
// connection we actually got safe" - both must pass before any migration,
// reset, seed, or destructive test setup runs. See
// docs/INCIDENT_DAILY_CHECKIN_ROLLBACK.md and docs/TEST_INFRASTRUCTURE.md.
import { sql } from "drizzle-orm";
import { EXPECTED_TEST_DATABASE_NAME } from "./testDatabaseGuard";

/**
 * Minimal shape this needs from a drizzle db instance - just enough to run
 * one query. Kept structural (not importing MySql2Database) so this works
 * identically against server/test-helpers/testDb.ts's connection (used
 * inside the vitest process) and a standalone connection created directly
 * in a script like scripts/migrate-test-db.ts (a separate process).
 */
export interface ExecutableDb {
  execute(query: unknown): Promise<unknown>;
}

/**
 * Throws unless a live "SELECT DATABASE()" query against `db` returns
 * exactly "ipenovel_test". Returns the actual name on success (callers
 * generally don't need it, but it's useful for logging).
 */
export async function assertLiveTestDatabaseName(db: ExecutableDb): Promise<string> {
  const result: any = await db.execute(sql`SELECT DATABASE() AS name`);
  // mysql2-backed drizzle .execute() returns a [rows, fields] tuple for a
  // raw query; be defensive about the exact shape (matches the established
  // parsing style already used elsewhere in this repo's test files, e.g.
  // server/daily-checkin.test.ts).
  const rows = result?.[0] ?? result?.rows ?? result;
  const actual = rows?.[0]?.name;

  if (actual !== EXPECTED_TEST_DATABASE_NAME) {
    throw new Error(
      `Refusing to proceed: a live "SELECT DATABASE()" query against this connection returned ` +
        `"${actual ?? "(none)"}", not the required "${EXPECTED_TEST_DATABASE_NAME}". This check runs an actual ` +
        `query against the connected server, so it cannot be satisfied by a connection string that merely ` +
        `looks safe. Refusing to run any migration, reset, seed, or test setup against this connection.`
    );
  }

  return actual;
}
