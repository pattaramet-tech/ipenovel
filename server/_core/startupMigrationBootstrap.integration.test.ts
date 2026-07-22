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

/** Starts the built executable against the disposable database, waits for it to either announce it is listening or exit, then always terminates it. */
function startBuiltServer(port: number, timeoutMs = 180000): Promise<ServerRun> {
  return new Promise((resolve) => {
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
    let settled = false;

    const finish = (started: boolean, exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      resolve({ output, started, exitCode });
    };

    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("Server running")) finish(true, null);
    };

    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("close", (code) => finish(output.includes("Server running"), code));
    const timer = setTimeout(() => finish(output.includes("Server running"), null), timeoutMs);
  });
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
