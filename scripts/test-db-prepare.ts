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
// "Done" log and then never exit, even after a first fix that closed the
// reset connection via closeMysqlConnectionSafely() and treated a resolved
// `end()` as complete shutdown. A real Gate A run proved that insufficient:
// diagnostics showed "reset connection close completed" logged, yet the
// process stayed alive for ~210s with TCPSocketWrap/PipeWrap handles still
// active. Reading the installed mysql2 3.22.5 source (see
// server/test-helpers/closeMysqlConnectionSafely.ts's own header for the
// full analysis) showed why: `end()` resolves as soon as the QUIT command
// is dispatched from mysql2's internal command queue - well before the
// underlying socket actually finishes closing. closeMysqlConnectionSafely()
// now requires BOTH `end()` to resolve AND the connection's own public
// `'end'` event (the real transport-closed signal) to fire before treating
// a close as genuinely complete.
import mysql from "mysql2/promise";
import { drizzle } from "drizzle-orm/mysql2";
import { redactDatabaseUrl } from "../server/test-helpers/testDatabaseGuard";
import { assertLiveTestDatabaseName } from "../server/test-helpers/liveTestDatabaseCheck";
import { buildTestDbConnectionOptions } from "../server/test-helpers/testDbConnectionOptions";
import { resetTestDatabase } from "../server/test-helpers/resetTestDatabase";
import { runTestDbMigration } from "./migrate-test-db";
import { closeMysqlConnectionSafely } from "../server/test-helpers/closeMysqlConnectionSafely";
import {
  createDiagnosticLogger,
  isDiagnosticsEnabled,
  logActiveResourceSnapshot,
  waitForDiagnosticSettlement,
  waitOneEventLoopTurn,
} from "../server/test-helpers/testDbDiagnostics";

// Opt-in only - off by default (IPENOVEL_TEST_DB_DIAGNOSTICS=1), and even
// when enabled this only ever logs fixed lifecycle marker strings and the
// public resource TYPE names/counts from process.getActiveResourcesInfo(),
// never credentials, URLs, hosts, IP addresses, query text, caught-error
// text, or raw connection/handle objects. See
// server/test-helpers/testDbDiagnostics.ts for the shared implementation
// (also used by scripts/migrate-test-db.ts).
const logDiagnostic = createDiagnosticLogger("[test:db:prepare]");

async function main() {
  const testUrl = process.env.TEST_DATABASE_URL;

  // 1. Fail closed on a missing/unsafe connection string.
  // buildTestDbConnectionOptions() runs assertSafeTestDatabaseUrl internally.
  const options = buildTestDbConnectionOptions(testUrl);
  console.log(`[test:db:prepare] Connection string validated: ${redactDatabaseUrl(testUrl)}`);

  // 2. Apply migrations (this also independently re-verifies the live
  // "SELECT DATABASE()" check via its own connection - see
  // scripts/migrate-test-db.ts - so schema changes never run before that
  // check passes). Its own connection's create/close diagnostics and
  // resource snapshots are logged from within that module.
  await runTestDbMigration();

  // 3. Reset/seed - a separate, short-lived connection, re-verified live
  // one more time immediately before any DELETE runs. Never reuses a
  // connection from an earlier step without re-checking: each step here is
  // independently safe even if run alone.
  const connection = await mysql.createConnection(options);
  logDiagnostic("reset connection created");
  logActiveResourceSnapshot(logDiagnostic, "after reset connection creation");
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
    logActiveResourceSnapshot(logDiagnostic, "after reset connection close");
  }
}

main()
  .then(async () => {
    logDiagnostic("main resolved");
    logActiveResourceSnapshot(logDiagnostic, "immediately after main resolves");

    // The event-loop-turn/settlement-delay snapshots exist purely to
    // observe whether resources are STILL active slightly after main()
    // resolves - they must never run (and never cost anything) unless
    // diagnostics are explicitly enabled; they never gate or delay normal
    // process exit on a real (non-diagnostic) run.
    if (isDiagnosticsEnabled()) {
      await waitOneEventLoopTurn();
      logActiveResourceSnapshot(logDiagnostic, "after one completed event-loop turn");

      await waitForDiagnosticSettlement();
      logActiveResourceSnapshot(logDiagnostic, "after diagnostic settlement delay");
    }
  })
  .catch((error) => {
    console.error(`[test:db:prepare] ${error?.message || error}`);
    // Setting exitCode (not calling process.exit()) lets Node exit
    // naturally once the event loop is actually empty - an explicit
    // process.exit() here would hide a leaked handle instead of surfacing
    // it, and could cut off buffered log output.
    process.exitCode = 1;
  });
