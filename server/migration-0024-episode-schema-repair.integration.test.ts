import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import mysql from "mysql2/promise";
import { buildTestDbConnectionOptions } from "./test-helpers/testDbConnectionOptions";
import { runMigrationsWithLogging, consoleMigrationLogger, readMigrationJournal } from "./test-helpers/migrateTestDbWithLogging";

/**
 * Real-database coverage for the migration 0024 repair - see
 * docs/INCIDENT_MIGRATION_0024_EPISODES_CONTENT.md for the root cause.
 * Every test here is self-guarded (`if (!process.env.TEST_DATABASE_URL)
 * return`) and additionally relies on the integration project's own
 * globalSetup, which independently verifies TEST_DATABASE_URL via both the
 * connection-string check and a live "SELECT DATABASE()" check before any
 * test file in this project loads - see vitest.integration.globalsetup.ts.
 * This file never runs against anything but a verified, disposable
 * "ipenovel_test" database.
 *
 * Uses a single dedicated mysql2 connection (never a pool) throughout, for
 * the same session-variable-continuity reason documented in
 * server/migration-0027-idempotency.integration.test.ts.
 */

const migrationsFolder = path.resolve(__dirname, "..", "drizzle");

async function connect(): Promise<mysql.Connection | null> {
  if (!process.env.TEST_DATABASE_URL) return null;
  return mysql.createConnection(buildTestDbConnectionOptions(process.env.TEST_DATABASE_URL));
}

async function tableExists(conn: mysql.Connection, tableName: string): Promise<boolean> {
  const [rows]: any = await conn.query(
    `SELECT COUNT(*) as cnt FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?`,
    [tableName]
  );
  return Number(rows[0].cnt) > 0;
}

async function columnExists(conn: mysql.Connection, tableName: string, columnName: string): Promise<boolean> {
  const [rows]: any = await conn.query(
    `SELECT COUNT(*) as cnt FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [tableName, columnName]
  );
  return Number(rows[0].cnt) > 0;
}

async function columnType(conn: mysql.Connection, tableName: string, columnName: string): Promise<string | null> {
  const [rows]: any = await conn.query(
    `SELECT DATA_TYPE as dataType FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
    [tableName, columnName]
  );
  return rows[0]?.dataType ?? null;
}

async function dropColumnIfExists(conn: mysql.Connection, tableName: string, columnName: string): Promise<void> {
  if (await columnExists(conn, tableName, columnName)) {
    await conn.query(`ALTER TABLE \`${tableName}\` DROP COLUMN \`${columnName}\``);
  }
}

async function dropTableIfExists(conn: mysql.Connection, tableName: string): Promise<void> {
  await conn.query(`DROP TABLE IF EXISTS \`${tableName}\``);
}

/** Removes only the __drizzle_migrations rows recorded strictly after `afterWhen` - rewinds the resume high-water-mark without touching earlier, unrelated history. */
async function rewindMigrationHistoryAfter(conn: mysql.Connection, afterWhen: number): Promise<void> {
  await conn.query(`DELETE FROM \`__drizzle_migrations\` WHERE created_at > ?`, [afterWhen]);
}

async function runFullChain(conn: mysql.Connection) {
  await runMigrationsWithLogging(conn, migrationsFolder, consoleMigrationLogger("[integration-test]"));
}

/** Fully restores episodes/episodePurchases/readingProgress to the complete, correct end state - always run in a finally block regardless of what a test intentionally broke. */
async function restoreToFullyMigrated(conn: mysql.Connection) {
  await runFullChain(conn).catch(() => {});
}

const journal = readMigrationJournal(migrationsFolder);
const idx23When = journal.find((e) => e.tag === "0023_add_episode_sale_mode")!.when;
const idx24When = journal.find((e) => e.tag === "0024_widen_episode_content_mediumtext")!.when;
const idx27When = journal.find((e) => e.tag === "0027_add_daily_checkin_and_coupon_cap")!.when;

