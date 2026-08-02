import { describe, it, expect } from "vitest";
import path from "node:path";
import crypto from "node:crypto";
import mysql from "mysql2/promise";
import { buildTestDbConnectionOptions, parseTestDbTransportMode } from "./test-helpers/testDbConnectionOptions";
import { runMigrationsWithLogging, consoleMigrationLogger, readMigrationJournal } from "./test-helpers/migrateTestDbWithLogging";
import { EXPECTED_TEST_DATABASE_NAME } from "./test-helpers/testDatabaseGuard";
import { restoreToFullyMigratedWithRetry } from "./test-helpers/restoreWithEmergencyRetry";
import { closeMysqlConnectionSafely } from "./test-helpers/closeMysqlConnectionSafely";
import { resetToEmptySchema } from "./test-helpers/resetToEmptySchema";
import { resetToMigrationCutoff } from "./test-helpers/resetToMigrationCutoff";
import { verifyMigrationJournalAtLatest } from "./test-helpers/verifyMigrationJournalAtLatest";

/**
 * Real-database coverage for the migration 0024 LONGTEXT-downgrade fix.
 *
 * Confirmed Production incident: the deployment of merge commit
 * 63fc1cef3447f8654a76eb4e64304a68df7ec555 failed during migration startup
 * with errno 8025 ("Entry too large", max entry 6291456 bytes, attempted
 * 6388937 bytes) - migration 0024's unconditional
 * `ALTER TABLE episodes MODIFY COLUMN content mediumtext` tried to
 * downgrade `episodes.content`, which Production already has as LONGTEXT
 * (wider than MEDIUMTEXT), triggering TiDB's Reorg-Data operation. This
 * file proves the fix: LONGTEXT is preserved exactly (including a
 * production-sized ~4.25MB row, byte-for-byte), TEXT still widens to
 * MEDIUMTEXT as originally intended, and the full chain still completes.
 *
 * This environment only has MariaDB available (no Docker/TiDB v8.5.3) -
 * see the accompanying report for the TiDB parity test's unavailability.
 * MariaDB does not reproduce TiDB's errno-8025 Reorg-Data failure mode
 * directly, but it does faithfully exercise the exact guard logic (the
 * information_schema DATA_TYPE read, the IN ('mediumtext','longtext')
 * check, and the resulting ALTER-or-DO-0 branch), which is
 * database-engine-agnostic SQL.
 *
 * Uses a single dedicated mysql2 connection (never a pool) - same
 * session-continuity reason as every other migration integration test in
 * this repo (guarded statements use session-scoped @variables across
 * SET/PREPARE/EXECUTE/DEALLOCATE PREPARE).
 *
 * Fixed test-infrastructure bug (never a production/migration change):
 * every "already has LONGTEXT/MEDIUMTEXT/TEXT" scenario used to establish
 * a FULL baseline (every migration that currently exists, including ones
 * added long after this file was written, e.g. migration 0033's
 * `authIdentities`) and then rewind ONLY the __drizzle_migrations journal
 * to before 0024 - leaving every later migration's physical objects
 * behind while making those same migrations "pending" again. Once an
 * unguarded, plain `CREATE TABLE` migration (0033/0034) existed past this
 * file's original scope, runFullChain() started failing with
 * ER_TABLE_EXISTS_ERROR. Migration 0024 itself CREATES episodes.content
 * (guarded ADD COLUMN, see the migration's own SQL) rather than assuming
 * it already exists, so "Production already has LONGTEXT" is correctly
 * modeled as: reset to an EXACT, verified 0000-0023 baseline (via
 * resetToMigrationCutoff() - content genuinely does not exist yet), then
 * manually add the column in the desired starting type (simulating an
 * out-of-band/manual DBA change that predates this migration chain ever
 * running against it) - no journal rewind needed at all anymore, and
 * nothing from a later migration can ever be left behind, because nothing
 * past 0023 was ever created in the first place.
 */

const migrationsFolder = path.resolve(__dirname, "..", "drizzle");
const TEST_TIMEOUT_MS = 180000;

/** Matches Production's confirmed maximum episode content size (bytes). */
const LARGE_CONTENT_SIZE = 4248726;

const IDX23_TAG = "0023_add_episode_sale_mode";

async function connect(): Promise<mysql.Connection | null> {
  if (!process.env.TEST_DATABASE_URL) return null;
  return mysql.createConnection(
    buildTestDbConnectionOptions(process.env.TEST_DATABASE_URL, parseTestDbTransportMode(process.env.TEST_DATABASE_TRANSPORT))
  );
}

