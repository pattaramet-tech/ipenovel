import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import mysql from "mysql2/promise";
import { buildTestDbConnectionOptions } from "./test-helpers/testDbConnectionOptions";

/**
 * Proves the specific safety property the daily check-in incident review
 * required: migration 0027's raw SQL is safe to (re-)run whether the
 * target schema is fresh, partially applied, or fully applied - see
 * docs/INCIDENT_DAILY_CHECKIN_ROLLBACK.md's "Migration path" section.
 *
 * This deliberately executes the migration's SQL statements directly on a
 * dedicated connection (not through drizzle's migrate(), which tracks
 * applied migrations in __drizzle_migrations and would just skip re-running
 * an already-applied one - that would prove the tracking table works, not
 * that the SQL itself is idempotent, which is the actual property in
 * question). A dedicated mysql2 connection (not a pool) is required because
 * this migration uses session-scoped @variables across SET/PREPARE/EXECUTE
 * statements - a pooled connection could hand out a different underlying
 * connection between statements and break that chain (see
 * scripts/migrate.mjs's own comment on the same issue).
 *
 * Only ever runs in the integration project, which requires and verifies
 * TEST_DATABASE_URL (connection-string check + live "SELECT DATABASE()"
 * check for the exact literal "ipenovel_test") in
 * vitest.integration.globalsetup.ts before any test file in this project
 * loads - this file does not re-implement that check, it relies on the
 * project-level guarantee, exactly like every other *.integration.test.ts
 * file in this repo.
 */

const migrationSql = fs.readFileSync(
  path.resolve(__dirname, "..", "drizzle", "0027_add_daily_checkin_and_coupon_cap.sql"),
  "utf8"
);
const statements = migrationSql
  .split("--> statement-breakpoint")
  .map((s) => s.trim())
  .filter(Boolean);

async function runMigrationStatements(conn: mysql.Connection): Promise<void> {
  for (const statement of statements) {
    await conn.query(statement);
  }
}

// Migration 0027's own CREATE TABLE declares `dailyCheckins.couponId` NOT
// NULL - correct for what 0027 alone is responsible for, since it predates
// migration 0031 (which makes that column nullable for point-only
// check-ins). The "fresh database" test below drops `dailyCheckins` entirely
// and rebuilds it from 0027's raw SQL in isolation, which is exactly what
// this file is proving is safe - but doing that on the ONE shared
// integration-project database (vitest.integration.config.ts runs every
// *.integration.test.ts file sequentially against it, fileParallelism:
// false) leaves couponId back at NOT NULL for whichever file runs next,
// even after this file's own "restore full schema state" cleanup - that
// cleanup only ever re-ran 0027, so it never restored what 0031 undoes.
// Re-applying 0031's own guarded statements after 0027's is what actually
// restores the schema this test's own database is expected to be left in.
const migration0031Sql = fs.readFileSync(
  path.resolve(__dirname, "..", "drizzle", "0031_enable_daily_checkin_point_rewards.sql"),
  "utf8"
);
const migration0031Statements = migration0031Sql
  .split("--> statement-breakpoint")
  .map((s) => s.trim())
  .filter(Boolean);

async function restoreCouponIdNullability(conn: mysql.Connection): Promise<void> {
  for (const statement of migration0031Statements) {
    await conn.query(statement);
  }
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

async function indexExists(conn: mysql.Connection, tableName: string, indexName: string): Promise<boolean> {
  const [rows]: any = await conn.query(
    `SELECT COUNT(*) as cnt FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
    [tableName, indexName]
  );
  return Number(rows[0].cnt) > 0;
}

describe("migration 0027 idempotency (real disposable test database)", () => {
  it("is safe to run twice back-to-back against an already fully-applied schema", async () => {
    if (!process.env.TEST_DATABASE_URL) return; // matches this repo's guarded-DB-test convention; the integration project's own globalSetup already enforces this is set and safe when it runs for real
    const conn = await mysql.createConnection(buildTestDbConnectionOptions(process.env.TEST_DATABASE_URL));
    try {
      await runMigrationStatements(conn); // brings schema to fully-applied (no-op if already there)
      await expect(runMigrationStatements(conn)).resolves.not.toThrow(); // re-run: must not throw
      expect(await tableExists(conn, "dailyCheckins")).toBe(true);
      expect(await columnExists(conn, "coupons", "maxDiscountAmount")).toBe(true);
      expect(await indexExists(conn, "dailyCheckins", "dailyCheckins_userId_idx")).toBe(true);
    } finally {
      await conn.end();
    }
  });

  it("is safe when only the secondary index is missing (partially applied)", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    const conn = await mysql.createConnection(buildTestDbConnectionOptions(process.env.TEST_DATABASE_URL));
    try {
      await runMigrationStatements(conn); // ensure a known starting state
      await conn.query("DROP INDEX `dailyCheckins_userId_idx` ON `dailyCheckins`");
      expect(await indexExists(conn, "dailyCheckins", "dailyCheckins_userId_idx")).toBe(false);

      await expect(runMigrationStatements(conn)).resolves.not.toThrow();

      expect(await indexExists(conn, "dailyCheckins", "dailyCheckins_userId_idx")).toBe(true);
    } finally {
      await runMigrationStatements(conn).catch(() => {}); // always leave the schema fully migrated
      await restoreCouponIdNullability(conn).catch(() => {}); // ...including 0031's nullable couponId, which 0027 alone does not know about
      await conn.end();
    }
  });

  it("is safe on a fresh database where neither dailyCheckins nor coupons.maxDiscountAmount exist yet", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    const conn = await mysql.createConnection(buildTestDbConnectionOptions(process.env.TEST_DATABASE_URL));
    try {
      await conn.query("DROP TABLE IF EXISTS `dailyCheckins`");
      if (await columnExists(conn, "coupons", "maxDiscountAmount")) {
        await conn.query("ALTER TABLE `coupons` DROP COLUMN `maxDiscountAmount`");
      }
      expect(await tableExists(conn, "dailyCheckins")).toBe(false);
      expect(await columnExists(conn, "coupons", "maxDiscountAmount")).toBe(false);

      await expect(runMigrationStatements(conn)).resolves.not.toThrow();

      expect(await tableExists(conn, "dailyCheckins")).toBe(true);
      expect(await columnExists(conn, "coupons", "maxDiscountAmount")).toBe(true);
      expect(await indexExists(conn, "dailyCheckins", "dailyCheckins_userId_idx")).toBe(true);
    } finally {
      // Always restore full schema state for every other integration test
      // file in this run, regardless of pass/fail above - "full" includes
      // migration 0031's nullable couponId, since this test drops and
      // rebuilds dailyCheckins from 0027's raw SQL alone (couponId NOT NULL).
      await runMigrationStatements(conn).catch(() => {});
      await restoreCouponIdNullability(conn).catch(() => {});
      await conn.end();
    }
  });
});
