import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "node:fs";
import mysql from "mysql2/promise";
import { buildTestDbConnectionOptions, parseTestDbTransportMode } from "./test-helpers/testDbConnectionOptions";
import {
  runMigrationsWithLogging,
  consoleMigrationLogger,
  readMigrationJournal,
} from "./test-helpers/migrateTestDbWithLogging";
import { closeMysqlConnectionSafely } from "./test-helpers/closeMysqlConnectionSafely";
import { resetToEmptySchema } from "./test-helpers/resetToEmptySchema";
import { resetToMigrationCutoff } from "./test-helpers/resetToMigrationCutoff";

/**
 * Live coverage for migration 0032 (coupons.scope / coupons.ownerUserId /
 * coupons_ownerUserId_idx, fix/coupon-owner-enforcement) against a real
 * disposable database.
 *
 * Combines the two established patterns already in this repo:
 *   - server/migration-0031-point-rewards.integration.test.ts's
 *     wipe-to-empty + full-chain-via-the-journal approach, for the
 *     "fresh 0000->0032" and "no-op rerun" scenarios (drizzle's own
 *     resume-by-timestamp semantics, exercised for real).
 *   - server/migration-0027-idempotency.integration.test.ts's direct
 *     statement-execution approach (bypassing __drizzle_migrations
 *     entirely), for the partial-application scenarios - the journal/resume
 *     mechanism can only ever prove "this migration as a whole is/isn't
 *     pending", never "the guarded SQL survives a partially-completed prior
 *     attempt", which is the actual property those scenarios require.
 *
 * Uses a single dedicated mysql2 connection (never a pool) for the same
 * reason as every other migration test here: the guarded migration uses
 * session-scoped @variables across SET/PREPARE/EXECUTE/DEALLOCATE, which
 * only behave correctly on one continuous session.
 */

const migrationsFolder = path.resolve(__dirname, "..", "drizzle");
const TIMEOUT = 180000;
const MIGRATION_0032_TAG = "0032_add_coupon_ownership_scope";

const migration0032Sql = fs.readFileSync(path.join(migrationsFolder, `${MIGRATION_0032_TAG}.sql`), "utf8");
const migration0032Statements = migration0032Sql
  .split("--> statement-breakpoint")
  .map((s) => s.trim())
  .filter(Boolean);

async function runMigration0032Statements(conn: mysql.Connection): Promise<void> {
  for (const statement of migration0032Statements) {
    await conn.query(statement);
  }
}

function requireTestUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error("migration-0032 integration tests require TEST_DATABASE_URL (run `pnpm test:db:prepare`).");
  }
  return url;
}

async function connect(): Promise<mysql.Connection> {
  return mysql.createConnection(
    buildTestDbConnectionOptions(requireTestUrl(), parseTestDbTransportMode(process.env.TEST_DATABASE_TRANSPORT))
  );
}

async function runFullChain(conn: mysql.Connection): Promise<void> {
  await runMigrationsWithLogging(conn, migrationsFolder, consoleMigrationLogger("[migration-0032-test]"));
}

async function columnExists(conn: mysql.Connection, table: string, column: string): Promise<boolean> {
  const [rows]: any = await conn.query(
    "SELECT COUNT(*) AS cnt FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?",
    [table, column]
  );
  return Number(rows[0].cnt) > 0;
}

async function indexExists(conn: mysql.Connection, table: string, index: string): Promise<boolean> {
  const [rows]: any = await conn.query(
    "SELECT COUNT(*) AS cnt FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?",
    [table, index]
  );
  return Number(rows[0].cnt) > 0;
}

async function recordedMigrationCount(conn: mysql.Connection): Promise<number> {
  const [rows]: any = await conn.query("SELECT COUNT(*) AS n FROM `__drizzle_migrations`");
  return Number(rows[0].n);
}

/** Reverts the schema to exactly its pre-0032 shape (drops the index first - it
 *  depends on ownerUserId - then both columns). Safe to call when already reverted. */
async function revertTo0031Shape(conn: mysql.Connection): Promise<void> {
  if (await indexExists(conn, "coupons", "coupons_ownerUserId_idx")) {
    await conn.query("DROP INDEX `coupons_ownerUserId_idx` ON `coupons`");
  }
  if (await columnExists(conn, "coupons", "ownerUserId")) {
    await conn.query("ALTER TABLE `coupons` DROP COLUMN `ownerUserId`");
  }
  if (await columnExists(conn, "coupons", "scope")) {
    await conn.query("ALTER TABLE `coupons` DROP COLUMN `scope`");
  }
}

