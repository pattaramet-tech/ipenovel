#!/usr/bin/env node
// Safe production migration runner.
//
// Why this exists (see docs/DAILY_CHECKIN_DEPLOYMENT_FIX.md): the Phase 5
// deploy shipped code that queries the `dailyCheckins` table and
// `coupons.maxDiscountAmount` column, but nothing in the deploy pipeline
// ever ran `drizzle-kit migrate` (or equivalent) against the production
// database - `pnpm start` boots the server directly, and `db:push`
// (`drizzle-kit generate && drizzle-kit migrate`) is a manual,
// developer-invoked command that was never wired into deployment. This
// script is the fix: it runs ONLY already-committed migrations (never
// `generate` - generating a new migration during a deploy would be
// non-deterministic and is explicitly out of scope for a startup script),
// and is meant to run to completion BEFORE the server starts accepting
// traffic (see the `start` script in package.json: `node scripts/migrate.mjs
// && node dist/index.js` - the `&&` means a failed migration here stops the
// deploy instead of silently booting against a stale/partial schema).
//
// Deliberately implemented with drizzle-orm's programmatic migrator
// (`drizzle-orm/mysql2/migrator`) instead of shelling out to the
// `drizzle-kit` CLI: `drizzle-kit` is a devDependency (verified via
// package.json), so it is not guaranteed to be present wherever this runs
// in production, while `drizzle-orm` and `mysql2` are regular dependencies.
//
// Concurrency: if Manus (or any future host) starts multiple instances of
// this app at the same time, every instance's `pnpm start` would otherwise
// run this migration step concurrently. A MySQL named lock
// (GET_LOCK/RELEASE_LOCK, session-scoped to this script's single dedicated
// connection - never a pool) serializes that: only one instance actually
// executes the migration statements at a time, and every other instance
// waits for the lock, then finds nothing pending and returns immediately.
// A failure to acquire the lock within the timeout is treated as a hard
// failure (exit 1), not a silent skip - this script has no way to tell
// "another instance is legitimately migrating right now" apart from
// "something is stuck", so it fails loudly rather than guessing.

import mysql from "mysql2";
import { drizzle } from "drizzle-orm/mysql2";
import { migrate } from "drizzle-orm/mysql2/migrator";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Single shared sanitizer - see scripts/lib/safeErrorSummary.mjs for why
// drizzle's own error messages must never be logged verbatim (they embed
// the failing SQL and its bound parameters).
import { safeErrorSummary } from "./lib/safeErrorSummary.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.join(__dirname, "..", "drizzle");

const LOCK_NAME = "ipenovel_schema_migrations";
const LOCK_TIMEOUT_SECONDS = 60;

// Schema objects the running application hard-depends on. Verified
// read-only (information_schema, SELECT only - never user rows) after
// migrate() reports success, so a migration run that "succeeded" but left
// the schema incomplete still fails the deploy instead of letting the
// server boot and serve errors. See docs/DAILY_CHECKIN_DEPLOYMENT_FIX.md.
const REQUIRED_TABLES = [
  "dailyCheckins",
  "dailyCheckinCampaigns",
  "dailyCheckinCouponTemplates",
  "dailyCheckinRewardRules",
  "dailyCheckinRewardGrants",
];
const REQUIRED_COLUMNS = [{ table: "coupons", column: "maxDiscountAmount" }];
const REQUIRED_INDEXES = [
  { table: "dailyCheckins", index: "PRIMARY" },
  { table: "dailyCheckins", index: "unique_daily_checkin_user_date_campaign" },
  { table: "dailyCheckins", index: "unique_daily_checkins_coupon" },
  { table: "dailyCheckins", index: "dailyCheckins_userId_idx" },
];

/**
 * Read-only post-migration schema verification. Returns the names of any
 * missing objects (empty array = everything present).
 *
 * Every query is a plain information_schema SELECT scoped to DATABASE(),
 * with explicit column aliases so the result keys are stable across
 * MySQL 8 and TiDB (which differ in information_schema column casing).
 * No user table is read.
 */
