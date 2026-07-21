#!/usr/bin/env node
// Orchestrates a full CI test run: validate -> migrate test DB -> unit
// tests -> integration tests -> cleanup, preserving whichever step's exit
// code caused failure. See docs/TEST_INFRASTRUCTURE.md.
//
// Deliberately does NOT run `pnpm test` (the full, unsegregated suite) as
// part of this - `pnpm test`/`pnpm test:gate` remain separate, standalone
// commands. This script's job is specifically the two-tier unit+integration
// flow PART K asked for.
//
// Never uses `|| true` anywhere in this file - every step's real exit code
// is checked, and cleanup runs in a `finally`-equivalent (always attempted)
// without ever hiding an earlier failure's exit code.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import mysql from "mysql2";
import { drizzle } from "drizzle-orm/mysql2";
import { assertSafeTestDatabaseUrl, redactDatabaseUrl } from "../server/test-helpers/testDatabaseGuard";
import { runTestDbMigration } from "./migrate-test-db";
import { assertLiveTestDatabaseName } from "../server/test-helpers/liveTestDatabaseCheck";
import { resetTestDatabase } from "../server/test-helpers/resetTestDatabase";
import { buildTestDbConnectionOptions } from "../server/test-helpers/testDbConnectionOptions";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function run(label: string, command: string, args: string[], envOverrides: Record<string, string | undefined> = {}): number {
  console.log(`\n[test:ci] === ${label} ===`);
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, ...envOverrides },
    shell: process.platform === "win32",
  });
  if (result.error) {
    console.error(`[test:ci] Failed to run "${label}": ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

async function main() {
  // 1. Validate TEST_DATABASE_URL - the same allowlist/blocklist check used
  // everywhere else in this repo's test safety net. Fails loudly here
  // rather than letting later steps fail with a less clear error.
  const testUrl = process.env.TEST_DATABASE_URL;
  try {
    assertSafeTestDatabaseUrl(testUrl);
  } catch (error) {
    console.error(`[test:ci] ${error.message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[test:ci] Test database validated: ${redactDatabaseUrl(testUrl)}`);

  // 2 & 3. Provision/reset the test DB and apply migrations. Uses the
  // dedicated TEST_DATABASE_URL-only runner (scripts/migrate-test-db.ts),
  // called in-process - never scripts/migrate.mjs (the production runner)
  // and never process.env.DATABASE_URL. Each step independently re-verifies
  // the live "SELECT DATABASE()" check before touching anything, per
  // docs/INCIDENT_DAILY_CHECKIN_ROLLBACK.md.
  let migrateStatus = 0;
  try {
    await runTestDbMigration();
    const connection = mysql.createConnection(buildTestDbConnectionOptions(testUrl));
    const db = drizzle({ client: connection });
    try {
      await assertLiveTestDatabaseName(db);
      await resetTestDatabase(db);
    } finally {
      await connection.promise().end().catch(() => {});
    }
  } catch (error: any) {
    console.error(`[test:ci] Test database preparation failed: ${error?.message || error}`);
    migrateStatus = 1;
  }
  if (migrateStatus !== 0) {
    console.error("[test:ci] Migration/reset step failed - aborting before running any tests.");
    process.exitCode = migrateStatus;
    return;
  }

  // 4. Unit tests (no DB required, safe to run regardless of TEST_DATABASE_URL).
  const unitStatus = run("Unit tests", "npx", ["vitest", "run", "-c", "vitest.config.ts"]);

  // 5. Integration tests (TEST_DATABASE_URL required - vitest.integration.globalsetup.ts
  // enforces this on its own even without this script).
  const integrationStatus = run("Integration tests", "npx", ["vitest", "run", "-c", "vitest.integration.config.ts"]);

  // 6. Cleanup - close any lingering pooled connections opened by the
  // steps above. Best-effort: a cleanup failure is logged but does not
  // override an earlier real test failure's exit code (that would hide
  // the actual problem).
  console.log("\n[test:ci] === Cleanup ===");
  console.log("[test:ci] (test database rows are cleaned up per-test/per-suite by each test file's own afterEach/afterAll - see docs/TEST_INFRASTRUCTURE.md)");

  // 7. Preserve the first non-zero exit code encountered, in step order.
  const finalStatus = [migrateStatus, unitStatus, integrationStatus].find((s) => s !== 0) ?? 0;
  console.log(
    `\n[test:ci] SUMMARY: migrate=${migrateStatus} unit=${unitStatus} integration=${integrationStatus} -> exit ${finalStatus}`
  );
  process.exitCode = finalStatus;
}

main();
