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
// in-process instead.
import { drizzle } from "drizzle-orm/mysql2";
import { assertSafeTestDatabaseUrl, redactDatabaseUrl } from "../server/test-helpers/testDatabaseGuard";
import { assertLiveTestDatabaseName } from "../server/test-helpers/liveTestDatabaseCheck";
import { resetTestDatabase } from "../server/test-helpers/resetTestDatabase";
import { runTestDbMigration } from "./migrate-test-db";

async function main() {
  const testUrl = process.env.TEST_DATABASE_URL;

  // 1. Fail closed on a missing/unsafe connection string.
  assertSafeTestDatabaseUrl(testUrl);
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
  const db = drizzle(testUrl!);
  try {
    await assertLiveTestDatabaseName(db);
    console.log("[test:db:prepare] Resetting test database to an empty baseline...");
    await resetTestDatabase(db);
    console.log("[test:db:prepare] Done - test database is migrated and reset.");
  } finally {
    await (db as any).$client?.end?.().catch(() => {});
  }
}

main().catch((error) => {
  console.error(`[test:db:prepare] ${error?.message || error}`);
  process.exit(1);
});
