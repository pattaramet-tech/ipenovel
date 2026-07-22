import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import mysql from "mysql2/promise";
import { buildTestDbConnectionOptions } from "./test-helpers/testDbConnectionOptions";
import { runMigrationsWithLogging, consoleMigrationLogger, readMigrationJournal } from "./test-helpers/migrateTestDbWithLogging";
import { restoreToFullyMigratedWithRetry } from "./test-helpers/restoreWithEmergencyRetry";
import { EXPECTED_TEST_DATABASE_NAME } from "./test-helpers/testDatabaseGuard";
import { closeMysqlConnectionSafely } from "./test-helpers/closeMysqlConnectionSafely";

/**
 * Real-database coverage for migration 0030 - the forward-only repair for
 * the confirmed production incident where `dailyCheckins` does not exist
 * even though `__drizzle_migrations` already records history past 0027
 * (the migration meant to have created it). See
 * docs/DAILY_CHECKIN_DEPLOYMENT_FIX.md's follow-up section.
 *
 * Uses `describe.sequential()` and a single dedicated mysql2 connection per
 * test (never a pool, never parallel `it()`s) for the same reason as every
 * other migration integration test in this repo: 0030's guarded index/
 * column checks use session-scoped @variables across
 * SET/PREPARE/EXECUTE/DEALLOCATE PREPARE, and this file additionally
 * manipulates shared, cross-file state (`__drizzle_migrations`) in its
 * regression scenario - never safe to interleave with another file's DB
 * work. Every connection is closed via closeMysqlConnectionSafely(), never
 * a bare `.end()`, per this repo's established safe-close helper (see
 * server/migration-0024-episode-schema-repair.integration.test.ts).
 */

const migrationsFolder = path.resolve(__dirname, "..", "drizzle");
const migrationSql = fs.readFileSync(path.join(migrationsFolder, "0030_repair_missing_daily_checkins.sql"), "utf8");
const statements = migrationSql
  .split("--> statement-breakpoint")
  .map((s) => s.trim())
  .filter(Boolean);

async function connect(): Promise<mysql.Connection | null> {
  if (!process.env.TEST_DATABASE_URL) return null;
  return mysql.createConnection(buildTestDbConnectionOptions(process.env.TEST_DATABASE_URL));
}

async function runMigrationStatements(conn: mysql.Connection): Promise<void> {
  for (const statement of statements) {
    await conn.query(statement);
  }
}

