import { describe, it, expect } from "vitest";
import path from "node:path";
import crypto from "node:crypto";
import mysql from "mysql2/promise";
import { buildTestDbConnectionOptions } from "./test-helpers/testDbConnectionOptions";
import { runMigrationsWithLogging, consoleMigrationLogger, readMigrationJournal } from "./test-helpers/migrateTestDbWithLogging";
import { EXPECTED_TEST_DATABASE_NAME } from "./test-helpers/testDatabaseGuard";
import { restoreToFullyMigratedWithRetry } from "./test-helpers/restoreWithEmergencyRetry";
import { closeMysqlConnectionSafely } from "./test-helpers/closeMysqlConnectionSafely";

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
 * MEDIUMTEXT as originally intended, and the full chain still reaches
 * migration 0030.
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
 */

const migrationsFolder = path.resolve(__dirname, "..", "drizzle");
const TEST_TIMEOUT_MS = 180000;

/** Matches Production's confirmed maximum episode content size (bytes). */
const LARGE_CONTENT_SIZE = 4248726;

async function connect(): Promise<mysql.Connection | null> {
  if (!process.env.TEST_DATABASE_URL) return null;
  return mysql.createConnection(buildTestDbConnectionOptions(process.env.TEST_DATABASE_URL));
}

async function runFullChain(conn: mysql.Connection): Promise<void> {
  await runMigrationsWithLogging(conn, migrationsFolder, consoleMigrationLogger("[migration-0024-content-test]"));
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

/** Rewinds recorded history to strictly before migration 0024, so the next full-chain run re-attempts 0024 through 0030 for real. */
async function rewindToBeforeMigration0024(conn: mysql.Connection): Promise<void> {
  const journal = readMigrationJournal(migrationsFolder);
  const idx0024When = journal.find((e) => e.tag === "0024_widen_episode_content_mediumtext")!.when;
  await conn.query("DELETE FROM `__drizzle_migrations` WHERE created_at >= ?", [idx0024When]);
}

async function restoreFullChain(conn: mysql.Connection): Promise<void> {
  await restoreToFullyMigratedWithRetry(() => runFullChain(conn), {
    connect,
    queryLiveDatabaseName: async (c: mysql.Connection) => {
      const [rows]: any = await c.query("SELECT DATABASE() AS name");
      return rows?.[0]?.name ?? null;
    },
    runCleanup: runFullChain,
    closeConnection: (emergencyConn) => closeMysqlConnectionSafely(emergencyConn),
    expectedDatabaseName: EXPECTED_TEST_DATABASE_NAME,
  });
}

describe.sequential("migration 0024 - LONGTEXT episodes.content is never downgraded (real disposable test database)", () => {
  it(
    "an existing LONGTEXT episodes.content, including a production-sized ~4.25MB row, is preserved byte-for-byte through migrations 0024-0030",
    async () => {
      const conn = await connect();
      if (!conn) return;

      let episodeId: number | undefined;
      try {
        await runFullChain(conn); // fully migrated baseline

        // Simulate the confirmed Production state: content already LONGTEXT.
        await conn.query("ALTER TABLE `episodes` MODIFY COLUMN `content` longtext");
        expect(await columnType(conn, "episodes", "content")).toBe("longtext");

        const largeContent = crypto.randomBytes(Math.ceil(LARGE_CONTENT_SIZE / 2)).toString("hex").slice(0, LARGE_CONTENT_SIZE);
        expect(Buffer.byteLength(largeContent, "utf8")).toBe(LARGE_CONTENT_SIZE);
        const expectedHash = crypto.createHash("sha256").update(largeContent, "utf8").digest("hex");

        const [insertResult]: any = await conn.query(
          "INSERT INTO `episodes` (novelId, episodeNumber, title, content) VALUES (?, ?, ?, ?)",
          [990024001, "LONGTEXT-PRESERVE-TEST", "Migration 0024 LONGTEXT preservation test", largeContent]
        );
        episodeId = insertResult.insertId;

        await rewindToBeforeMigration0024(conn);
        expect(await latestRecordedMigrationTimestamp(conn)).toBeLessThan(
          readMigrationJournal(migrationsFolder).find((e) => e.tag === "0024_widen_episode_content_mediumtext")!.when
        );

        // The actual fix under test: re-running the chain must NOT downgrade
        // the already-LONGTEXT column, and must still reach migration 0030.
        await expect(runFullChain(conn)).resolves.not.toThrow();

        expect(await columnType(conn, "episodes", "content")).toBe("longtext");

        const [rows]: any = await conn.query("SELECT content FROM `episodes` WHERE id = ?", [episodeId]);
        expect(rows).toHaveLength(1);
        const actualHash = crypto.createHash("sha256").update(rows[0].content, "utf8").digest("hex");
        expect(actualHash).toBe(expectedHash);
        expect(Buffer.byteLength(rows[0].content, "utf8")).toBe(LARGE_CONTENT_SIZE);

        const journal = readMigrationJournal(migrationsFolder);
        const idx0030When = journal[journal.length - 1].when; // end of chain, not a pinned migration
        expect(await latestRecordedMigrationTimestamp(conn)).toBe(idx0030When);

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
        await runFullChain(conn);
        await conn.query("ALTER TABLE `episodes` MODIFY COLUMN `content` mediumtext");
        expect(await columnType(conn, "episodes", "content")).toBe("mediumtext");

        await rewindToBeforeMigration0024(conn);
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
        await runFullChain(conn);
        await conn.query("ALTER TABLE `episodes` MODIFY COLUMN `content` text");
        expect(await columnType(conn, "episodes", "content")).toBe("text");

        await rewindToBeforeMigration0024(conn);
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
    "a genuinely fresh database (migrated 0000 through 0030 from empty) ends with episodes.content as mediumtext or a wider accepted type",
    async () => {
      const conn = await connect();
      if (!conn) return;
      try {
        // Drop everything to simulate a genuinely fresh database, then run
        // the entire chain from scratch.
        await conn.query("SET FOREIGN_KEY_CHECKS = 0");
        const [tables]: any = await conn.query(
          "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE()"
        );
        for (const { name } of tables) {
          if (name === "__drizzle_migrations") continue;
          await conn.query(`DROP TABLE IF EXISTS \`${name}\``);
        }
        await conn.query("DELETE FROM `__drizzle_migrations`");
        await conn.query("SET FOREIGN_KEY_CHECKS = 1");

        await expect(runFullChain(conn)).resolves.not.toThrow();

        const finalType = await columnType(conn, "episodes", "content");
        expect(["mediumtext", "longtext"]).toContain(finalType);

        const journal = readMigrationJournal(migrationsFolder);
        const idx0030When = journal[journal.length - 1].when; // end of chain, not a pinned migration
        expect(await latestRecordedMigrationTimestamp(conn)).toBe(idx0030When);
      } finally {
        await restoreFullChain(conn!);
        await closeMysqlConnectionSafely(conn!);
      }
    },
    TEST_TIMEOUT_MS
  );
});