async function findMissingSchemaObjects(conn) {
  const missing = [];

  const [tableRows] = await conn.query(
    `SELECT table_name AS name FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_name IN (${REQUIRED_TABLES.map(() => "?").join(",")})`,
    REQUIRED_TABLES
  );
  const presentTables = new Set((tableRows ?? []).map((row) => String(row.name)));
  for (const table of REQUIRED_TABLES) {
    if (!presentTables.has(table)) missing.push(`table ${table}`);
  }

  for (const { table, column } of REQUIRED_COLUMNS) {
    const [columnRows] = await conn.query(
      `SELECT column_name AS name FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
      [table, column]
    );
    if (!columnRows || columnRows.length === 0) missing.push(`column ${table}.${column}`);
  }

  for (const { table, index } of REQUIRED_INDEXES) {
    // An index on a missing table is already reported as a missing table -
    // don't report the same root cause twice.
    if (!presentTables.has(table)) continue;
    const [indexRows] = await conn.query(
      `SELECT DISTINCT index_name AS name FROM information_schema.statistics
       WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
      [table, index]
    );
    if (!indexRows || indexRows.length === 0) missing.push(`index ${table}.${index}`);
  }

  return missing;
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("[migrate] DATABASE_URL is not set - refusing to start without a known database to migrate.");
    process.exitCode = 1;
    return;
  }

  let connection;
  try {
    connection = mysql.createConnection(databaseUrl);
  } catch (error) {
    console.error("[migrate] Failed to create a database connection:", safeErrorSummary(error));
    process.exitCode = 1;
    return;
  }
  const conn = connection.promise();

  let lockAcquired = false;
  try {
    console.log(
      `[migrate] Acquiring migration lock "${LOCK_NAME}" (timeout ${LOCK_TIMEOUT_SECONDS}s) - ` +
        "safe if multiple instances start at the same time, only one will actually migrate..."
    );
    const [lockRows] = await conn.query("SELECT GET_LOCK(?, ?) AS acquired", [LOCK_NAME, LOCK_TIMEOUT_SECONDS]);
    const acquired = lockRows?.[0]?.acquired;
    if (acquired !== 1) {
      // 0 = timed out waiting for another holder, NULL = error acquiring.
      // Either way: never proceed without the lock - two concurrent
      // migration runs against DDL is exactly the race this exists to
      // prevent.
      throw new Error(
        `Could not acquire the migration lock within ${LOCK_TIMEOUT_SECONDS}s (GET_LOCK returned ${acquired}). ` +
          "Another instance may be migrating or stuck."
      );
    }
    lockAcquired = true;
    console.log("[migrate] Lock acquired. Running pending migrations (existing, committed migration files only)...");

    const db = drizzle({ client: connection });
    await migrate(db, { migrationsFolder });

    // migrate() returning is not sufficient proof the schema is usable -
    // verify the objects the application actually queries really exist
    // before reporting success (and therefore before the server is allowed
    // to open a port).
    console.log("[migrate] Verifying required schema objects (read-only)...");
    const missing = await findMissingSchemaObjects(conn);
    if (missing.length > 0) {
      // Only the object names - never the query, the schema name, or any row.
      console.error(`[migrate] Migration failed: schema verification found missing object(s): ${missing.join(", ")}`);
      process.exitCode = 1;
      return;
    }

    console.log("[migrate] Done - schema is up to date.");
  } catch (error) {
    // Never swallow this - a failed migration must stop the deploy, not
    // let the app boot against a stale/partial schema.
    console.error("[migrate] Migration failed:", safeErrorSummary(error));
    process.exitCode = 1;
  } finally {
    if (lockAcquired) {
      try {
        await conn.query("SELECT RELEASE_LOCK(?)", [LOCK_NAME]);
      } catch (releaseError) {
        console.warn("[migrate] Failed to release the migration lock (non-fatal):", safeErrorSummary(releaseError));
      }
    }
    await conn.end().catch(() => {});
  }
}

main().then(() => {
  process.exit(process.exitCode ?? 0);
});