async function runFullChain(conn: mysql.Connection): Promise<void> {
  await runMigrationsWithLogging(conn, migrationsFolder, consoleMigrationLogger("[integration-test]"));
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

async function indexExists(conn: mysql.Connection, tableName: string, indexName: string): Promise<boolean> {
  const [rows]: any = await conn.query(
    `SELECT COUNT(*) as cnt FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
    [tableName, indexName]
  );
  return Number(rows[0].cnt) > 0;
}

async function indexColumns(conn: mysql.Connection, tableName: string, indexName: string): Promise<string[]> {
  const [rows]: any = await conn.query(
    `SELECT COLUMN_NAME as columnName FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? ORDER BY SEQ_IN_INDEX`,
    [tableName, indexName]
  );
  return rows.map((r: any) => r.columnName);
}

async function indexIsUnique(conn: mysql.Connection, tableName: string, indexName: string): Promise<boolean> {
  const [rows]: any = await conn.query(
    `SELECT NON_UNIQUE as nonUnique FROM information_schema.statistics
     WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? LIMIT 1`,
    [tableName, indexName]
  );
  return rows.length > 0 && Number(rows[0].nonUnique) === 0;
}

async function latestRecordedMigrationTimestamp(conn: mysql.Connection): Promise<number | null> {
  const [rows]: any = await conn.query(
    `SELECT created_at as createdAt FROM \`__drizzle_migrations\` ORDER BY created_at DESC LIMIT 1`
  );
  return rows[0] ? Number(rows[0].createdAt) : null;
}

async function queryLiveDatabaseName(conn: mysql.Connection): Promise<string | null> {
  const [rows]: any = await conn.query("SELECT DATABASE() AS name");
  return rows?.[0]?.name ?? null;
}

/** Restores dailyCheckins/coupons (raw SQL only - does not touch __drizzle_migrations bookkeeping). Always run in a finally block. */
async function restoreSchemaOnly(conn: mysql.Connection): Promise<void> {
  await restoreToFullyMigratedWithRetry(() => runMigrationStatements(conn), {
    connect,
    queryLiveDatabaseName,
    runCleanup: runMigrationStatements,
    closeConnection: (emergencyConn) => closeMysqlConnectionSafely(emergencyConn),
    expectedDatabaseName: EXPECTED_TEST_DATABASE_NAME,
  });
}

/** Restores the full migration chain, including __drizzle_migrations bookkeeping. Needed only by the regression test, which is the only test in this file that rewrites that table's history. */
async function restoreFullChain(conn: mysql.Connection): Promise<void> {
  await restoreToFullyMigratedWithRetry(() => runFullChain(conn), {
    connect,
    queryLiveDatabaseName,
    runCleanup: runFullChain,
    closeConnection: (emergencyConn) => closeMysqlConnectionSafely(emergencyConn),
    expectedDatabaseName: EXPECTED_TEST_DATABASE_NAME,
  });
}

/** Every test's own connection is always closed, even if schema restoration itself throws. */
async function cleanupTestConnection(conn: mysql.Connection): Promise<void> {
  try {
    await restoreSchemaOnly(conn);
  } finally {
    await closeMysqlConnectionSafely(conn);
  }
}

async function cleanupTestConnectionFullChain(conn: mysql.Connection): Promise<void> {
  try {
    await restoreFullChain(conn);
  } finally {
    await closeMysqlConnectionSafely(conn);
  }
}

const journal = readMigrationJournal(migrationsFolder);
const idx29When = journal.find((e) => e.tag === "0029_add_dynamic_daily_checkin_reward_schema")!.when;
const idx30When = journal.find((e) => e.tag === "0030_repair_missing_daily_checkins")!.when;
/** The last journal entry's timestamp - what a COMPLETED chain run must reach. Derived from the journal rather than pinned to a specific migration so adding a later migration (e.g. 0031) does not falsely fail "the chain finished". */
const finalJournalWhen = journal[journal.length - 1].when;

describe.sequential("migration 0030 - repair missing dailyCheckins (real disposable test database)", () => {
  it("1. dailyCheckins absent, coupons.maxDiscountAmount present - migration recreates the table and index without touching the column", async () => {
    const conn = await connect();
    if (!conn) return;
    try {
      await runMigrationStatements(conn); // known-good baseline (also ensures maxDiscountAmount exists)
      await conn.query("DROP TABLE IF EXISTS `dailyCheckins`");
      expect(await tableExists(conn, "dailyCheckins")).toBe(false);
      expect(await columnExists(conn, "coupons", "maxDiscountAmount")).toBe(true);

      await expect(runMigrationStatements(conn)).resolves.not.toThrow();

      expect(await tableExists(conn, "dailyCheckins")).toBe(true);
      expect(await indexExists(conn, "dailyCheckins", "dailyCheckins_userId_idx")).toBe(true);
      expect(await columnExists(conn, "coupons", "maxDiscountAmount")).toBe(true);
    } finally {
      await cleanupTestConnection(conn!);
    }
  }, 60000);

  it("2. dailyCheckins absent, coupons.maxDiscountAmount absent - migration creates both", async () => {
    const conn = await connect();
    if (!conn) return;
    try {
      await runMigrationStatements(conn); // known-good baseline
      await conn.query("DROP TABLE IF EXISTS `dailyCheckins`");
      if (await columnExists(conn, "coupons", "maxDiscountAmount")) {
        await conn.query("ALTER TABLE `coupons` DROP COLUMN `maxDiscountAmount`");
      }
      expect(await tableExists(conn, "dailyCheckins")).toBe(false);
      expect(await columnExists(conn, "coupons", "maxDiscountAmount")).toBe(false);

      await expect(runMigrationStatements(conn)).resolves.not.toThrow();

      expect(await tableExists(conn, "dailyCheckins")).toBe(true);
      expect(await indexExists(conn, "dailyCheckins", "dailyCheckins_userId_idx")).toBe(true);
      expect(await columnExists(conn, "coupons", "maxDiscountAmount")).toBe(true);
    } finally {
      await cleanupTestConnection(conn!);
    }
  }, 60000);

  it("3. dailyCheckins already complete (table, index, and column all present) - migration is a guarded no-op", async () => {
    const conn = await connect();
    if (!conn) return;
    try {
      await runMigrationStatements(conn);
      expect(await tableExists(conn, "dailyCheckins")).toBe(true);
      expect(await indexExists(conn, "dailyCheckins", "dailyCheckins_userId_idx")).toBe(true);
      expect(await columnExists(conn, "coupons", "maxDiscountAmount")).toBe(true);

      await expect(runMigrationStatements(conn)).resolves.not.toThrow();

      expect(await tableExists(conn, "dailyCheckins")).toBe(true);
      expect(await indexExists(conn, "dailyCheckins", "dailyCheckins_userId_idx")).toBe(true);
      expect(await columnExists(conn, "coupons", "maxDiscountAmount")).toBe(true);
    } finally {
      await cleanupTestConnection(conn!);
    }
  }, 60000);

  it("4. dailyCheckins present but userId index missing - migration creates only the missing index", async () => {
    const conn = await connect();
    if (!conn) return;
    try {
      await runMigrationStatements(conn); // known-good baseline
      await conn.query("ALTER TABLE `dailyCheckins` DROP INDEX `dailyCheckins_userId_idx`");
      expect(await tableExists(conn, "dailyCheckins")).toBe(true);
      expect(await indexExists(conn, "dailyCheckins", "dailyCheckins_userId_idx")).toBe(false);
      // The table's own unique constraints, untouched by the dropped
      // secondary index, remain present throughout.
      expect(await indexExists(conn, "dailyCheckins", "unique_daily_checkin_user_date_campaign")).toBe(true);

      await expect(runMigrationStatements(conn)).resolves.not.toThrow();

      expect(await indexExists(conn, "dailyCheckins", "dailyCheckins_userId_idx")).toBe(true);
    } finally {
      await cleanupTestConnection(conn!);
    }
  }, 60000);

  it("5. raw migration SQL runs twice in a row - no duplicate table/column/index errors", async () => {
    const conn = await connect();
    if (!conn) return;
    try {
      await conn.query("DROP TABLE IF EXISTS `dailyCheckins`");
      if (await columnExists(conn, "coupons", "maxDiscountAmount")) {
        await conn.query("ALTER TABLE `coupons` DROP COLUMN `maxDiscountAmount`");
      }

      await expect(runMigrationStatements(conn)).resolves.not.toThrow();
      await expect(runMigrationStatements(conn)).resolves.not.toThrow();

      expect(await tableExists(conn, "dailyCheckins")).toBe(true);
      expect(await indexExists(conn, "dailyCheckins", "dailyCheckins_userId_idx")).toBe(true);
      expect(await columnExists(conn, "coupons", "maxDiscountAmount")).toBe(true);
    } finally {
      await cleanupTestConnection(conn!);
    }
  }, 60000);

  it("6. final schema agrees with drizzle/schema.ts: all columns, enum values, and both unique constraints", async () => {
    const conn = await connect();
    if (!conn) return;
    try {
      await conn.query("DROP TABLE IF EXISTS `dailyCheckins`");
      await runMigrationStatements(conn);

      const expectedColumns = [
        "id",
        "userId",
        "checkinDate",
        "campaignKey",
        "couponId",
        "status",
        "issuedAt",
        "usedAt",
        "createdAt",
        "updatedAt",
      ];
      for (const column of expectedColumns) {
        expect(await columnExists(conn, "dailyCheckins", column)).toBe(true);
      }

      expect(await columnType(conn, "dailyCheckins", "status")).toBe("enum");
      const [enumRows]: any = await conn.query(
        `SELECT COLUMN_TYPE as columnType FROM information_schema.columns
         WHERE table_schema = DATABASE() AND table_name = 'dailyCheckins' AND column_name = 'status'`
      );
      const enumDefinition: string = enumRows[0].columnType;
      expect(enumDefinition).toContain("'issued'");
      expect(enumDefinition).toContain("'used'");
      expect(enumDefinition).toContain("'void'");

      // Both unique constraints exist, with the exact expected columns.
      expect(await indexIsUnique(conn, "dailyCheckins", "unique_daily_checkin_user_date_campaign")).toBe(true);
      expect(await indexColumns(conn, "dailyCheckins", "unique_daily_checkin_user_date_campaign")).toEqual([
        "userId",
        "checkinDate",
        "campaignKey",
      ]);
      expect(await indexIsUnique(conn, "dailyCheckins", "unique_daily_checkins_coupon")).toBe(true);
      expect(await indexColumns(conn, "dailyCheckins", "unique_daily_checkins_coupon")).toEqual(["couponId"]);

      // The secondary (non-unique) userId index.
      expect(await indexIsUnique(conn, "dailyCheckins", "dailyCheckins_userId_idx")).toBe(false);
      expect(await indexColumns(conn, "dailyCheckins", "dailyCheckins_userId_idx")).toEqual(["userId"]);

      // coupons.maxDiscountAmount is a nullable decimal, matching schema.ts exactly.
      expect(await columnType(conn, "coupons", "maxDiscountAmount")).toBe("decimal");
    } finally {
      await cleanupTestConnection(conn!);
    }
  }, 60000);

  it("7. existing coupons rows are preserved when maxDiscountAmount is added back", async () => {
    const conn = await connect();
    if (!conn) return;
    const couponCode = "IPENOVEL_0030_TEST_COUPON_PRESERVED";
    try {
      await runMigrationStatements(conn); // known-good baseline
      if (await columnExists(conn, "coupons", "maxDiscountAmount")) {
        await conn.query("ALTER TABLE `coupons` DROP COLUMN `maxDiscountAmount`");
      }
      await conn.query(
        `INSERT INTO \`coupons\` (code, discountType, discountValue, minPurchaseAmount, usageCount, isActive)
         VALUES (?, 'percentage', '5.00', '50.00', 0, true)`,
        [couponCode]
      );
      const [before]: any = await conn.query(`SELECT id, code, discountValue FROM \`coupons\` WHERE code = ?`, [couponCode]);
      expect(before).toHaveLength(1);
      const couponId = before[0].id;

      await expect(runMigrationStatements(conn)).resolves.not.toThrow();

      const [after]: any = await conn.query(
        `SELECT id, code, discountValue, maxDiscountAmount FROM \`coupons\` WHERE id = ?`,
        [couponId]
      );
      expect(after).toHaveLength(1);
      expect(after[0].code).toBe(couponCode);
      expect(after[0].discountValue).toBe("5.00");
      // ADD COLUMN on an existing row always backfills NULL for a nullable
      // column with no DEFAULT - proves the row was preserved, not
      // recreated, and nothing destructive happened to it.
      expect(after[0].maxDiscountAmount).toBeNull();
    } finally {
      await conn.query(`DELETE FROM \`coupons\` WHERE code = ?`, [couponCode]).catch(() => {});
      await cleanupTestConnection(conn!);
    }
  }, 60000);

  it("8. existing dailyCheckins rows are preserved when the table already exists", async () => {
    const conn = await connect();
    if (!conn) return;
    const couponCode = "IPENOVEL_0030_TEST_CHECKIN_COUPON";
    const testUserId = 9000030;
    try {
      await runMigrationStatements(conn); // table already exists going in
      const [couponResult]: any = await conn.query(
        `INSERT INTO \`coupons\` (code, discountType, discountValue, maxDiscountAmount, minPurchaseAmount, usageCount, isActive)
         VALUES (?, 'percentage', '5.00', '10.00', '50.00', 0, true)`,
        [couponCode]
      );
      const couponId = couponResult.insertId;
      const [checkinResult]: any = await conn.query(
        `INSERT INTO \`dailyCheckins\` (userId, checkinDate, campaignKey, couponId, status)
         VALUES (?, '2026-01-01', 'default', ?, 'issued')`,
        [testUserId, couponId]
      );
      const dailyCheckinId = checkinResult.insertId;

      await expect(runMigrationStatements(conn)).resolves.not.toThrow();

      const [rows]: any = await conn.query(`SELECT id, userId, checkinDate, couponId, status FROM \`dailyCheckins\` WHERE id = ?`, [
        dailyCheckinId,
      ]);
      expect(rows).toHaveLength(1);
      expect(rows[0].userId).toBe(testUserId);
      expect(rows[0].checkinDate).toBe("2026-01-01");
      expect(rows[0].couponId).toBe(couponId);
      expect(rows[0].status).toBe("issued");
    } finally {
      await conn.query(`DELETE FROM \`dailyCheckins\` WHERE userId = ?`, [testUserId]).catch(() => {});
      await conn.query(`DELETE FROM \`coupons\` WHERE code = ?`, [couponCode]).catch(() => {});
      await cleanupTestConnection(conn!);
    }
  }, 60000);

  it("9. REGRESSION: migration history already recorded through 0029 but dailyCheckins is missing - the exact confirmed production state - is repaired by 0030, and the journal high-water mark reaches 0030", async () => {
    const conn = await connect();
    if (!conn) return;
    try {
      await runFullChain(conn); // real chain run - __drizzle_migrations genuinely recorded through 0030
      expect(await tableExists(conn, "dailyCheckins")).toBe(true);

      // Reproduce the confirmed production state: recorded migration
      // history already past 0027 (and, in this rewind, past 0029 too),
      // but dailyCheckins physically absent - "the journal says it ran,
      // the schema disagrees" (see docs/DAILY_CHECKIN_DEPLOYMENT_FIX.md).
      // The table is dropped WITHOUT touching __drizzle_migrations, and the
      // high-water mark is rewound to exactly 0029 (simulating a database
      // that has never seen migration 0030 at all yet, matching real
      // production before this fix ships).
      await conn.query("DROP TABLE IF EXISTS `dailyCheckins`");
      await conn.query(`DELETE FROM \`__drizzle_migrations\` WHERE created_at > ?`, [idx29When]);
      expect(await tableExists(conn, "dailyCheckins")).toBe(false);
      const highWaterMarkBefore = await latestRecordedMigrationTimestamp(conn);
      expect(highWaterMarkBefore).toBe(idx29When);

      // Re-running the full chain must be the thing that repairs this -
      // not a rerun of 0027 (which would be skipped entirely, since the
      // recorded high-water mark is already past its timestamp).
      await expect(runFullChain(conn)).resolves.not.toThrow();

      expect(await tableExists(conn, "dailyCheckins")).toBe(true);
      expect(await indexExists(conn, "dailyCheckins", "dailyCheckins_userId_idx")).toBe(true);
      const highWaterMarkAfter = await latestRecordedMigrationTimestamp(conn);
      expect(highWaterMarkAfter).toBe(finalJournalWhen);
    } finally {
      // This test uniquely rewinds __drizzle_migrations bookkeeping -
      // restore the FULL chain (not just the raw schema) so later test
      // files in this run see a correctly-recorded history, not just
      // correct tables.
      await cleanupTestConnectionFullChain(conn!);
    }
  }, 60000);

  it("10. cleanup restores the fully migrated test database baseline", async () => {
    const conn = await connect();
    if (!conn) return;
    try {
      // No mutation in this test itself - it exists purely as a tripwire
      // that the shared restore helper (used in every other test's
      // `finally` block above) actually converges to a fully-migrated,
      // consistent baseline: table, index, column, and unique constraints
      // all present, and the recorded migration history reaches 0030.
      await restoreFullChain(conn);

      expect(await tableExists(conn, "dailyCheckins")).toBe(true);
      expect(await indexExists(conn, "dailyCheckins", "dailyCheckins_userId_idx")).toBe(true);
      expect(await indexExists(conn, "dailyCheckins", "unique_daily_checkin_user_date_campaign")).toBe(true);
      expect(await indexExists(conn, "dailyCheckins", "unique_daily_checkins_coupon")).toBe(true);
      expect(await columnExists(conn, "coupons", "maxDiscountAmount")).toBe(true);
      const highWaterMark = await latestRecordedMigrationTimestamp(conn);
      expect(highWaterMark).toBeGreaterThanOrEqual(idx30When);
    } finally {
      await closeMysqlConnectionSafely(conn!);
    }
  }, 60000);
});
