import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import mysql from "mysql2/promise";
import { buildTestDbConnectionOptions } from "../test-helpers/testDbConnectionOptions";
import { EXPECTED_TEST_DATABASE_NAME } from "../test-helpers/testDatabaseGuard";
import { closeMysqlConnectionSafely } from "../test-helpers/closeMysqlConnectionSafely";
import { readMigrationJournal } from "../test-helpers/migrateTestDbWithLogging";

/**
 * Tests 1 and 2 - the built executable, started exactly the way the hosting
 * platform started it during the incident (`node dist/index.js`, bypassing
 * package.json), must migrate a database that is stuck at migration 0023 up
 * to head and verify the schema BEFORE it opens a port.
 *
 * Database safety: this file only ever uses TEST_DATABASE_URL, which
 * buildTestDbConnectionOptions gates on the database name being exactly
 * "ipenovel_test" (plus TLS 1.2+ with rejectUnauthorized). Before anything
 * destructive runs, a live `SELECT DATABASE()` re-confirms the same name.
 * The disposable URL is passed to the child as DATABASE_URL because that is
 * the variable the server reads - it is never sourced from the ambient
 * DATABASE_URL, which is explicitly blanked for the child.
 */

const repoRoot = path.resolve(__dirname, "..", "..");
const distEntry = path.join(repoRoot, "dist", "index.js");
const migrationsFolder = path.join(repoRoot, "drizzle");

/** Production's confirmed high-water mark: migration 0023. */
const MIGRATION_0023_WHEN = 1783506394802;

const REQUIRED_TABLES = [
  "dailyCheckins",
  "dailyCheckinCampaigns",
  "dailyCheckinCouponTemplates",
  "dailyCheckinRewardRules",
  "dailyCheckinRewardGrants",
];

const hasTestDb = Boolean(process.env.TEST_DATABASE_URL);
const hasBuild = fs.existsSync(distEntry);

async function connect(): Promise<mysql.Connection> {
  return mysql.createConnection(buildTestDbConnectionOptions(process.env.TEST_DATABASE_URL));
}

async function assertLiveTestDatabase(conn: mysql.Connection): Promise<void> {
  const [rows]: any = await conn.query("SELECT DATABASE() AS name");
  expect(rows?.[0]?.name).toBe(EXPECTED_TEST_DATABASE_NAME);
}

async function tableExists(conn: mysql.Connection, table: string): Promise<boolean> {
  const [rows]: any = await conn.query(
    `SELECT COUNT(*) AS cnt FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?`,
    [table]
  );
  return Number(rows[0].cnt) > 0;
}

async function columnExists(conn: mysql.Connection, table: string, column: string): Promise<boolean> {
  const [rows]: any = await conn.query(
    `SELECT COUNT(*) AS cnt FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [table, column]
  );
  return Number(rows[0].cnt) > 0;
}

async function latestRecordedMigration(conn: mysql.Connection): Promise<number | null> {
  const [rows]: any = await conn.query(
    "SELECT created_at AS createdAt FROM `__drizzle_migrations` ORDER BY created_at DESC LIMIT 1"
  );
  return rows[0] ? Number(rows[0].createdAt) : null;
}

/** Rewinds the disposable database to the confirmed production state: history at 0023, none of 0024-0029's objects present. */
async function rewindToMigration0023(conn: mysql.Connection): Promise<void> {
  await assertLiveTestDatabase(conn);

  await conn.query("DELETE FROM `__drizzle_migrations` WHERE created_at > ?", [MIGRATION_0023_WHEN]);
  for (const table of [...REQUIRED_TABLES].reverse()) {
    await conn.query(`DROP TABLE IF EXISTS \`${table}\``);
  }
  if (await columnExists(conn, "coupons", "maxDiscountAmount")) {
    await conn.query("ALTER TABLE `coupons` DROP COLUMN `maxDiscountAmount`");
  }
}

interface ServerRun {
  output: string;
  started: boolean;
  exitCode: number | null;
}

/**
 * Starts the built executable against the disposable database, waits for it
 * to either announce it is listening or exit, terminates it, and only
 * resolves once the OS process has actually closed.
 *
 * The previous version called child.kill("SIGKILL") and resolved
 * immediately afterward, without waiting for the real 'close' event. A
 * signal being SENT is not the same as the process having actually exited -
 * killing it does not synchronously tear down its held resources, most
 * importantly the migration advisory lock (GET_LOCK('ipenovel_schema_migrations',
 * ...) in scripts/migrate.mjs) tied to the child's own dedicated DB
 * connection. A SIGKILL'd process cannot run its own `finally` block to call
 * RELEASE_LOCK, so the lock is only actually freed once MySQL/MariaDB itself
 * notices the underlying TCP connection is gone - normally near-instant once
 * the OS closes the socket during process teardown, but not guaranteed to
 * have already happened at the instant `.kill()` returns. Resolving before
 * `close` fires let the next test (or the next `test:db:prepare` run)
 * occasionally start racing that teardown, which is the exact "advisory-lock
 * still held" flakiness this rewrite exists to eliminate - not via a fixed
 * sleep or a blind retry, but by never resolving until the OS confirms the
 * process, and therefore its DB connection, is actually gone.
 */