async function runFullChain(conn: mysql.Connection): Promise<void> {
  await runMigrationsWithLogging(conn, migrationsFolder, consoleMigrationLogger("[migration-0024-content-test]"));
}

async function resetToIdx23Baseline(conn: mysql.Connection): Promise<void> {
  await resetToMigrationCutoff(conn, process.env.TEST_DATABASE_URL, migrationsFolder, IDX23_TAG);
}

async function columnType(conn: mysql.Connection, table: string, column: string): Promise<string | null> {
  const [rows]: any = await conn.query(
    "SELECT LOWER(DATA_TYPE) AS dataType FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?",
    [table, column]
  );
  return rows[0]?.dataType ?? null;
}

async function latestRecordedMigrationTimestamp(conn: mysql.Connection): Promise<number | null> {
  const [rows]: any = await conn.query("SELECT MAX(created_at) AS hw FROM `__drizzle_migrations`");
  return rows[0]?.hw !== null && rows[0]?.hw !== undefined ? Number(rows[0].hw) : null;
}

/**
 * The GENUINE emergency-reset path: fresh connection (verified live by the
 * caller - see restoreToFullyMigratedWithRetry's own queryLiveDatabaseName +
 * expectedDatabaseName check, which runs before this is ever invoked) ->
 * resetToEmptySchema() -> run the full migration chain from nothing ->
 * verify the result is genuinely at the newest migration. Never just
 * "run the chain again" against whatever state the connection happens to
 * already be in - that was this file's OWN version of the bug this task
 * exists to fix (its old `runCleanup: runFullChain` retried the identical
 * operation the primary attempt already failed at, against the same dirty
 * schema).
 */
async function emergencyResetAndRestore(conn: mysql.Connection): Promise<void> {
  await resetToEmptySchema(conn, process.env.TEST_DATABASE_URL);
  await runFullChain(conn);
  await verifyMigrationJournalAtLatest(conn, migrationsFolder);
}

async function restoreFullChain(conn: mysql.Connection): Promise<void> {
  await restoreToFullyMigratedWithRetry(() => runFullChain(conn), {
    connect,
    queryLiveDatabaseName: async (c: mysql.Connection) => {
      const [rows]: any = await c.query("SELECT DATABASE() AS name");
      return rows?.[0]?.name ?? null;
    },
    runCleanup: emergencyResetAndRestore,
    closeConnection: (emergencyConn) => closeMysqlConnectionSafely(emergencyConn),
    expectedDatabaseName: EXPECTED_TEST_DATABASE_NAME,
  });
}

