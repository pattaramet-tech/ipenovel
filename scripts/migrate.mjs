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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.join(__dirname, "..", "drizzle");

const LOCK_NAME = "ipenovel_schema_migrations";
const LOCK_TIMEOUT_SECONDS = 60;

// Never log a raw error object or its .sql/.config - those can echo back
// query text or connection details. Only the small set of fields mysql2
// populates for diagnosing a failure, nothing else.
function safeErrorSummary(error) {
  if (!error) return "unknown error";
  const parts = [];
  if (error.code) parts.push(`code=${error.code}`);
  if (error.errno) parts.push(`errno=${error.errno}`);
  if (error.sqlState) parts.push(`sqlState=${error.sqlState}`);
  if (error.message) parts.push(`message=${String(error.message).slice(0, 300)}`);
  return parts.length > 0 ? parts.join(" ") : "unknown error";
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
