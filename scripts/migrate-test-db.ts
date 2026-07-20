#!/usr/bin/env node
// Dedicated migration runner for the disposable test database. This is a
// SEPARATE script from scripts/migrate.mjs (the production runner) on
// purpose - see docs/INCIDENT_DAILY_CHECKIN_ROLLBACK.md's "Test setup"
// section and the recovery task's explicit instruction: "Do not implement
// test migrations by temporarily assigning TEST_DATABASE_URL to
// DATABASE_URL ... Prefer a dedicated migration runner that directly
// consumes TEST_DATABASE_URL."
//
// This script:
//   1. Reads TEST_DATABASE_URL only - never DATABASE_URL, never falls back.
//   2. Runs the same connection-string safety guard used everywhere else
//      (server/test-helpers/testDatabaseGuard.ts).
//   3. Opens its OWN connection built from buildTestDbConnectionOptions()
//      (TLS required, never a plain TEST_DATABASE_URL string), then runs a
//      live "SELECT DATABASE()" check
//      (server/test-helpers/liveTestDatabaseCheck.ts) and refuses to
//      proceed unless it is exactly "ipenovel_test".
//   4. Only after both checks pass, applies already-committed migrations
//      via server/test-helpers/migrateTestDbWithLogging.ts - a logged
//      reimplementation of drizzle-orm's exact resume/skip semantics
//      (never `drizzle-kit generate`) that reports which migration tag is
//      being attempted/completed/failed. Production (scripts/migrate.mjs)
//      is unchanged and still uses drizzle-orm's own opaque migrate().
//   5. Uses the same GET_LOCK/RELEASE_LOCK pattern as scripts/migrate.mjs so
//      two concurrent test:db:prepare runs against the same test database
//      can't race on DDL.
//
// process.env.DATABASE_URL is never read or written anywhere in this file.
// See server/test-helpers/testDbConnectionOptions.ts for why a plain
// `mysql.createConnection(testUrl!)` (no TLS options) is exactly the bug
// class this file previously had - it failed against a real TiDB Cloud
// test database with "Connections using insecure transport are prohibited".
import mysql from "mysql2";
import { drizzle } from "drizzle-orm/mysql2";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { redactDatabaseUrl } from "../server/test-helpers/testDatabaseGuard";
import { assertLiveTestDatabaseName } from "../server/test-helpers/liveTestDatabaseCheck";
import { buildTestDbConnectionOptions } from "../server/test-helpers/testDbConnectionOptions";
import { runMigrationsWithLogging, consoleMigrationLogger } from "../server/test-helpers/migrateTestDbWithLogging";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.join(__dirname, "..", "drizzle");

const LOCK_NAME = "ipenovel_test_schema_migrations";
const LOCK_TIMEOUT_SECONDS = 60;

function safeErrorSummary(error: any): string {
  if (!error) return "unknown error";
  const parts: string[] = [];
  if (error.code) parts.push(`code=${error.code}`);
  if (error.errno) parts.push(`errno=${error.errno}`);
  if (error.sqlState) parts.push(`sqlState=${error.sqlState}`);
  if (error.message) parts.push(`message=${String(error.message).slice(0, 300)}`);
  return parts.length > 0 ? parts.join(" ") : "unknown error";
}

/**
 * Runs the full validate -> connect -> verify -> migrate flow against
 * TEST_DATABASE_URL. Exported (not just a CLI) so scripts/test-db-prepare.ts
 * can call it in-process without spawning a child process or touching any
 * environment variable.
 */
export async function runTestDbMigration(): Promise<void> {
  const testUrl = process.env.TEST_DATABASE_URL;

  // Fail closed: missing or unsafe TEST_DATABASE_URL never falls back to
  // anything else, and never proceeds. buildTestDbConnectionOptions() runs
  // the same assertSafeTestDatabaseUrl gate internally before returning
  // anything.
  const options = buildTestDbConnectionOptions(testUrl);
  console.log(`[migrate-test-db] Connection string validated: ${redactDatabaseUrl(testUrl)}`);

  let connection: ReturnType<typeof mysql.createConnection>;
  try {
    connection = mysql.createConnection(options);
  } catch (error) {
    throw new Error(`[migrate-test-db] Failed to create a database connection: ${safeErrorSummary(error)}`);
  }
  const conn = connection.promise();
  const db = drizzle({ client: connection });

  let lockAcquired = false;
  try {
    // Live check FIRST, before anything that could touch schema/data -
    // this is the "reject unless SELECT DATABASE() returns exactly
    // ipenovel_test" requirement, verified against the actual connection,
    // not just the URL string already checked above.
    const actualName = await assertLiveTestDatabaseName(db);
    console.log(`[migrate-test-db] Live check passed - connected database is "${actualName}".`);

    console.log(`[migrate-test-db] Acquiring migration lock "${LOCK_NAME}" (timeout ${LOCK_TIMEOUT_SECONDS}s)...`);
    const [lockRows]: any = await conn.query("SELECT GET_LOCK(?, ?) AS acquired", [LOCK_NAME, LOCK_TIMEOUT_SECONDS]);
    const acquired = lockRows?.[0]?.acquired;
    if (acquired !== 1) {
      throw new Error(`Could not acquire the test migration lock within ${LOCK_TIMEOUT_SECONDS}s (GET_LOCK returned ${acquired}).`);
    }
    lockAcquired = true;

    console.log("[migrate-test-db] Lock acquired. Applying committed migrations...");
    await runMigrationsWithLogging(conn, migrationsFolder, consoleMigrationLogger("[migrate-test-db]"));
    console.log("[migrate-test-db] Done - test database schema is up to date.");
  } finally {
    if (lockAcquired) {
      try {
        await conn.query("SELECT RELEASE_LOCK(?)", [LOCK_NAME]);
      } catch (releaseError) {
        console.warn("[migrate-test-db] Failed to release the migration lock (non-fatal):", safeErrorSummary(releaseError));
      }
    }
    await conn.end().catch(() => {});
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runTestDbMigration()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(safeErrorSummary(error) === "unknown error" ? error : `[migrate-test-db] ${safeErrorSummary(error)}`);
      process.exit(1);
    });
}
