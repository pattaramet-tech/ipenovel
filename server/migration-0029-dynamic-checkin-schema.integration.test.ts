import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import mysql from "mysql2/promise";
import { buildTestDbConnectionOptions } from "./test-helpers/testDbConnectionOptions";
import { runMigrationsWithLogging, consoleMigrationLogger, readMigrationJournal } from "./test-helpers/migrateTestDbWithLogging";
import { restoreToFullyMigratedWithRetry } from "./test-helpers/restoreWithEmergencyRetry";
import { EXPECTED_TEST_DATABASE_NAME } from "./test-helpers/testDatabaseGuard";

/**
 * Real-database coverage for migration 0029 (Stage 1A of the configurable
 * daily check-in reward system - see
 * docs/DAILY_CHECKIN_DYNAMIC_REWARDS_DESIGN.md). Every test here is
 * self-guarded (`if (!process.env.TEST_DATABASE_URL) return`) and
 * additionally relies on the integration project's own globalSetup, which
 * independently verifies TEST_DATABASE_URL via both the connection-string
 * check and a live "SELECT DATABASE()" check before any test file in this
 * project loads - see vitest.integration.globalsetup.ts. This file never
 * runs against anything but a verified, disposable "ipenovel_test"
 * database.
 *
 * Uses a single dedicated mysql2 connection (never a pool) throughout, for
 * the same session-variable-continuity reason documented in
 * server/migration-0027-idempotency.integration.test.ts (this migration's
 * guarded index creation uses session-scoped @variables across
 * SET/PREPARE/EXECUTE).
 *
 * "Partially exist" (required scenario 3) is deliberately interpreted as a
 * MIXED per-table presence state (some of the four new tables fully
 * present, others entirely absent) rather than a partial-column state on
 * any one of them: these four tables are all introduced in this single
 * migration, so - unlike migration 0024's guarded ADD COLUMN treatment of
 * the pre-existing `episodes` table - there is no earlier migration that
 * could have left one of them with an incomplete column set.
 * CREATE TABLE IF NOT EXISTS already fully covers "does not exist yet" for
 * every column of a table at once; the only realistic partial state is
 * either a whole table missing (covered here) or some of a present table's
 * own secondary/unique indexes missing (scenario 2). See migration
 * 0029's own header comment for the same rationale.
 */

const migrationsFolder = path.resolve(__dirname, "..", "drizzle");
const migrationSql = fs.readFileSync(
  path.join(migrationsFolder, "0029_add_dynamic_daily_checkin_reward_schema.sql"),
  "utf8"
);
const statements = migrationSql
  .split("--> statement-breakpoint")
  .map((s) => s.trim())
  .filter(Boolean);

const NEW_TABLES = [
  "dailyCheckinCampaigns",
  "dailyCheckinCouponTemplates",
  "dailyCheckinRewardRules",
  "dailyCheckinRewardGrants",
] as const;

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

async function dropAllNewTables(conn: mysql.Connection): Promise<void> {
  // Children before parents purely for tidiness - there are no DB-enforced
  // foreign keys anywhere in this schema (logical references only,
  // consistent with every other table here), so order doesn't matter
  // functionally.
  for (const t of [...NEW_TABLES].reverse()) {
    await conn.query(`DROP TABLE IF EXISTS \`${t}\``);
  }
}

async function queryLiveDatabaseName(conn: mysql.Connection): Promise<string | null> {
  const [rows]: any = await conn.query("SELECT DATABASE() AS name");
  return rows?.[0]?.name ?? null;
}

/** Restores the four new tables/indexes (raw SQL only - does not touch __drizzle_migrations bookkeeping). Always run in a finally block. */
async function restoreSchemaOnly(conn: mysql.Connection): Promise<void> {
  await restoreToFullyMigratedWithRetry(() => runMigrationStatements(conn), {
    connect,
    queryLiveDatabaseName,
    runCleanup: runMigrationStatements,
    closeConnection: (emergencyConn) => emergencyConn.end(),
    expectedDatabaseName: EXPECTED_TEST_DATABASE_NAME,
  });
}