describe("migration 0024/0025/0028 repair - real disposable test database", () => {
  it("1. a completely empty database (no relevant tables, no migration history) migrates 0000 through the newest migration successfully", async () => {
    const conn = await connect();
    if (!conn) return;
    try {
      // Drop every table in this database and every migration record -
      // this IS "completely empty" with respect to this migration chain's
      // own bookkeeping (__drizzle_migrations), which is what determines
      // whether migrations 0000-0022's non-idempotent CREATE TABLE
      // statements are even attempted.
      const [tables]: any = await conn.query(
        `SELECT table_name as name FROM information_schema.tables WHERE table_schema = DATABASE()`
      );
      for (const { name } of tables) {
        await conn.query(`DROP TABLE IF EXISTS \`${name}\``);
      }

      await expect(runFullChain(conn)).resolves.not.toThrow();

      expect(await tableExists(conn, "episodes")).toBe(true);
      expect(await columnExists(conn, "episodes", "content")).toBe(true);
      expect(await columnType(conn, "episodes", "content")).toBe("mediumtext");
      expect(await tableExists(conn, "episodePurchases")).toBe(true);
      expect(await tableExists(conn, "readingProgress")).toBe(true);
      expect(await columnExists(conn, "readingProgress", "currentChapterNumber")).toBe(true);
    } finally {
      await restoreToFullyMigrated(conn!);
      await conn!.end();
    }
  }, 60000);

  it("2. episodes exists without the legacy reader columns - migration 0024 creates them", async () => {
    const conn = await connect();
    if (!conn) return;
    try {
      await runFullChain(conn); // known-good starting baseline
      await rewindMigrationHistoryAfter(conn, idx23When); // pretend only 0000-0023 ever ran
      for (const col of ["content", "contentFormat", "isPublished", "publishedAt", "wordCount", "sortOrder"]) {
        await dropColumnIfExists(conn, "episodes", col);
      }
      await dropTableIfExists(conn, "episodePurchases");
      await dropTableIfExists(conn, "readingProgress");

      expect(await columnExists(conn, "episodes", "content")).toBe(false);

      await expect(runFullChain(conn)).resolves.not.toThrow();

      for (const col of ["content", "contentFormat", "isPublished", "publishedAt", "wordCount", "sortOrder"]) {
        expect(await columnExists(conn, "episodes", col)).toBe(true);
      }
      expect(await tableExists(conn, "episodePurchases")).toBe(true);
      expect(await tableExists(conn, "readingProgress")).toBe(true);
    } finally {
      await restoreToFullyMigrated(conn!);
      await conn!.end();
    }
  }, 60000);

  it("3. journal history shows 0023 already applied, but the 0024 prerequisites are missing", async () => {
    const conn = await connect();
    if (!conn) return;
    try {
      await runFullChain(conn);
      await rewindMigrationHistoryAfter(conn, idx23When);
      await dropColumnIfExists(conn, "episodes", "content");
      await dropTableIfExists(conn, "episodePurchases");
      await dropTableIfExists(conn, "readingProgress");

      // Precondition: 0023 (saleMode) is still recorded/present, proving
      // this is specifically "history passed 0023, prerequisites for 0024
      // missing" - not a fully fresh database.
      expect(await columnExists(conn, "episodes", "saleMode")).toBe(true);
      const [rows]: any = await conn.query(`SELECT MAX(created_at) as latest FROM \`__drizzle_migrations\``);
      expect(Number(rows[0].latest)).toBe(idx23When);
      expect(await columnExists(conn, "episodes", "content")).toBe(false);

      await expect(runFullChain(conn)).resolves.not.toThrow();
      expect(await columnExists(conn, "episodes", "content")).toBe(true);
    } finally {
      await restoreToFullyMigrated(conn!);
      await conn!.end();
    }
  }, 60000);

  it("4. only some legacy columns are present - migration adds exactly the missing ones without erroring on the rest", async () => {
    const conn = await connect();
    if (!conn) return;
    try {
      await runFullChain(conn);
      await rewindMigrationHistoryAfter(conn, idx23When);
      for (const col of ["content", "contentFormat", "isPublished", "publishedAt", "wordCount", "sortOrder"]) {
        await dropColumnIfExists(conn, "episodes", col);
      }
      await dropTableIfExists(conn, "episodePurchases");
      await dropTableIfExists(conn, "readingProgress");
      // Manually pre-create HALF the columns, as if a partial run happened before.
      await conn.query("ALTER TABLE `episodes` ADD `content` text");
      await conn.query("ALTER TABLE `episodes` ADD `contentFormat` varchar(50) DEFAULT 'plain_text'");
      await conn.query("ALTER TABLE `episodes` ADD `isPublished` boolean DEFAULT true NOT NULL");

      await expect(runFullChain(conn)).resolves.not.toThrow();

      for (const col of ["content", "contentFormat", "isPublished", "publishedAt", "wordCount", "sortOrder"]) {
        expect(await columnExists(conn, "episodes", col)).toBe(true);
      }
      expect(await columnType(conn, "episodes", "content")).toBe("mediumtext");
    } finally {
      await restoreToFullyMigrated(conn!);
      await conn!.end();
    }
  }, 60000);

  it("5. the full legacy schema is already present (e.g. via a manual drizzle-kit push) - migration is a guarded no-op", async () => {
    const conn = await connect();
    if (!conn) return;
    try {
      await runFullChain(conn);
      await rewindMigrationHistoryAfter(conn, idx23When);
      // Everything already present (it never was dropped) - this is the
      // "already fully correct, migration must not error" case.
      expect(await columnExists(conn, "episodes", "content")).toBe(true);
      expect(await tableExists(conn, "episodePurchases")).toBe(true);
      expect(await tableExists(conn, "readingProgress")).toBe(true);

      await expect(runFullChain(conn)).resolves.not.toThrow();

      expect(await columnExists(conn, "episodes", "content")).toBe(true);
    } finally {
      await restoreToFullyMigrated(conn!);
      await conn!.end();
    }
  }, 60000);

  it("6. readingProgress is missing entirely despite the journal already being fully recorded - migration 0028 recreates it", async () => {
    const conn = await connect();
    if (!conn) return;
    try {
      await runFullChain(conn); // full history recorded, including 0028
      await dropTableIfExists(conn, "readingProgress");
      expect(await tableExists(conn, "readingProgress")).toBe(false);

      // History is already past 0024/0025 - only a migration newer than
      // everything before it (0028) can possibly run now.
      const [rows]: any = await conn.query(`SELECT COUNT(*) as cnt FROM \`__drizzle_migrations\` WHERE created_at > ?`, [idx27When]);
      expect(Number(rows[0].cnt)).toBeGreaterThan(0); // 0028 already recorded from the runFullChain() above

      // Rewind ONLY 0028's own record so it can run again and prove the repair.
      await conn.query(`DELETE FROM \`__drizzle_migrations\` WHERE created_at > ?`, [idx27When]);

      await expect(runFullChain(conn)).resolves.not.toThrow();
      expect(await tableExists(conn, "readingProgress")).toBe(true);
      expect(await columnExists(conn, "readingProgress", "currentChapterNumber")).toBe(true);
    } finally {
      await restoreToFullyMigrated(conn!);
      await conn!.end();
    }
  }, 60000);

  it("7. readingProgress exists without the 0025 TOC columns - migration 0025 adds exactly those", async () => {
    const conn = await connect();
    if (!conn) return;
    try {
      await runFullChain(conn);
      await rewindMigrationHistoryAfter(conn, idx24When); // 0024 recorded, 0025 not yet
      for (const col of ["currentChapterNumber", "currentChapterTitle", "anchorKey"]) {
        await dropColumnIfExists(conn, "readingProgress", col);
      }
      expect(await tableExists(conn, "readingProgress")).toBe(true);
      expect(await columnExists(conn, "readingProgress", "currentChapterNumber")).toBe(false);

      await expect(runFullChain(conn)).resolves.not.toThrow();

      for (const col of ["currentChapterNumber", "currentChapterTitle", "anchorKey"]) {
        expect(await columnExists(conn, "readingProgress", col)).toBe(true);
      }
    } finally {
      await restoreToFullyMigrated(conn!);
      await conn!.end();
    }
  }, 60000);

  it("8. migration rerun is idempotent - running the full chain twice in a row makes no further changes", async () => {
    const conn = await connect();
    if (!conn) return;
    try {
      await runFullChain(conn);
      await expect(runFullChain(conn)).resolves.not.toThrow(); // second run: nothing pending, must be a clean no-op

      // Force 0024/0025/0028's raw SQL to run again directly, bypassing the
      // journal timestamp skip entirely, proving the SQL itself (not just
      // drizzle's bookkeeping) is idempotent - same technique as
      // server/migration-0027-idempotency.integration.test.ts.
      for (const tag of ["0024_widen_episode_content_mediumtext", "0025_add_reading_progress_toc_columns", "0028_repair_episode_reader_schema"]) {
        const sql = fs.readFileSync(path.join(migrationsFolder, `${tag}.sql`), "utf8");
        for (const statement of sql.split("--> statement-breakpoint")) {
          await expect(conn.query(statement)).resolves.not.toThrow();
        }
      }

      expect(await columnExists(conn, "episodes", "content")).toBe(true);
      expect(await tableExists(conn, "episodePurchases")).toBe(true);
      expect(await tableExists(conn, "readingProgress")).toBe(true);
    } finally {
      await restoreToFullyMigrated(conn!);
      await conn!.end();
    }
  }, 60000);

  it("9. the final schema agrees with drizzle/schema.ts for the objects this repair concerns", async () => {
    const conn = await connect();
    if (!conn) return;
    try {
      await runFullChain(conn);

      const expectedEpisodesColumns: Record<string, string> = {
        content: "mediumtext",
        contentFormat: "varchar",
        isPublished: "tinyint", // MySQL boolean is stored as tinyint(1)
        publishedAt: "timestamp",
        wordCount: "int",
        sortOrder: "int",
      };
      for (const [column, expectedType] of Object.entries(expectedEpisodesColumns)) {
        expect(await columnType(conn, "episodes", column)).toBe(expectedType);
      }

      const expectedEpisodePurchasesColumns = ["id", "userId", "novelId", "episodeId", "pricePaid", "walletTransactionId", "purchasedAt", "createdAt"];
      for (const column of expectedEpisodePurchasesColumns) {
        expect(await columnExists(conn, "episodePurchases", column)).toBe(true);
      }

      const expectedReadingProgressColumns = [
        "id", "userId", "novelId", "episodeId", "progressPercent", "scrollPosition",
        "currentChapterNumber", "currentChapterTitle", "anchorKey", "lastReadAt", "updatedAt",
      ];
      for (const column of expectedReadingProgressColumns) {
        expect(await columnExists(conn, "readingProgress", column)).toBe(true);
      }
    } finally {
      await restoreToFullyMigrated(conn!);
      await conn!.end();
    }
  }, 60000);

  it("10. the migration journal does not advance past a migration that fails", async () => {
    const conn = await connect();
    if (!conn) return;

    // An isolated, synthetic migrations folder (outside drizzle/) so this
    // never touches or corrupts the real repo migration files - proves the
    // exact resume/skip property this task cares about using a deliberately
    // broken migration, without risking the real chain.
    const tmpFolder = fs.mkdtempSync(path.join(os.tmpdir(), "ipenovel-migration-failure-test-"));
    const tag1 = "0000_synthetic_ok";
    const tag2 = "0001_synthetic_broken";
    try {
      fs.mkdirSync(path.join(tmpFolder, "meta"));
      fs.writeFileSync(
        path.join(tmpFolder, "meta", "_journal.json"),
        JSON.stringify({
          version: "5",
          dialect: "mysql",
          entries: [
            { idx: 0, version: "5", when: 1, tag: tag1, breakpoints: true },
            { idx: 1, version: "5", when: 2, tag: tag2, breakpoints: true },
          ],
        })
      );
      fs.writeFileSync(path.join(tmpFolder, `${tag1}.sql`), "CREATE TABLE IF NOT EXISTS `ipenovel_synthetic_ok` (id int);");
      fs.writeFileSync(path.join(tmpFolder, `${tag2}.sql`), "THIS IS NOT VALID SQL AND MUST FAIL;");

      await expect(runMigrationsWithLogging(conn, tmpFolder, consoleMigrationLogger("[integration-test]"))).rejects.toThrow();

      const [rows]: any = await conn.query(`SELECT hash, created_at FROM \`__drizzle_migrations\` WHERE created_at IN (1, 2)`);
      expect(rows.length).toBe(1); // only the first (successful) migration was recorded
      expect(Number(rows[0].created_at)).toBe(1);

      const [tableRows]: any = await conn.query(
        `SELECT COUNT(*) as cnt FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'ipenovel_synthetic_ok'`
      );
      expect(Number(tableRows[0].cnt)).toBe(1); // the successful migration's DDL really ran
    } finally {
      await conn.query(`DELETE FROM \`__drizzle_migrations\` WHERE created_at IN (1, 2)`).catch(() => {});
      await conn.query("DROP TABLE IF EXISTS `ipenovel_synthetic_ok`").catch(() => {});
      fs.rmSync(tmpFolder, { recursive: true, force: true });
      await conn.end();
    }
  }, 60000);
});
