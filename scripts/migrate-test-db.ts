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
import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { redactDatabaseUrl } from "../server/test-helpers/testDatabaseGuard";
import { assertLiveTestDatabaseName } from "../server/test-helpers/liveTestDatabaseCheck";
import { buildTestDbConnectionOptions } from "../server/test-helpers/testDbConnectionOptions";
import { runMigrationsWithLogging, consoleMigrationLogger } from "../server/test-helpers/migrateTestDbWithLogging";
import { closeMysqlConnectionSafely } from "../server/test-helpers/closeMysqlConnectionSafely";
import { createDiagnosticLogger, logActiveResourceSnapshot } from "../server/test-helpers/testDbDiagnostics";

const logDiagnostic = createDiagnosticLogger("[migrate-test-db]");

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

  let connection: Awaited<ReturnType<typeof mysql.createConnection>>;
  try {
    logActiveResourceSnapshot(logDiagnostic, "before migration connection creation");
    connection = await mysql.createConnection(options);
    logDiagnostic("migration connection created");
    logActiveResourceSnapshot(logDiagnostic, "after migration connection creation");
  } catch (error) {
    throw new Error(`[migrate-test-db] Failed to create a database connection: ${safeErrorSummary(error)}`);
  }
  const db = drizzle({ client: connection });

  let lockAcquired = false;
  let primaryError: unknown;
  try {
    // Live check FIRST, before anything that could touch schema/data -
    // this is the "reject unless SELECT DATABASE() returns exactly
    // ipenovel_test" requirement, verified against the actual connection,
    // not just the URL string already checked above.
    const actualName = await assertLiveTestDatabaseName(db);
    console.log(`[migrate-test-db] Live check passed - connected database is "${actualName}".`);

    console.log(`[migrate-test-db] Acquiring migration lock "${LOCK_NAME}" (timeout ${LOCK_TIMEOUT_SECONDS}s)...`);
    const [lockRows]: any = await connection.query("SELECT GET_LOCK(?, ?) AS acquired", [LOCK_NAME, LOCK_TIMEOUT_SECONDS]);
    const acquired = lockRows?.[0]?.acquired;
    if (acquired !== 1) {
      throw new Error(`Could not acquire the test migration lock within ${LOCK_TIMEOUT_SECONDS}s (GET_LOCK returned ${acquired}).`);
    }
    lockAcquired = true;

    console.log("[migrate-test-db] Lock acquired. Applying committed migrations...");
    await runMigrationsWithLogging(connection, migrationsFolder, consoleMigrationLogger("[migrate-test-db]"));
    console.log("[migrate-test-db] Done - test database schema is up to date.");
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (lockAcquired) {
      logDiagnostic("migration lock release started");
      try {
        const [releaseRows]: any = await connection.query("SELECT RELEASE_LOCK(?) AS released", [LOCK_NAME]);
        const released = releaseRows?.[0]?.released;
        // RELEASE_LOCK() returns 1 on real success, 0 if this session did
        // not hold the lock, or NULL if the named lock did not exist -
        // only 1 is ever reported as a successful release; anything else
        // is a (non-fatal) warning, never a false "completed" marker.
        if (released === 1) {
          logDiagnostic("migration lock release completed");
        } else {
          console.warn(
            `[migrate-test-db] Migration lock release did not report success (non-fatal): RELEASE_LOCK returned ${released}`
          );
        }
      } catch (releaseError) {
        console.warn("[migrate-test-db] Failed to release the migration lock (non-fatal):", safeErrorSummary(releaseError));
      }
    }
    logDiagnostic("migration connection close started");
    await closeMysqlConnectionSafely(connection, { primaryError });
    logDiagnostic("migration connection close completed");
    logActiveResourceSnapshot(logDiagnostic, "after migration connection close");
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  // No explicit success handler, and no process.exit() anywhere here -
  // an explicit process.exit(0) on success would hide a leaked handle
  // instead of surfacing it (the exact bug class this whole file's
  // connection-closing logic exists to fix - see closeMysqlConnectionSafely
  // above). Node exits naturally once the event loop is actually empty.
  // On failure, only process.exitCode is set - the process still only
  // terminates once everything it owns (including this run's connection,
  // closed in the finally block above) has actually finished.
  runTestDbMigration().catch((error) => {
    console.error(safeErrorSummary(error) === "unknown error" ? error : `[migrate-test-db] ${safeErrorSummary(error)}`);
    process.exitCode = 1;
  });
}