/** Restores the full migration chain, including __drizzle_migrations bookkeeping. Only needed by the history-rewind test (6), which is the only test in this file that touches that table. */
async function restoreFullChain(conn: mysql.Connection): Promise<void> {
  await restoreToFullyMigratedWithRetry(() => runFullChain(conn), {
    connect,
    queryLiveDatabaseName,
    runCleanup: runFullChain,
    closeConnection: (emergencyConn) => emergencyConn.end(),
    expectedDatabaseName: EXPECTED_TEST_DATABASE_NAME,
  });
}

/** Every test's own connection is always closed, even if schema restoration itself throws. */
async function cleanupTestConnection(conn: mysql.Connection): Promise<void> {
  try {
    await restoreSchemaOnly(conn);
  } finally {
    await conn.end();
  }
}

async function cleanupTestConnectionFullChain(conn: mysql.Connection): Promise<void> {
  try {
    await restoreFullChain(conn);
  } finally {
    await conn.end();
  }
}

/** Deletes exactly the synthetic dailyCheckinRewardGrants rows a constraint test inserted, then restores schema and always closes the connection - the DELETE's own failure is never silently swallowed, it still propagates after the connection is safely closed. */
async function teardownWithGrantIds(conn: mysql.Connection, insertedIds: number[]): Promise<void> {
  try {
    if (insertedIds.length > 0) {
      await conn.query(`DELETE FROM \`dailyCheckinRewardGrants\` WHERE id IN (${insertedIds.join(",")})`);
    }
  } finally {
    await cleanupTestConnection(conn);
  }
}

interface GrantFixture {
  dailyCheckinId: number;
  userId: number;
  campaignId: number;
  ruleId: number;
  rewardKind: "points" | "coupon";
  grantReason: "daily" | "milestone";
  milestoneInstanceNumber?: number | null;
  streakCountAtGrant?: number;
  couponId?: number | null;
  pointsTransactionId?: number | null;
}

