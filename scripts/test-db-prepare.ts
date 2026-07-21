#!/usr/bin/env node
// `pnpm test:db:prepare` - the single sanctioned way to bring the
// disposable test database to a clean, migrated baseline before an
// integration test run. Per the recovery task's explicit spec:
//
//   - Reads only TEST_DATABASE_URL.
//   - Runs the strict safety guard first (connection-string check).
//   - Verifies a live "SELECT DATABASE()" equals exactly "ipenovel_test".
//   - Applies all committed migrations to the test database.
//   - Resets/seeds only the disposable test database.
//   - Fails closed if TEST_DATABASE_URL is missing or unsafe.
//
// Never touches process.env.DATABASE_URL, never spawns scripts/migrate.mjs
// (the production runner) - uses the dedicated scripts/migrate-test-db.ts
// in-process instead. Connects via buildTestDbConnectionOptions() (TLS
// required) rather than a plain TEST_DATABASE_URL string - see
// server/test-helpers/testDbConnectionOptions.ts.
//
// Connection lifecycle note: this script was observed to print its final
// "Done" log and then never exit. The reset connection was opened via
// callback-style `mysql2` (`mysql.createConnection`), wrapped in a second,
// separate promise facade via `.promise()` for drizzle, and closed with
// `await connection.promise().end().catch(() => {})` - a close failure (or
// a close that simply never settled) was silently swallowed, so neither a
// hang nor a real error could ever be diagnosed. This now uses a single
// `mysql2/promise` connection throughout (no callback/promise wrapper
// mismatch - see drizzle-orm/mysql2's own driver typings, which accept a
// native mysql2/promise Connection directly), and closes it via
// closeMysqlConnectionSafely() (bounded timeout, forced destroy() as a
// last resort, and a loud, sanitized error on any close failure - never a
// silently swallowed one).
import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import { redactDatabaseUrl } from "../server/test-helpers/testDatabaseGuard";
import { assertLiveTestDatabaseName } from "../server/test-helpers/liveTestDatabaseCheck";
import { buildTestDbConnectionOptions } from "../server/test-helpers/testDbConnectionOptions";
import { resetTestDatabase } from "../server/test-helpers/resetTestDatabase";
import { runTestDbMigration } from "./migrate-test-db";
import { closeMysqlConnectionSafely } from "../server/test-helpers/closeMysqlConnectionSafely";

// Opt-in only - off by default, and even when enabled this only ever logs
// fixed lifecycle marker strings and the public resource TYPE strings from
// process.getActiveResourcesInfo(), never credentials, URLs, hosts, IP
// addresses, query text, or raw connection/handle objects.
const DIAGNOSTICS_ENABLED = process.env.IPENOVEL_TEST_DB_DIAGNOSTICS === "1";

function logDiagnostic(marker: string): void {
  if (!DIAGNOSTICS_ENABLED) return;
  console.log(`[test:db:prepare][diagnostics] ${marker}`);
}

/**
 * Reports only the resource TYPE strings from the public, documented
 * process.getActiveResourcesInfo() API (e.g. "TCPSOCKETWRAP", "Timeout") -
 * never process._getActiveHandles() (a private/undocumented Node API) and
 * never a raw handle/object of any kind.
 */
function logActiveResources(): void {
  if (!DIAGNOSTICS_ENABLED) return;
  try {
    const resourceTypes: string[] =
      typeof (process as any).getActiveResourcesInfo === "function" ? (process as any).getActiveResourcesInfo() : [];
    console.log(`[test:db:prepare][diagnostics] remaining active resource types: ${JSON.stringify(resourceTypes)}`);
  } catch (error) {
    console.log(
      `[test:db:prepare][diagnostics] failed to read active resources (non-fatal): ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

async function main() {
  const testUrl = process.env.TEST_DATABASE_URL;

  // 1. Fail closed on a missing/unsafe connection string.
  // buildTestDbConnectionOptions() runs assertSafeTestDatabaseUrl internally.
  const options = buildTestDbConnectionOptions(testUrl);
  console.log(`[test:db:prepare] Connection string validated: ${redactDatabaseUrl(testUrl)}`);

  // 2. Apply migrations (this also independently re-verifies the live
  // "SELECT DATABASE()" check via its own connection - see
  // scripts/migrate-test-db.ts - so schema changes never run before that
  // check passes).
  await runTestDbMigration();

  // 3. Reset/seed - a separate, short-lived connection, re-verified live
  // one more time immediately before any DELETE runs. Never reuses a
  // connection from an earlier step without re-checking: each step here is
  // independently safe even if run alone.
  const connection = await mysql.createConnection(options);
  logDiagnostic("reset connection created");
  const db = drizzle({ client: connection });
  let primaryError: unknown;
  try {
    await assertLiveTestDatabaseName(db);
    console.log("[test:db:prepare] Resetting test database to an empty baseline...");
    await resetTestDatabase(db);
    console.log("[test:db:prepare] Done - test database is migrated and reset.");
    logDiagnostic("reset completed");
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    logDiagnostic("reset connection close started");
    await closeMysqlConnectionSafely(connection, { primaryError });
    logDiagnostic("reset connection close completed");
  }
}

main()
  .then(() => {
    logDiagnostic("main resolved");
    logActiveResources();
  })
  .catch((error) => {
    console.error(`[test:db:prepare] ${error?.message || error}`);
    // Setting exitCode (not calling process.exit()) lets Node exit
    // naturally once the event loop is actually empty - an explicit
    // process.exit() here would hide a leaked handle instead of surfacing
    // it, and could cut off buffered log output.
    process.exitCode = 1;
  });