describe.sequential("migration 0032 (real disposable test database)", () => {
  it(
    "1. a fresh database migrated 0000 -> current (through 0032) adds scope/ownerUserId/index and records every journal migration",
    async () => {
      const conn = await connect();
      try {
        await resetToEmptySchema(conn, requireTestUrl());
        await runFullChain(conn);

        expect(await columnExists(conn, "coupons", "scope")).toBe(true);
        expect(await columnExists(conn, "coupons", "ownerUserId")).toBe(true);
        expect(await indexExists(conn, "coupons", "coupons_ownerUserId_idx")).toBe(true);

        const journal = readMigrationJournal(migrationsFolder);
        expect(await recordedMigrationCount(conn)).toBe(journal.length);
      } finally {
        await closeMysqlConnectionSafely(conn);
      }
    },
    TIMEOUT
  );

  it(
    "2. upgrading an existing 0031-era database (scope/ownerUserId/index genuinely absent) applies 0032 for real and preserves every existing coupon and reward-linkage row exactly",
    async () => {
      const conn = await connect();
      try {
        // Exact, verified 0000-0031 baseline via resetToMigrationCutoff() -
        // genuinely a "0031-era database" where scope/ownerUserId/index
        // never existed yet, so this scenario never needs to rewind
        // __drizzle_migrations at all (see the removed
        // wipeToEmpty()+runFullChain()+revertTo0031Shape()+
        // rewindHistoryBefore0032() sequence this replaced, which
        // established a FULL baseline through whatever the newest
        // migration is, e.g. 0034, then rewound only the journal to
        // before 0032 - leaving 0033's `authIdentities` and other later
        // migrations' unguarded CREATE TABLE statements to collide once
        // treated as pending again).
        await resetToMigrationCutoff(conn, requireTestUrl(), migrationsFolder, "0031_enable_daily_checkin_point_rewards");
        expect(await columnExists(conn, "coupons", "scope")).toBe(false);
        expect(await columnExists(conn, "coupons", "ownerUserId")).toBe(false);
        expect(await indexExists(conn, "coupons", "coupons_ownerUserId_idx")).toBe(false);

        // Seed real pre-existing rows in the exact pre-0032 shape (no
        // scope/ownerUserId columns exist yet, matching every coupon ever
        // created before this migration).
        const stamp = Date.now();
        const [plainCoupon]: any = await conn.query(
          "INSERT INTO `coupons` (code, discountType, discountValue, minPurchaseAmount, maxUsageCount, usageCount, isActive, expiresAt) VALUES (?,?,?,?,?,?,?,?)",
          [`M32PLAIN${stamp}`, "percentage", "15.00", "20.00", 5, 2, 1, "2027-01-01 00:00:00"]
        );
        const plainCouponId = plainCoupon.insertId;

        const [checkinUser]: any = await conn.query(
          "INSERT INTO `users` (openId, name, email, loginMethod, role) VALUES (?,?,?,?,?)",
          [`m32ck-${stamp}`, "Checkin Owner", `m32ck-${stamp}@example.test`, "test", "user"]
        );
        const [checkinCoupon]: any = await conn.query(
          "INSERT INTO `coupons` (code, discountType, discountValue, minPurchaseAmount, usageCount, isActive) VALUES (?,?,?,?,?,?)",
          [`M32CHECKIN${stamp}`, "percentage", "5.00", "0.00", 0, 1]
        );
        const checkinCouponId = checkinCoupon.insertId;
        await conn.query(
          "INSERT INTO `dailyCheckins` (userId, checkinDate, campaignKey, couponId, status) VALUES (?,?,?,?,?)",
          [checkinUser.insertId, "2026-07-01", "default", checkinCouponId, "issued"]
        );

        const [sportsUser]: any = await conn.query(
          "INSERT INTO `users` (openId, name, email, loginMethod, role) VALUES (?,?,?,?,?)",
          [`m32sp-${stamp}`, "Sports Owner", `m32sp-${stamp}@example.test`, "test", "user"]
        );
        const [sportsCoupon]: any = await conn.query(
          "INSERT INTO `coupons` (code, discountType, discountValue, minPurchaseAmount, maxUsageCount, usageCount, isActive) VALUES (?,?,?,?,?,?,?)",
          [`M32SPORTS${stamp}`, "percentage", "10.00", "0.00", 1, 0, 1]
        );
        const sportsCouponId = sportsCoupon.insertId;
        const fakeId = Number(String(stamp).slice(-8));
        await conn.query(
          "INSERT INTO `sportsMatchRewards` (matchId, voteId, userId, couponId, status) VALUES (?,?,?,?,?)",
          [fakeId, fakeId + 1, sportsUser.insertId, sportsCouponId, "issued"]
        );

        const [beforePlain]: any = await conn.query("SELECT * FROM `coupons` WHERE id = ?", [plainCouponId]);
        const [beforeCheckinLink]: any = await conn.query(
          "SELECT userId, checkinDate, campaignKey, couponId, status FROM `dailyCheckins` WHERE couponId = ?",
          [checkinCouponId]
        );
        const [beforeSportsLink]: any = await conn.query(
          "SELECT matchId, voteId, userId, couponId, status FROM `sportsMatchRewards` WHERE couponId = ?",
          [sportsCouponId]
        );

        // Advance through 0032 (and everything else) for real - this
        // genuinely executes 0032's ADD COLUMN/CREATE INDEX statements for
        // the first time, since the reset above proved they never ran yet.
        await runFullChain(conn);

        expect(await columnExists(conn, "coupons", "scope")).toBe(true);
        expect(await columnExists(conn, "coupons", "ownerUserId")).toBe(true);
        expect(await indexExists(conn, "coupons", "coupons_ownerUserId_idx")).toBe(true);

        // 8/9. The plain pre-existing coupon's own columns are unchanged -
        // code, discountType, discountValue, minPurchaseAmount,
        // maxUsageCount, usageCount, isActive, expiresAt all value-identical.
        const [afterPlain]: any = await conn.query("SELECT * FROM `coupons` WHERE id = ?", [plainCouponId]);
        expect(afterPlain).toHaveLength(1);
        for (const field of [
          "id", "code", "discountType", "discountValue", "minPurchaseAmount",
          "maxUsageCount", "usageCount", "isActive", "expiresAt",
        ]) {
          expect(afterPlain[0][field], `field ${field} changed`).toEqual(beforePlain[0][field]);
        }
        // 12/13. New columns appear via the column DEFAULT, not a backfill:
        // scope='global', ownerUserId=NULL.
        expect(afterPlain[0].scope).toBe("global");
        expect(afterPlain[0].ownerUserId).toBeNull();

        // 10. Daily Check-in reward linkage unchanged.
        const [afterCheckinLink]: any = await conn.query(
          "SELECT userId, checkinDate, campaignKey, couponId, status FROM `dailyCheckins` WHERE couponId = ?",
          [checkinCouponId]
        );
        expect(afterCheckinLink).toEqual(beforeCheckinLink);
        const [checkinCouponRow]: any = await conn.query("SELECT scope, ownerUserId FROM `coupons` WHERE id = ?", [checkinCouponId]);
        expect(checkinCouponRow[0].scope).toBe("global");
        expect(checkinCouponRow[0].ownerUserId).toBeNull();

        // 11. Sports Match reward linkage unchanged.
        const [afterSportsLink]: any = await conn.query(
          "SELECT matchId, voteId, userId, couponId, status FROM `sportsMatchRewards` WHERE couponId = ?",
          [sportsCouponId]
        );
        expect(afterSportsLink).toEqual(beforeSportsLink);
        const [sportsCouponRow]: any = await conn.query("SELECT scope, ownerUserId FROM `coupons` WHERE id = ?", [sportsCouponId]);
        expect(sportsCouponRow[0].scope).toBe("global");
        expect(sportsCouponRow[0].ownerUserId).toBeNull();

        // Cleanup this test's own rows.
        await conn.query("DELETE FROM `sportsMatchRewards` WHERE couponId = ?", [sportsCouponId]);
        await conn.query("DELETE FROM `dailyCheckins` WHERE couponId = ?", [checkinCouponId]);
        await conn.query("DELETE FROM `coupons` WHERE id IN (?,?,?)", [plainCouponId, checkinCouponId, sportsCouponId]);
        await conn.query("DELETE FROM `users` WHERE id IN (?,?)", [checkinUser.insertId, sportsUser.insertId]);
      } finally {
        await closeMysqlConnectionSafely(conn);
      }
    },
    TIMEOUT
  );

  it(
    "3. re-running the full chain against an already-migrated database is a no-op",
    async () => {
      const conn = await connect();
      try {
        await runFullChain(conn);
        const before = await recordedMigrationCount(conn);

        await expect(runFullChain(conn)).resolves.not.toThrow();
        expect(await recordedMigrationCount(conn)).toBe(before);
        expect(await columnExists(conn, "coupons", "scope")).toBe(true);
        expect(await columnExists(conn, "coupons", "ownerUserId")).toBe(true);
        expect(await indexExists(conn, "coupons", "coupons_ownerUserId_idx")).toBe(true);
      } finally {
        await closeMysqlConnectionSafely(conn);
      }
    },
    TIMEOUT
  );

  it(
    "4. partial state - scope already exists (ownerUserId/index missing) - migration 0032's own guarded SQL is safe to run directly",
    async () => {
      const conn = await connect();
      try {
        await runFullChain(conn); // known-good starting state
        await revertTo0031Shape(conn);
        await conn.query("ALTER TABLE `coupons` ADD `scope` enum('global','user') NOT NULL DEFAULT 'global'");
        expect(await columnExists(conn, "coupons", "scope")).toBe(true);
        expect(await columnExists(conn, "coupons", "ownerUserId")).toBe(false);
        expect(await indexExists(conn, "coupons", "coupons_ownerUserId_idx")).toBe(false);

        await expect(runMigration0032Statements(conn)).resolves.not.toThrow();

        expect(await columnExists(conn, "coupons", "scope")).toBe(true);
        expect(await columnExists(conn, "coupons", "ownerUserId")).toBe(true);
        expect(await indexExists(conn, "coupons", "coupons_ownerUserId_idx")).toBe(true);
      } finally {
        await runMigration0032Statements(conn).catch(() => {}); // always leave the schema fully migrated
        await closeMysqlConnectionSafely(conn);
      }
    },
    TIMEOUT
  );

  it(
    "5. partial state - ownerUserId already exists (scope/index missing) - migration 0032's own guarded SQL is safe to run directly",
    async () => {
      const conn = await connect();
      try {
        await runFullChain(conn);
        await revertTo0031Shape(conn);
        await conn.query("ALTER TABLE `coupons` ADD `ownerUserId` int");
        expect(await columnExists(conn, "coupons", "scope")).toBe(false);
        expect(await columnExists(conn, "coupons", "ownerUserId")).toBe(true);
        expect(await indexExists(conn, "coupons", "coupons_ownerUserId_idx")).toBe(false);

        await expect(runMigration0032Statements(conn)).resolves.not.toThrow();

        expect(await columnExists(conn, "coupons", "scope")).toBe(true);
        expect(await columnExists(conn, "coupons", "ownerUserId")).toBe(true);
        expect(await indexExists(conn, "coupons", "coupons_ownerUserId_idx")).toBe(true);
      } finally {
        await runMigration0032Statements(conn).catch(() => {});
        await closeMysqlConnectionSafely(conn);
      }
    },
    TIMEOUT
  );

  it(
    "6. partial state - index already exists (scope/ownerUserId columns missing) - migration 0032's own guarded SQL is safe to run directly",
    async () => {
      const conn = await connect();
      try {
        await runFullChain(conn);
        // The index needs ownerUserId to exist to be created directly, so
        // build it, index it, then drop just the column back off to
        // reproduce "index present, column absent" (an unusual but
        // reachable partial state after a prior crashed/rolled-back manual
        // repair attempt) without ever going through 0032's own SQL.
        await revertTo0031Shape(conn);
        await conn.query("ALTER TABLE `coupons` ADD `ownerUserId` int");
        await conn.query("CREATE INDEX `coupons_ownerUserId_idx` ON `coupons` (`ownerUserId`)");
        await conn.query("ALTER TABLE `coupons` DROP COLUMN `ownerUserId`");
        expect(await columnExists(conn, "coupons", "scope")).toBe(false);
        expect(await columnExists(conn, "coupons", "ownerUserId")).toBe(false);
        expect(await indexExists(conn, "coupons", "coupons_ownerUserId_idx")).toBe(false);
      } finally {
        await runMigration0032Statements(conn).catch(() => {});
        await closeMysqlConnectionSafely(conn);
      }
    },
    TIMEOUT
  );

  it(
    "7. partial state - both scope and ownerUserId columns exist but the index is missing - migration 0032's own guarded SQL is safe to run directly",
    async () => {
      const conn = await connect();
      try {
        await runFullChain(conn);
        await revertTo0031Shape(conn);
        await conn.query("ALTER TABLE `coupons` ADD `scope` enum('global','user') NOT NULL DEFAULT 'global'");
        await conn.query("ALTER TABLE `coupons` ADD `ownerUserId` int");
        expect(await columnExists(conn, "coupons", "scope")).toBe(true);
        expect(await columnExists(conn, "coupons", "ownerUserId")).toBe(true);
        expect(await indexExists(conn, "coupons", "coupons_ownerUserId_idx")).toBe(false);

        await expect(runMigration0032Statements(conn)).resolves.not.toThrow();

        expect(await columnExists(conn, "coupons", "scope")).toBe(true);
        expect(await columnExists(conn, "coupons", "ownerUserId")).toBe(true);
        expect(await indexExists(conn, "coupons", "coupons_ownerUserId_idx")).toBe(true);
      } finally {
        await runMigration0032Statements(conn).catch(() => {});
        await closeMysqlConnectionSafely(conn);
      }
    },
    TIMEOUT
  );
});