/** Inserts a minimal, synthetic dailyCheckinRewardGrants row - dailyCheckinId/userId/campaignId/ruleId/couponId/pointsTransactionId are plain logical references (no FK constraints exist anywhere in this schema), so arbitrary large integers are used without needing real parent rows. */
async function insertGrant(conn: mysql.Connection, fixture: GrantFixture): Promise<number> {
  const [result]: any = await conn.query(
    `INSERT INTO \`dailyCheckinRewardGrants\`
     (dailyCheckinId, userId, campaignId, ruleId, rewardKind, grantReason, milestoneInstanceNumber, streakCountAtGrant, couponId, pointsTransactionId)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      fixture.dailyCheckinId,
      fixture.userId,
      fixture.campaignId,
      fixture.ruleId,
      fixture.rewardKind,
      fixture.grantReason,
      fixture.milestoneInstanceNumber ?? null,
      fixture.streakCountAtGrant ?? 1,
      fixture.couponId ?? null,
      fixture.pointsTransactionId ?? null,
    ]
  );
  return result.insertId;
}

const journal = readMigrationJournal(migrationsFolder);
const idx29When = journal.find((e) => e.tag === "0029_add_dynamic_daily_checkin_reward_schema")!.when;

describe("migration 0029 - dynamic daily check-in reward schema (real disposable test database)", () => {
  it("1. all four tables absent - migration creates all tables and indexes", async () => {
    const conn = await connect();
    if (!conn) return;
    try {
      await dropAllNewTables(conn);
      for (const t of NEW_TABLES) {
        expect(await tableExists(conn, t)).toBe(false);
      }

      await expect(runMigrationStatements(conn)).resolves.not.toThrow();

      for (const t of NEW_TABLES) {
        expect(await tableExists(conn, t)).toBe(true);
      }
      expect(await indexExists(conn, "dailyCheckinCampaigns", "dailyCheckinCampaigns_campaignKey_unique")).toBe(true);
      expect(await indexExists(conn, "dailyCheckinCampaigns", "dailyCheckinCampaigns_status_date_idx")).toBe(true);
      expect(await indexExists(conn, "dailyCheckinCouponTemplates", "dailyCheckinCouponTemplates_campaignId_idx")).toBe(true);
      expect(await indexExists(conn, "dailyCheckinRewardRules", "dailyCheckinRewardRules_campaign_dedupe_unique")).toBe(true);
      expect(await indexExists(conn, "dailyCheckinRewardRules", "dailyCheckinRewardRules_campaign_active_idx")).toBe(true);
      expect(await indexExists(conn, "dailyCheckinRewardGrants", "dailyCheckinRewardGrants_checkin_rule_unique")).toBe(true);
      expect(await indexExists(conn, "dailyCheckinRewardGrants", "dailyCheckinRewardGrants_user_rule_instance_unique")).toBe(true);
      expect(await indexExists(conn, "dailyCheckinRewardGrants", "dailyCheckinRewardGrants_campaign_idx")).toBe(true);
      expect(await indexExists(conn, "dailyCheckinRewardGrants", "dailyCheckinRewardGrants_user_created_idx")).toBe(true);
      expect(await indexExists(conn, "dailyCheckinRewardGrants", "dailyCheckinRewardGrants_status_idx")).toBe(true);
      expect(await indexExists(conn, "dailyCheckinRewardGrants", "dailyCheckinRewardGrants_couponId_unique")).toBe(true);
      expect(await indexExists(conn, "dailyCheckinRewardGrants", "dailyCheckinRewardGrants_pointsTransactionId_unique")).toBe(true);
    } finally {
      await cleanupTestConnection(conn!);
    }
  }, 60000);

  it("2. tables exist but some indexes are missing - migration creates only the missing indexes", async () => {
    const conn = await connect();
    if (!conn) return;
    try {
      await runMigrationStatements(conn); // known-good baseline
      await conn.query("ALTER TABLE `dailyCheckinRewardGrants` DROP INDEX `dailyCheckinRewardGrants_status_idx`");
      await conn.query("ALTER TABLE `dailyCheckinCampaigns` DROP INDEX `dailyCheckinCampaigns_status_date_idx`");
      expect(await indexExists(conn, "dailyCheckinRewardGrants", "dailyCheckinRewardGrants_status_idx")).toBe(false);
      expect(await indexExists(conn, "dailyCheckinCampaigns", "dailyCheckinCampaigns_status_date_idx")).toBe(false);
      // Untouched indexes remain present throughout - proves the migration
      // only fills the gap, not that it happened to recreate everything.
      expect(await indexExists(conn, "dailyCheckinCampaigns", "dailyCheckinCampaigns_campaignKey_unique")).toBe(true);

      await expect(runMigrationStatements(conn)).resolves.not.toThrow();

      expect(await indexExists(conn, "dailyCheckinRewardGrants", "dailyCheckinRewardGrants_status_idx")).toBe(true);
      expect(await indexExists(conn, "dailyCheckinCampaigns", "dailyCheckinCampaigns_status_date_idx")).toBe(true);
    } finally {
      await cleanupTestConnection(conn!);
    }
  }, 60000);

  it("3. some tables fully present while others are entirely absent - migration completes only the missing ones safely", async () => {
    const conn = await connect();
    if (!conn) return;
    try {
      await runMigrationStatements(conn); // full baseline: all four present + indexed
      await conn.query("DROP TABLE IF EXISTS `dailyCheckinRewardGrants`");
      await conn.query("DROP TABLE IF EXISTS `dailyCheckinRewardRules`");
      expect(await tableExists(conn, "dailyCheckinCampaigns")).toBe(true);
      expect(await tableExists(conn, "dailyCheckinCouponTemplates")).toBe(true);
      expect(await tableExists(conn, "dailyCheckinRewardRules")).toBe(false);
      expect(await tableExists(conn, "dailyCheckinRewardGrants")).toBe(false);

      await expect(runMigrationStatements(conn)).resolves.not.toThrow();

      for (const t of NEW_TABLES) {
        expect(await tableExists(conn, t)).toBe(true);
      }
      expect(await indexExists(conn, "dailyCheckinRewardRules", "dailyCheckinRewardRules_campaign_dedupe_unique")).toBe(true);
      expect(await indexExists(conn, "dailyCheckinRewardGrants", "dailyCheckinRewardGrants_checkin_rule_unique")).toBe(true);
    } finally {
      await cleanupTestConnection(conn!);
    }
  }, 60000);

  it("4. fully present schema - migration is a guarded no-op", async () => {
    const conn = await connect();
    if (!conn) return;
    try {
      await runMigrationStatements(conn);
      for (const t of NEW_TABLES) {
        expect(await tableExists(conn, t)).toBe(true);
      }

      await expect(runMigrationStatements(conn)).resolves.not.toThrow();

      for (const t of NEW_TABLES) {
        expect(await tableExists(conn, t)).toBe(true);
      }
    } finally {
      await cleanupTestConnection(conn!);
    }
  }, 60000);

  it("5. raw migration SQL runs twice in a row - no duplicate table/index errors", async () => {
    const conn = await connect();
    if (!conn) return;
    try {
      await expect(runMigrationStatements(conn)).resolves.not.toThrow();
      await expect(runMigrationStatements(conn)).resolves.not.toThrow();

      for (const t of NEW_TABLES) {
        expect(await tableExists(conn, t)).toBe(true);
      }
    } finally {
      await cleanupTestConnection(conn!);
    }
  }, 60000);

  it("6. migration history rewound before 0029 while all four tables/indexes remain in place - rerunning the chain succeeds", async () => {
    const conn = await connect();
    if (!conn) return;
    try {
      await runFullChain(conn); // full history recorded, including 0029, for real
      for (const t of NEW_TABLES) {
        expect(await tableExists(conn, t)).toBe(true);
      }

      // Rewind ONLY the resume high-water mark back to just before 0029 -
      // the tables/indexes themselves are intentionally left in place,
      // reproducing the exact "history says earlier, schema says later"
      // state this migration's guarded design exists to survive (the same
      // duplicate-object failure mode migration 0026 was fixed for
      // earlier in this repo's history).
      await conn.query(`DELETE FROM \`__drizzle_migrations\` WHERE created_at >= ?`, [idx29When]);

      await expect(runFullChain(conn)).resolves.not.toThrow();

      for (const t of NEW_TABLES) {
        expect(await tableExists(conn, t)).toBe(true);
      }
      expect(await indexExists(conn, "dailyCheckinRewardGrants", "dailyCheckinRewardGrants_couponId_unique")).toBe(true);
    } finally {
      // This test uniquely rewinds __drizzle_migrations bookkeeping -
      // restore the FULL chain (not just the raw schema) so later test
      // files in this run see a correctly-recorded history, not just
      // correct tables.
      await cleanupTestConnectionFullChain(conn!);
    }
  }, 60000);

  it("7. final schema definitions agree with drizzle/schema.ts", async () => {
    const conn = await connect();
    if (!conn) return;
    try {
      await runMigrationStatements(conn);

      expect(await columnType(conn, "dailyCheckinCampaigns", "campaignKey")).toBe("varchar");
      expect(await columnType(conn, "dailyCheckinCampaigns", "status")).toBe("enum");
      expect(await indexColumns(conn, "dailyCheckinCampaigns", "dailyCheckinCampaigns_status_date_idx")).toEqual([
        "status",
        "startDate",
        "endDate",
      ]);
      expect(await indexIsUnique(conn, "dailyCheckinCampaigns", "dailyCheckinCampaigns_campaignKey_unique")).toBe(true);

      expect(await indexColumns(conn, "dailyCheckinCouponTemplates", "dailyCheckinCouponTemplates_campaignId_idx")).toEqual([
        "campaignId",
      ]);
      expect(await columnType(conn, "dailyCheckinCouponTemplates", "discountValue")).toBe("decimal");

      expect(await indexColumns(conn, "dailyCheckinRewardRules", "dailyCheckinRewardRules_campaign_dedupe_unique")).toEqual([
        "campaignId",
        "dedupeKey",
      ]);
      expect(await indexIsUnique(conn, "dailyCheckinRewardRules", "dailyCheckinRewardRules_campaign_dedupe_unique")).toBe(true);
      expect(await indexColumns(conn, "dailyCheckinRewardRules", "dailyCheckinRewardRules_campaign_active_idx")).toEqual([
        "campaignId",
        "isActive",
      ]);

      expect(await indexColumns(conn, "dailyCheckinRewardGrants", "dailyCheckinRewardGrants_checkin_rule_unique")).toEqual([
        "dailyCheckinId",
        "ruleId",
      ]);
      expect(await indexIsUnique(conn, "dailyCheckinRewardGrants", "dailyCheckinRewardGrants_checkin_rule_unique")).toBe(true);
      expect(
        await indexColumns(conn, "dailyCheckinRewardGrants", "dailyCheckinRewardGrants_user_rule_instance_unique")
      ).toEqual(["userId", "ruleId", "milestoneInstanceNumber"]);
      expect(
        await indexIsUnique(conn, "dailyCheckinRewardGrants", "dailyCheckinRewardGrants_user_rule_instance_unique")
      ).toBe(true);
      expect(await indexIsUnique(conn, "dailyCheckinRewardGrants", "dailyCheckinRewardGrants_couponId_unique")).toBe(true);
      expect(
        await indexIsUnique(conn, "dailyCheckinRewardGrants", "dailyCheckinRewardGrants_pointsTransactionId_unique")
      ).toBe(true);
      expect(await columnType(conn, "dailyCheckinRewardGrants", "status")).toBe("enum");

      const expectedGrantColumns = [
        "id",
        "dailyCheckinId",
        "userId",
        "campaignId",
        "ruleId",
        "rewardKind",
        "grantReason",
        "milestoneDay",
        "milestoneInstanceNumber",
        "streakCountAtGrant",
        "pointsAmount",
        "pointsTransactionId",
        "couponId",
        "discountType",
        "discountValue",
        "maxDiscountAmount",
        "minPurchaseAmount",
        "status",
        "usedAt",
        "voidedAt",
        "createdAt",
      ];
      for (const column of expectedGrantColumns) {
        expect(await columnExists(conn, "dailyCheckinRewardGrants", column)).toBe(true);
      }
    } finally {
      await cleanupTestConnection(conn!);
    }
  }, 60000);

  it("8. couponId and pointsTransactionId each permit multiple NULLs but reject duplicate non-NULL values", async () => {
    const conn = await connect();
    if (!conn) return;
    const insertedIds: number[] = [];
    try {
      await runMigrationStatements(conn);

      // Multiple rows with couponId NULL are permitted - point grants never set couponId.
      insertedIds.push(
        await insertGrant(conn, { dailyCheckinId: 900001, userId: 900001, campaignId: 900001, ruleId: 900001, rewardKind: "points", grantReason: "daily" })
      );
      insertedIds.push(
        await insertGrant(conn, { dailyCheckinId: 900002, userId: 900001, campaignId: 900001, ruleId: 900002, rewardKind: "points", grantReason: "daily" })
      );

      // Duplicate non-NULL couponId is rejected.
      insertedIds.push(
        await insertGrant(conn, {
          dailyCheckinId: 900003,
          userId: 900001,
          campaignId: 900001,
          ruleId: 900003,
          rewardKind: "coupon",
          grantReason: "daily",
          couponId: 900777,
        })
      );
      await expect(
        insertGrant(conn, {
          dailyCheckinId: 900004,
          userId: 900001,
          campaignId: 900001,
          ruleId: 900004,
          rewardKind: "coupon",
          grantReason: "daily",
          couponId: 900777,
        })
      ).rejects.toThrow();

      // Multiple rows with pointsTransactionId NULL are permitted - coupon grants never set pointsTransactionId.
      insertedIds.push(
        await insertGrant(conn, { dailyCheckinId: 900005, userId: 900001, campaignId: 900001, ruleId: 900005, rewardKind: "coupon", grantReason: "daily" })
      );
      insertedIds.push(
        await insertGrant(conn, { dailyCheckinId: 900006, userId: 900001, campaignId: 900001, ruleId: 900006, rewardKind: "coupon", grantReason: "daily" })
      );

      // Duplicate non-NULL pointsTransactionId is rejected.
      insertedIds.push(
        await insertGrant(conn, {
          dailyCheckinId: 900007,
          userId: 900001,
          campaignId: 900001,
          ruleId: 900007,
          rewardKind: "points",
          grantReason: "daily",
          pointsTransactionId: 900888,
        })
      );
      await expect(
        insertGrant(conn, {
          dailyCheckinId: 900008,
          userId: 900001,
          campaignId: 900001,
          ruleId: 900008,
          rewardKind: "points",
          grantReason: "daily",
          pointsTransactionId: 900888,
        })
      ).rejects.toThrow();
    } finally {
      await teardownWithGrantIds(conn!, insertedIds);
    }
  }, 60000);

  it("9. reward-grant idempotency constraints reject duplicates and permit distinct daily grants with milestoneInstanceNumber NULL", async () => {
    const conn = await connect();
    if (!conn) return;
    const insertedIds: number[] = [];
    try {
      await runMigrationStatements(conn);

      // Duplicate (dailyCheckinId, ruleId) is rejected - one check-in event
      // cannot grant the same rule twice.
      insertedIds.push(
        await insertGrant(conn, { dailyCheckinId: 910001, userId: 910001, campaignId: 910001, ruleId: 910001, rewardKind: "points", grantReason: "daily" })
      );
      await expect(
        insertGrant(conn, { dailyCheckinId: 910001, userId: 910001, campaignId: 910001, ruleId: 910001, rewardKind: "points", grantReason: "daily" })
      ).rejects.toThrow();

      // Duplicate non-NULL (userId, ruleId, milestoneInstanceNumber) is
      // rejected - a specific milestone instance is granted at most once
      // ever, regardless of which dailyCheckinId it happened on.
      insertedIds.push(
        await insertGrant(conn, {
          dailyCheckinId: 910010,
          userId: 910002,
          campaignId: 910001,
          ruleId: 910010,
          rewardKind: "points",
          grantReason: "milestone",
          milestoneInstanceNumber: 1,
        })
      );
      await expect(
        insertGrant(conn, {
          dailyCheckinId: 910011,
          userId: 910002,
          campaignId: 910001,
          ruleId: 910010,
          rewardKind: "points",
          grantReason: "milestone",
          milestoneInstanceNumber: 1,
        })
      ).rejects.toThrow();

      // Separate daily grants (milestoneInstanceNumber NULL) for the same
      // userId+ruleId remain permitted when dailyCheckinId differs - NULL
      // never collides with NULL in the (userId, ruleId,
      // milestoneInstanceNumber) unique index, which is exactly why daily
      // grants rely on the (dailyCheckinId, ruleId) constraint instead.
      insertedIds.push(
        await insertGrant(conn, { dailyCheckinId: 910020, userId: 910003, campaignId: 910001, ruleId: 910020, rewardKind: "points", grantReason: "daily" })
      );
      const secondDailyGrantId = await insertGrant(conn, {
        dailyCheckinId: 910021,
        userId: 910003,
        campaignId: 910001,
        ruleId: 910020,
        rewardKind: "points",
        grantReason: "daily",
      });
      insertedIds.push(secondDailyGrantId);
      expect(secondDailyGrantId).toBeGreaterThan(0);
    } finally {
      await teardownWithGrantIds(conn!, insertedIds);
    }
  }, 60000);
});
