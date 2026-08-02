import { describe, it, expect } from "vitest";
import path from "node:path";
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
 * Live coverage for migration 0031 (dailyCheckins.couponId -> nullable)
 * against a real disposable database.
 *
 * Uses a single dedicated mysql2 connection rather than a pool for the same
 * reason as every other migration test here: the guarded migrations use
 * session-scoped @variables across SET/PREPARE/EXECUTE/DEALLOCATE, which
 * only behave correctly on one continuous session.
 */

const migrationsFolder = path.resolve(__dirname, "..", "drizzle");
const TIMEOUT = 180000;
const MIGRATION_0031_TAG = "0031_enable_daily_checkin_point_rewards";

function requireTestUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error("migration-0031 integration tests require TEST_DATABASE_URL (run `pnpm test:db:prepare`).");
  }
  return url;
}

async function connect(): Promise<mysql.Connection> {
  return mysql.createConnection(
    buildTestDbConnectionOptions(requireTestUrl(), parseTestDbTransportMode(process.env.TEST_DATABASE_TRANSPORT))
  );
}

async function runChain(conn: mysql.Connection): Promise<void> {
  await runMigrationsWithLogging(conn, migrationsFolder, consoleMigrationLogger("[migration-0031-test]"));
}

async function couponIdNullability(conn: mysql.Connection): Promise<string | null> {
  const [rows]: any = await conn.query(
    `SELECT IS_NULLABLE AS nullable FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = 'dailyCheckins' AND column_name = 'couponId'`
  );
  return rows[0]?.nullable ?? null;
}

async function recordedMigrationCount(conn: mysql.Connection): Promise<number> {
  const [rows]: any = await conn.query("SELECT COUNT(*) AS n FROM `__drizzle_migrations`");
  return Number(rows[0].n);
}

async function highWater(conn: mysql.Connection): Promise<number> {
  const [rows]: any = await conn.query("SELECT MAX(created_at) AS hw FROM `__drizzle_migrations`");
  return Number(rows[0].hw);
}

/** Rewinds recorded history to just before 0031 without altering the schema. Only ever safe to call immediately after an exact resetToMigrationCutoff(..., MIGRATION_0031_TAG) - see its call sites. */
async function rewindHistoryBefore0031(conn: mysql.Connection): Promise<void> {
  const when = readMigrationJournal(migrationsFolder).find((e) => e.tag === MIGRATION_0031_TAG)!.when;
  await conn.query("DELETE FROM `__drizzle_migrations` WHERE created_at >= ?", [when]);
}