function startBuiltServer(port: number, timeoutMs = 180000): Promise<ServerRun> {
  return new Promise((resolveOuter) => {
    const child = spawn(process.execPath, [distEntry], {
      cwd: repoRoot,
      env: {
        ...process.env,
        // The disposable test database, and only that.
        DATABASE_URL: process.env.TEST_DATABASE_URL,
        NODE_ENV: "production",
        PORT: String(port),
      },
    });

    let output = "";
    let startedDetected = false;
    let terminationStarted = false;

    const beginTermination = () => {
      if (terminationStarted) return;
      terminationStarted = true;
      clearTimeout(timer);
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      // Deliberately no resolve() here - only the 'close' handler below
      // resolves the outer promise, once the OS confirms the process (and
      // the migration-lock-holding DB connection it owned) is actually gone.
    };

    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (!startedDetected && output.includes("Server running")) {
        startedDetected = true;
        beginTermination();
      }
    };

    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    child.on("close", (code) => {
      clearTimeout(timer);
      // Explicitly detach - stdout/stderr going away with the process would
      // clean these up anyway, but this makes the intent unambiguous rather
      // than relying on GC to eventually collect the closure.
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      resolveOuter({ output, started: startedDetected || output.includes("Server running"), exitCode: code });
    });

    const timer = setTimeout(() => beginTermination(), timeoutMs);
  });
}

/**
 * Polls IS_FREE_LOCK for the migration advisory lock until it reports free,
 * rather than assuming `startBuiltServer`'s resolution (the OS process
 * having closed) is instantaneously sufficient. Bounded by attempts, not a
 * blind sleep - fails loudly with the exact last-seen state if the lock is
 * never actually released, rather than silently proceeding into a test that
 * would then race it.
 */
async function waitForMigrationLockReleased(conn: mysql.Connection, maxAttempts = 100): Promise<void> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const [rows]: any = await conn.query("SELECT IS_FREE_LOCK('ipenovel_schema_migrations') AS free");
    if (Number(rows[0]?.free) === 1) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(
    `Migration advisory lock "ipenovel_schema_migrations" was still held after ${maxAttempts} polls - ` +
      "a prior startBuiltServer() child process may not have released it."
  );
}

describe.skipIf(!hasTestDb || !hasBuild).sequential(
  "Tests 1 & 2 - `node dist/index.js` migrates a 0023 database before listening",
  () => {
    it("Test 1: applies 0024-0029, creates the daily check-in schema, and only then starts the server", async () => {
      const conn = await connect();
      try {
        await rewindToMigration0023(conn);

        // Precondition: the exact confirmed production state.
        expect(await latestRecordedMigration(conn)).toBe(MIGRATION_0023_WHEN);
        expect(await tableExists(conn, "dailyCheckins")).toBe(false);
        expect(await columnExists(conn, "coupons", "maxDiscountAmount")).toBe(false);

        const run = await startBuiltServer(41731);
        // Belt-and-suspenders on top of startBuiltServer already awaiting
        // the child's real 'close' event: explicitly confirm the migration
        // advisory lock the child's own DB connection held is free before
        // this test's own connection (or the next test) touches it.
        await waitForMigrationLockReleased(conn);

        expect(run.started).toBe(true);
        // Migration output must precede the listening announcement.
        const migrateIndex = run.output.indexOf("[startup] Running database migrations");
        const doneIndex = run.output.indexOf("[migrate] Done - schema is up to date");
        const runningIndex = run.output.indexOf("Server running");
        expect(migrateIndex).toBeGreaterThan(-1);
        expect(doneIndex).toBeGreaterThan(migrateIndex);
        expect(runningIndex).toBeGreaterThan(doneIndex);

        // Every pending migration ran, in journal order, up to head.
        const journal = readMigrationJournal(migrationsFolder);
        const head = Math.max(...journal.map((entry) => entry.when));
        expect(await latestRecordedMigration(conn)).toBe(head);

        // The schema the application actually queries now exists.
        for (const table of REQUIRED_TABLES) {
          expect(await tableExists(conn, table)).toBe(true);
        }
        expect(await columnExists(conn, "coupons", "maxDiscountAmount")).toBe(true);
      } finally {
        await closeMysqlConnectionSafely(conn);
      }
    }, 240000);

    it("Test 2: a second start against the now-migrated database is a clean idempotent no-op", async () => {
      const conn = await connect();
      try {
        await assertLiveTestDatabase(conn);
        const before = await latestRecordedMigration(conn);

        const run = await startBuiltServer(41732);
        await waitForMigrationLockReleased(conn);

        expect(run.started).toBe(true);
        expect(run.output).toContain("[migrate] Done - schema is up to date");
        // No duplicate-object failures of any kind.
        expect(run.output).not.toMatch(/already exists/i);
        expect(run.output).not.toMatch(/Duplicate (column|key|entry)/i);
        expect(run.output).not.toContain("[migrate] Migration failed");
        expect(run.output).not.toContain("[startup] FATAL");

        // History unchanged - nothing was re-applied.
        expect(await latestRecordedMigration(conn)).toBe(before);
        for (const table of REQUIRED_TABLES) {
          expect(await tableExists(conn, table)).toBe(true);
        }
      } finally {
        await closeMysqlConnectionSafely(conn);
      }
    }, 240000);
  }
);