describe.sequential("migration 0024 - LONGTEXT episodes.content is never downgraded (real disposable test database)", () => {
  it(
    "an existing LONGTEXT episodes.content, including a production-sized ~4.25MB row, is preserved byte-for-byte through the migration chain",
    async () => {
      const conn = await connect();
      if (!conn) return;

      let episodeId: number | undefined;
      try {
        // Exact, verified 0000-0023 baseline - episodes.content genuinely
        // does not exist yet, and nothing past 0023 does either.
        await resetToIdx23Baseline(conn);

        // Simulate the confirmed Production state: an out-of-band change
        // already made episodes.content LONGTEXT before this migration
        // chain ever runs against it (migration 0024 itself only ever
        // CREATEs the column as TEXT if it's missing - see the migration's
        // own guarded ADD COLUMN - so this models "already present in a
        // wider type from outside this chain entirely", exactly the
        // Production scenario under test).
        await conn.query("ALTER TABLE `episodes` ADD `content` longtext");
        expect(await columnType(conn, "episodes", "content")).toBe("longtext");

        const largeContent = crypto.randomBytes(Math.ceil(LARGE_CONTENT_SIZE / 2)).toString("hex").slice(0, LARGE_CONTENT_SIZE);
        expect(Buffer.byteLength(largeContent, "utf8")).toBe(LARGE_CONTENT_SIZE);
        const expectedHash = crypto.createHash("sha256").update(largeContent, "utf8").digest("hex");

        const [insertResult]: any = await conn.query(
          "INSERT INTO `episodes` (novelId, episodeNumber, title, content) VALUES (?, ?, ?, ?)",
          [990024001, "LONGTEXT-PRESERVE-TEST", "Migration 0024 LONGTEXT preservation test", largeContent]
        );
        episodeId = insertResult.insertId;

        // The actual fix under test: running the (now-pending, for the
        // first time) chain must NOT downgrade the already-LONGTEXT
        // column, and must still reach the newest migration.
        await expect(runFullChain(conn)).resolves.not.toThrow();

        expect(await columnType(conn, "episodes", "content")).toBe("longtext");

        const [rows]: any = await conn.query("SELECT content FROM `episodes` WHERE id = ?", [episodeId]);
        expect(rows).toHaveLength(1);
        const actualHash = crypto.createHash("sha256").update(rows[0].content, "utf8").digest("hex");
        expect(actualHash).toBe(expectedHash);
        expect(Buffer.byteLength(rows[0].content, "utf8")).toBe(LARGE_CONTENT_SIZE);

        const journal = readMigrationJournal(migrationsFolder);
        const latestWhen = journal[journal.length - 1].when;
        expect(await latestRecordedMigrationTimestamp(conn)).toBe(latestWhen);

        for (const table of [
          "dailyCheckins",
          "dailyCheckinCampaigns",
          "dailyCheckinCouponTemplates",
          "dailyCheckinRewardRules",
          "dailyCheckinRewardGrants",
        ]) {
          const [tableRows]: any = await conn.query(
            "SELECT COUNT(*) AS cnt FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?",
            [table]
          );
          expect(Number(tableRows[0].cnt)).toBeGreaterThan(0);
        }
        for (const index of [
          "PRIMARY",
          "unique_daily_checkin_user_date_campaign",
          "unique_daily_checkins_coupon",
          "dailyCheckins_userId_idx",
        ]) {
          const [idxRows]: any = await conn.query(
            "SELECT COUNT(*) AS cnt FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'dailyCheckins' AND index_name = ?",
            [index]
          );
          expect(Number(idxRows[0].cnt)).toBeGreaterThan(0);
        }
      } finally {
        if (episodeId) await conn.query("DELETE FROM `episodes` WHERE id = ?", [episodeId]).catch(() => {});
        await restoreFullChain(conn!);
        await closeMysqlConnectionSafely(conn!);
      }
    },
    TEST_TIMEOUT_MS
  );

  it(
    "a MEDIUMTEXT episodes.content (already correct) is left unchanged - no downgrade, no unnecessary ALTER",
    async () => {
      const conn = await connect();
      if (!conn) return;
      try {
        await resetToIdx23Baseline(conn);
        await conn.query("ALTER TABLE `episodes` ADD `content` mediumtext");
        expect(await columnType(conn, "episodes", "content")).toBe("mediumtext");

        await expect(runFullChain(conn)).resolves.not.toThrow();

        expect(await columnType(conn, "episodes", "content")).toBe("mediumtext");
      } finally {
        await restoreFullChain(conn!);
        await closeMysqlConnectionSafely(conn!);
      }
    },
    TEST_TIMEOUT_MS
  );

  it(
    "a TEXT episodes.content (the original, narrower historical type) still widens to MEDIUMTEXT as originally intended",
    async () => {
      const conn = await connect();
      if (!conn) return;
      try {
        await resetToIdx23Baseline(conn);
        await conn.query("ALTER TABLE `episodes` ADD `content` text");
        expect(await columnType(conn, "episodes", "content")).toBe("text");

        await expect(runFullChain(conn)).resolves.not.toThrow();

        expect(await columnType(conn, "episodes", "content")).toBe("mediumtext");
      } finally {
        await restoreFullChain(conn!);
        await closeMysqlConnectionSafely(conn!);
      }
    },
    TEST_TIMEOUT_MS
  );

  it(
    "a genuinely fresh database (migrated 0000 through the newest migration from empty) ends with episodes.content as mediumtext or a wider accepted type",
    async () => {
      const conn = await connect();
      if (!conn) return;
      try {
        // Was an ad-hoc DROP-every-table-except-__drizzle_migrations loop
        // plus a bare `DELETE FROM __drizzle_migrations` - replaced with
        // the shared, independently unit-tested resetToEmptySchema(),
        // which additionally enforces the TEST_DATABASE_URL/live-database
        // safety gates this ad-hoc version never had, drops views before
        // tables, and verifies zero objects remain afterward.
        await resetToEmptySchema(conn, process.env.TEST_DATABASE_URL);

        await expect(runFullChain(conn)).resolves.not.toThrow();

        const finalType = await columnType(conn, "episodes", "content");
        expect(["mediumtext", "longtext"]).toContain(finalType);

        const journal = readMigrationJournal(migrationsFolder);
        const latestWhen = journal[journal.length - 1].when;
        expect(await latestRecordedMigrationTimestamp(conn)).toBe(latestWhen);
      } finally {
        await restoreFullChain(conn!);
        await closeMysqlConnectionSafely(conn!);
      }
    },
    TEST_TIMEOUT_MS
  );
});