describe.sequential("migration 0031 (real disposable test database)", () => {
  it(
    "a fresh database migrated through the full chain ends with a NULLABLE couponId, the unique index intact, and every journal migration recorded",
    async () => {
      const conn = await connect();
      try {
        await resetToEmptySchema(conn, requireTestUrl());
        await runChain(conn);

        expect(await couponIdNullability(conn)).toBe("YES");

        // Dynamic against the actual journal length/high-water tag rather
        // than a hardcoded count/tag - runChain() applies every migration
        // present in the folder (drizzle has no "stop at" mechanism), so a
        // hardcoded "32"/"0031" here would go stale every time a later
        // migration (e.g. 0032's coupon-ownership columns) is added, exactly
        // as it did when this test predated 0032 and asserted a count/tag
        // that were only ever true for a 0000-0031-only journal.
        const journal = readMigrationJournal(migrationsFolder);
        expect(await recordedMigrationCount(conn)).toBe(journal.length);
        expect(await highWater(conn)).toBe(journal[journal.length - 1].when);

        // The unique index survives - it is what still guarantees one coupon
        // is never attached to two check-ins.
        const [idx]: any = await conn.query(
          `SELECT NON_UNIQUE FROM information_schema.statistics
           WHERE table_schema = DATABASE() AND table_name = 'dailyCheckins'
             AND index_name = 'unique_daily_checkins_coupon' LIMIT 1`
        );
        expect(idx).toHaveLength(1);
        expect(Number(idx[0].NON_UNIQUE)).toBe(0);
      } finally {
        await closeMysqlConnectionSafely(conn);
      }
    },
    TIMEOUT
  );

  it(
    "upgrading an existing 0030-era database preserves every existing coupon-linked check-in row exactly",
    async () => {
      const conn = await connect();
      try {
        // Exact, verified 0000-0030 baseline via resetToMigrationCutoff() -
        // genuinely a "0030-era database", nothing from 0031 onward
        // physically exists yet, so this scenario never needs to touch
        // __drizzle_migrations at all (see the removed
        // wipeToEmpty()+runChain()+rewindHistoryBefore0031() sequence this
        // replaced, which established a FULL baseline through whatever the
        // newest migration is, e.g. 0034, then rewound only the journal -
        // leaving 0033's `authIdentities` and other later migrations'
        // unguarded CREATE TABLE statements to collide once treated as
        // pending again).
        await resetToMigrationCutoff(conn, requireTestUrl(), migrationsFolder, "0030_repair_missing_daily_checkins");

        // Simulate a pre-0031 production row: a coupon-linked check-in, with
        // couponId forced back to NOT NULL so the migration has real work.
        // (At this exact cutoff it should already be NOT NULL - the migration
        // that makes it nullable, 0031, hasn't run yet - but the explicit
        // MODIFY COLUMN + assertion below states that precondition directly
        // rather than assuming it.)
        await conn.query("DELETE FROM `dailyCheckins`");
        await conn.query("ALTER TABLE `dailyCheckins` MODIFY COLUMN `couponId` int NOT NULL");
        expect(await couponIdNullability(conn)).toBe("NO");

        const [userResult]: any = await conn.query(
          "INSERT INTO `users` (openId, name, email, loginMethod, role) VALUES (?,?,?,?,?)",
          [`m31-${Date.now()}`, "Migration 0031 User", `m31-${Date.now()}@example.test`, "test", "user"]
        );
        const userId = userResult.insertId;
        const [couponResult]: any = await conn.query(
          "INSERT INTO `coupons` (code, discountType, discountValue, minPurchaseAmount, usageCount, isActive) VALUES (?,?,?,?,?,?)",
          [`M31LEGACY${Date.now()}`, "percentage", "5.00", "50.00", 0, 1]
        );
        const couponId = couponResult.insertId;
        await conn.query(
          "INSERT INTO `dailyCheckins` (userId, checkinDate, campaignKey, couponId, status) VALUES (?,?,?,?,?)",
          [userId, "2026-07-01", "default", couponId, "issued"]
        );

        const [before]: any = await conn.query(
          "SELECT id, userId, checkinDate, campaignKey, couponId, status FROM `dailyCheckins` WHERE userId = ?",
          [userId]
        );

        // Rewind history and re-apply 0031 for real.
        await rewindHistoryBefore0031(conn);
        await runChain(conn);

        expect(await couponIdNullability(conn)).toBe("YES");

        const [after]: any = await conn.query(
          "SELECT id, userId, checkinDate, campaignKey, couponId, status FROM `dailyCheckins` WHERE userId = ?",
          [userId]
        );
        expect(after).toHaveLength(1);
        // Value-identical: no backfill, no rewrite, couponId preserved.
        expect(after[0]).toEqual(before[0]);
        expect(after[0].couponId).toBe(couponId);

        await conn.query("DELETE FROM `dailyCheckins` WHERE userId = ?", [userId]);
        await conn.query("DELETE FROM `coupons` WHERE id = ?", [couponId]);
        await conn.query("DELETE FROM `users` WHERE id = ?", [userId]);
      } finally {
        await closeMysqlConnectionSafely(conn);
      }
    },
    TIMEOUT
  );

  it(
    "re-running the chain is a no-op, and re-running 0031 against an already-nullable column is also a no-op",
    async () => {
      const conn = await connect();
      try {
        await runChain(conn);
        const countBefore = await recordedMigrationCount(conn);

        // Plain rerun: nothing pending.
        await runChain(conn);
        expect(await recordedMigrationCount(conn)).toBe(countBefore);

        // Partially-applied state: the DDL is already in place but history
        // says 0031 is pending. Reset to an exact, verified cutoff AT 0031
        // first - proving nothing later than 0031 physically exists - before
        // rewinding ONLY the 0031 journal row, so this reproduces "DDL
        // applied, journal pending" without risking any later migration's
        // unguarded CREATE TABLE colliding once the chain treats it as
        // pending again too. The guard must make it a safe no-op.
        await resetToMigrationCutoff(conn, requireTestUrl(), migrationsFolder, MIGRATION_0031_TAG);
        expect(await couponIdNullability(conn)).toBe("YES");
        await rewindHistoryBefore0031(conn);
        await expect(runChain(conn)).resolves.not.toThrow();
        expect(await couponIdNullability(conn)).toBe("YES");
        expect(await recordedMigrationCount(conn)).toBe(countBefore);
      } finally {
        await closeMysqlConnectionSafely(conn);
      }
    },
    TIMEOUT
  );

  it(
    "many point-only check-ins with couponId NULL coexist under the unique index",
    async () => {
      const conn = await connect();
      try {
        await runChain(conn);
        expect(await couponIdNullability(conn)).toBe("YES");

        const stamp = Date.now();
        const [u1]: any = await conn.query(
          "INSERT INTO `users` (openId, name, email, loginMethod, role) VALUES (?,?,?,?,?)",
          [`m31a-${stamp}`, "A", `m31a-${stamp}@example.test`, "test", "user"]
        );
        const [u2]: any = await conn.query(
          "INSERT INTO `users` (openId, name, email, loginMethod, role) VALUES (?,?,?,?,?)",
          [`m31b-${stamp}`, "B", `m31b-${stamp}@example.test`, "test", "user"]
        );

        // Three NULL-couponId rows: two users on one date, one user across
        // two dates. All must be accepted.
        await conn.query(
          "INSERT INTO `dailyCheckins` (userId, checkinDate, campaignKey, couponId, status) VALUES (?,?,?,NULL,?),(?,?,?,NULL,?),(?,?,?,NULL,?)",
          [
            u1.insertId, "2026-07-25", "default", "issued",
            u2.insertId, "2026-07-25", "default", "issued",
            u1.insertId, "2026-07-26", "default", "issued",
          ]
        );

        const [rows]: any = await conn.query(
          "SELECT COUNT(*) AS n FROM `dailyCheckins` WHERE couponId IS NULL AND userId IN (?,?)",
          [u1.insertId, u2.insertId]
        );
        expect(Number(rows[0].n)).toBe(3);

        // The same-day arbiter still rejects a duplicate for one user.
        let duplicateRejected = false;
        try {
          await conn.query(
            "INSERT INTO `dailyCheckins` (userId, checkinDate, campaignKey, couponId, status) VALUES (?,?,?,NULL,?)",
            [u1.insertId, "2026-07-25", "default", "issued"]
          );
        } catch (error: any) {
          duplicateRejected = error?.errno === 1062;
        }
        expect(duplicateRejected, "UNIQUE(userId, checkinDate, campaignKey) must still arbitrate").toBe(true);

        await conn.query("DELETE FROM `dailyCheckins` WHERE userId IN (?,?)", [u1.insertId, u2.insertId]);
        await conn.query("DELETE FROM `users` WHERE id IN (?,?)", [u1.insertId, u2.insertId]);
      } finally {
        await closeMysqlConnectionSafely(conn);
      }
    },
    TIMEOUT
  );
});
