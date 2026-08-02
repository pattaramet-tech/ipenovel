import { describe, it, expect } from "vitest";
import path from "node:path";
import mysql from "mysql2/promise";
import { buildTestDbConnectionOptions, parseTestDbTransportMode } from "./test-helpers/testDbConnectionOptions";
import {
  runMigrationsWithLogging,
  consoleMigrationLogger,
  readMigrationJournal,
  type MigrationLogger,
} from "./test-helpers/migrateTestDbWithLogging";
import { restoreToFullyMigratedWithRetry } from "./test-helpers/restoreWithEmergencyRetry";
import { EXPECTED_TEST_DATABASE_NAME } from "./test-helpers/testDatabaseGuard";
import { closeMysqlConnectionSafely } from "./test-helpers/closeMysqlConnectionSafely";
import { resetToMigrationCutoff } from "./test-helpers/resetToMigrationCutoff";
import { resetToEmptySchema } from "./test-helpers/resetToEmptySchema";
import { verifyMigrationJournalAtLatest } from "./test-helpers/verifyMigrationJournalAtLatest";

/**
 * Real-database coverage for the legacy pending migration chain repair
 * (migrations 0017-0020, 0022, 0023 made idempotent). Reproduces the
 * confirmed production drift state - recorded migration high-water mark
 * before 0017, with a specific mix of complete/partial/missing objects
 * through 0030 - from an exact, verified 0000-0030 baseline (via
 * resetToMigrationCutoff(), never a full baseline through whatever the
 * newest migration happens to be today), then runs the real chain
 * (drizzle-compatible resume-by-timestamp semantics via
 * runMigrationsWithLogging, capped at 0030 via its `untilTag` option) and
 * proves it converges end-to-end without any duplicate-object error, all
 * the way through migration 0030 - the documented, confirmed scope of this
 * incident. The test then separately advances the rest of the way to
 * today's newest migration via an ordinary, uncapped chain run (ordinary
 * forward application, not a repair of anything) before its final no-op
 * check and cleanup.
 *
 * Uses `describe.sequential()` and a single dedicated mysql2 connection
 * (never a pool), built via buildTestDbConnectionOptions - which itself
 * enforces the exact "ipenovel_test" database name, TLS with
 * rejectUnauthorized: true, and TLS 1.2 minimum before returning connection
 * options at all. Every connection is closed via
 * closeMysqlConnectionSafely(), never a bare `.end()`. Full cleanup restores
 * the complete migration chain (schema AND __drizzle_migrations
 * bookkeeping) in a `finally` block.
 */

const migrationsFolder = path.resolve(__dirname, "..", "drizzle");

const MIGRATION_0030_TAG = "0030_repair_missing_daily_checkins";

const migration0030Entry = readMigrationJournal(migrationsFolder).find((entry) => entry.tag === MIGRATION_0030_TAG);

if (!migration0030Entry) {
  throw new Error(
    'Required migration journal entry "0030_repair_missing_daily_checkins" was not found'
  );
}

/**
 * The exact 0030 journal entry's own timestamp - the confirmed production
 * drift repair this test reproduces is documented and bounded through
 * migration 0030 specifically (see docs/DAILY_CHECKIN_DEPLOYMENT_FIX.md's
 * follow-up section), so the repair run itself is capped there via
 * runMigrationsWithLogging's `untilTag` option rather than being left
 * open-ended. This is what keeps this test safe as later migrations are
 * added: migrations 0033/0034 use plain, unguarded CREATE TABLE statements
 * (drizzle-kit generated, unlike the hand-written information_schema-guarded
 * migrations this scenario actually exercises), so if the repair run were
 * ever allowed to reach them while their physical objects already exist
 * (planted by the earlier resetToMigrationCutoff() baseline - see below),
 * it would hit ER_TABLE_EXISTS_ERROR exactly like the bug this whole file
 * was rewritten to avoid.
 */
const MIGRATION_0030_WHEN = migration0030Entry.when;

/** The last journal entry's timestamp (whatever migration is currently newest) - what the database reaches once cleanup/advancement runs the real, uncapped chain the rest of the way. */
const MIGRATION_LATEST_WHEN = readMigrationJournal(migrationsFolder).slice(-1)[0].when;

/** The confirmed production migration high-water mark - strictly before migration 0017's own journal timestamp. */
const PRODUCTION_HIGH_WATER_MARK = 1778343285119;

const MIGRATION_0026_INDEXES: Array<{ table: string; index: string }> = [
  { table: "episodes", index: "episodes_isPublished_createdAt_idx" },
  { table: "novels", index: "novels_publicationStatus_createdAt_idx" },
  { table: "purchases", index: "purchases_novelId_idx" },
];

const MIGRATION_0029_TABLES = [
  "dailyCheckinCampaigns",
  "dailyCheckinCouponTemplates",
  "dailyCheckinRewardRules",
  "dailyCheckinRewardGrants",
] as const;

async function connect(): Promise<mysql.Connection | null> {
  if (!process.env.TEST_DATABASE_URL) return null;
  return mysql.createConnection(
    buildTestDbConnectionOptions(process.env.TEST_DATABASE_URL, parseTestDbTransportMode(process.env.TEST_DATABASE_TRANSPORT))
  );
}

function createTrackingLogger(prefix: string): { logger: MigrationLogger; completedTags: string[] } {
  const completedTags: string[] = [];
  const base = consoleMigrationLogger(prefix);
  const logger: MigrationLogger = {
    onAttempt: (tag) => base.onAttempt(tag),
    onComplete: (tag) => {
      completedTags.push(tag);
      base.onComplete(tag);
    },
    onFailure: (tag, reason) => base.onFailure(tag, reason),
  };
  return { logger, completedTags };
}

async function runFullChain(conn: mysql.Connection): Promise<void> {
  await runMigrationsWithLogging(conn, migrationsFolder, consoleMigrationLogger("[legacy-chain-test]"));
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

async function dropIndexIfExists(conn: mysql.Connection, tableName: string, indexName: string): Promise<void> {
  if (await indexExists(conn, tableName, indexName)) {
    await conn.query(`ALTER TABLE \`${tableName}\` DROP INDEX \`${indexName}\``);
  }
}

async function latestRecordedMigrationTimestamp(conn: mysql.Connection): Promise<number | null> {
  const [rows]: any = await conn.query(`SELECT created_at as createdAt FROM \`__drizzle_migrations\` ORDER BY created_at DESC LIMIT 1`);
  return rows[0] ? Number(rows[0].createdAt) : null;
}

async function queryLiveDatabaseName(conn: mysql.Connection): Promise<string | null> {
  const [rows]: any = await conn.query("SELECT DATABASE() AS name");
  return rows?.[0]?.name ?? null;
}

/** Rewinds `__drizzle_migrations` to exactly the confirmed production high-water mark and selectively reverts schema objects to match the confirmed production drift state - starting from an already fully-migrated baseline. */
async function createProductionEquivalentDriftState(conn: mysql.Connection): Promise<void> {
  const journal = readMigrationJournal(migrationsFolder);
  const idx0017When = journal.find((e) => e.tag === "0017_nosy_newton_destine")!.when;
  expect(PRODUCTION_HIGH_WATER_MARK).toBeLessThan(idx0017When);

  // 1 + 2: rewind recorded history to before 0017, then plant the exact
  // confirmed production high-water-mark row.
  await conn.query(`DELETE FROM \`__drizzle_migrations\` WHERE created_at >= ?`, [idx0017When]);
  await conn.query(`INSERT INTO \`__drizzle_migrations\` (hash, created_at) VALUES (?, ?)`, [
    "legacy-pending-chain-test-marker",
    PRODUCTION_HIGH_WATER_MARK,
  ]);

  // 3: payments.ocrConfidence/ocrDecision are left exactly as the prior
  // full-chain baseline produced them (final shape from 0017 + 0021) - no
  // action needed.

  // 4: remove both payment OCR indexes.
  await dropIndexIfExists(conn, "payments", "payments_ocrConfidence_idx");
  await dropIndexIfExists(conn, "payments", "payments_ocrDecision_idx");

  // 5: migrations 0018-0025's objects are left completely intact - no action.

  // 6: remove all three migration 0026 indexes.
  for (const { table, index } of MIGRATION_0026_INDEXES) {
    await dropIndexIfExists(conn, table, index);
  }

  // 7: drop dailyCheckins.
  await conn.query("DROP TABLE IF EXISTS `dailyCheckins`");

  // 8: coupons.maxDiscountAmount is left intact - no action.

  // 9: drop all four migration 0029 tables.
  for (const t of [...MIGRATION_0029_TABLES].reverse()) {
    await conn.query(`DROP TABLE IF EXISTS \`${t}\``);
  }

  // 10: confirmed by construction (step 1 + 2) - nothing at or after 0017
  // (and therefore nothing for 0030) is recorded.
}

/**
 * Real emergency path: if the primary `runFullChain(conn)` attempt fails,
 * simply re-running `runFullChain` again on a fresh connection is not safe
 * by itself - this test deliberately puts the database into a journal/
 * schema-desynced state, so the emergency path always wipes to a genuinely
 * empty schema first, then runs the full chain from scratch, then verifies
 * the journal high-water mark actually lands on the newest migration.
 */
async function emergencyResetAndRestoreFullChain(conn: mysql.Connection): Promise<void> {
  await resetToEmptySchema(conn, process.env.TEST_DATABASE_URL);
  await runFullChain(conn);
  await verifyMigrationJournalAtLatest(conn, migrationsFolder);
}

/** Restores the full migration chain, including __drizzle_migrations bookkeeping. */
async function restoreFullChain(conn: mysql.Connection): Promise<void> {
  await restoreToFullyMigratedWithRetry(() => runFullChain(conn), {
    connect,
    queryLiveDatabaseName,
    runCleanup: emergencyResetAndRestoreFullChain,
    closeConnection: (emergencyConn) => closeMysqlConnectionSafely(emergencyConn),
    expectedDatabaseName: EXPECTED_TEST_DATABASE_NAME,
  });
}

describe.sequential("legacy pending migration chain repair (real disposable test database)", () => {
  it(
    "reproduces the confirmed production drift state from a fully migrated baseline, then the real migration chain repairs it end-to-end through migration 0030, preserving every existing row",
    async () => {
      const conn = await connect();
      if (!conn) return;

      const markerOrderId = 987650001;
      const markerNovelId = 987650002;
      const markerUserId = 987650003;
      const markerCouponCode = "IPENOVEL_LEGACY_CHAIN_TEST_COUPON";
      let paymentId: number | undefined;
      let episodeId: number | undefined;
      let walletTopupId: number | undefined;
      let couponId: number | undefined;

      try {
        // Exact, verified 0000-0030 baseline via resetToMigrationCutoff() -
        // establishes every table/column/index this scenario needs to
        // selectively revert, and gives us a known-good state to insert
        // pre-existing application rows into, while proving nothing from a
        // later migration (e.g. 0033's `authIdentities`) physically exists
        // yet. Was previously a FULL baseline (through whatever the newest
        // migration currently is) via runFullChain(conn) - safe only as
        // long as every migration past 0030 happened to be guarded; once
        // 0033/0034 (plain, unguarded CREATE TABLE) existed, rewinding the
        // journal below 0017 while their tables remained physically present
        // made the repair run hit ER_TABLE_EXISTS_ERROR the moment it
        // reached them. See MIGRATION_0030_WHEN's own comment for how the
        // repair run below stays capped at 0030 to match.
        await resetToMigrationCutoff(conn, process.env.TEST_DATABASE_URL, migrationsFolder, MIGRATION_0030_TAG);

        // payments.ocrConfidence is INT NOT NULL with no default in the
        // final migrated schema (migration 0021 tightens it), so the
        // marker row must supply it explicitly - 0 is the neutral,
        // schema-valid value. ocrDecision is intentionally left unset so
        // its schema default ('needs_review') applies.
        const [paymentResult]: any = await conn.query(
          `INSERT INTO \`payments\` (orderId, ocrConfidence) VALUES (?, ?)`,
          [markerOrderId, 0]
        );
        paymentId = paymentResult.insertId;
        const [episodeResult]: any = await conn.query(
          `INSERT INTO \`episodes\` (novelId, episodeNumber, title) VALUES (?, ?, ?)`,
          [markerNovelId, "LEGACY-CHAIN-TEST-EP", "Legacy Chain Test Episode"]
        );
        episodeId = episodeResult.insertId;
        const [walletTopupResult]: any = await conn.query(
          `INSERT INTO \`walletTopups\` (userId, requestedAmount) VALUES (?, ?)`,
          [markerUserId, "123.45"]
        );
        walletTopupId = walletTopupResult.insertId;
        const [couponResult]: any = await conn.query(
          `INSERT INTO \`coupons\` (code, discountType, discountValue, maxDiscountAmount, minPurchaseAmount, usageCount, isActive)
           VALUES (?, 'percentage', '5.00', '10.00', '50.00', 0, true)`,
          [markerCouponCode]
        );
        couponId = couponResult.insertId;

        await createProductionEquivalentDriftState(conn);

        // Precondition sanity check: the drift state actually matches the
        // confirmed production diagnosis before we claim to repair it.
        expect(await tableExists(conn, "dailyCheckins")).toBe(false);
        expect(await columnExists(conn, "coupons", "maxDiscountAmount")).toBe(true);
        expect(await indexExists(conn, "payments", "payments_ocrConfidence_idx")).toBe(false);
        expect(await indexExists(conn, "payments", "payments_ocrDecision_idx")).toBe(false);
        for (const { table, index } of MIGRATION_0026_INDEXES) {
          expect(await indexExists(conn, table, index)).toBe(false);
        }
        for (const t of MIGRATION_0029_TABLES) {
          expect(await tableExists(conn, t)).toBe(false);
        }
        expect(await latestRecordedMigrationTimestamp(conn)).toBe(PRODUCTION_HIGH_WATER_MARK);

        // The actual repair: run the real, drizzle-compatible migration
        // chain against this reproduced production drift state, capped at
        // migration 0030 - the documented, confirmed scope of this incident
        // (see MIGRATION_0030_WHEN's own comment for why capping here
        // matters, not just historical accuracy).
        const firstRun = createTrackingLogger("[legacy-chain-test:repair]");
        await expect(
          runMigrationsWithLogging(conn, migrationsFolder, firstRun.logger, { untilTag: MIGRATION_0030_TAG })
        ).resolves.not.toThrow();

        // Every historically pending migration (0017 through 0030) was
        // individually attempted and completed - none were silently skipped
        // due to an earlier failure, and none threw a duplicate-column/
        // duplicate-index/duplicate-constraint error.
        const expectedTags = readMigrationJournal(migrationsFolder)
          .map((entry) => entry.tag)
          .filter((tag) => tag >= "0017" && tag <= MIGRATION_0030_TAG);
        expect(firstRun.completedTags).toEqual(expectedTags);

        // Migration 0017: payments OCR columns/indexes fully repaired.
        expect(await columnExists(conn, "payments", "ocrConfidence")).toBe(true);
        expect(await columnExists(conn, "payments", "ocrDecision")).toBe(true);
        expect(await indexExists(conn, "payments", "payments_ocrConfidence_idx")).toBe(true);
        expect(await indexExists(conn, "payments", "payments_ocrDecision_idx")).toBe(true);

        // Migrations 0018-0020: no duplicate-object errors - their
        // (untouched, still-present) objects remain intact.
        expect(await tableExists(conn, "sportsMatchVotes")).toBe(true);
        expect(await tableExists(conn, "sportsMatches")).toBe(true);
        expect(await tableExists(conn, "sportsMatchRewards")).toBe(true);
        expect(await indexExists(conn, "couponUsages", "couponUsages_couponId_orderId_unique")).toBe(true);

        // Migration 0022: all 13 walletTopups OCR/review columns present.
        for (const column of [
          "slipSubmittedAt",
          "approvedAt",
          "approvedByAdminId",
          "rejectedAt",
          "extractedData",
          "ocrConfidence",
          "visionConfidence",
          "structuredConfidence",
          "finalConfidence",
          "duplicateStatus",
          "ocrDecision",
          "reviewReason",
          "approvalSource",
        ]) {
          expect(await columnExists(conn, "walletTopups", column)).toBe(true);
        }

        // Migration 0023: episodes.saleMode present.
        expect(await columnExists(conn, "episodes", "saleMode")).toBe(true);

        // Migration 0026: all three previously-missing indexes recreated.
        for (const { table, index } of MIGRATION_0026_INDEXES) {
          expect(await indexExists(conn, table, index)).toBe(true);
        }

        // Migration 0027: dailyCheckins recreated; coupons.maxDiscountAmount
        // remained present throughout (it was never dropped).
        expect(await tableExists(conn, "dailyCheckins")).toBe(true);
        expect(await indexExists(conn, "dailyCheckins", "dailyCheckins_userId_idx")).toBe(true);
        expect(await columnExists(conn, "coupons", "maxDiscountAmount")).toBe(true);

        // Migration 0029: all four tables and their key indexes recreated.
        for (const t of MIGRATION_0029_TABLES) {
          expect(await tableExists(conn, t)).toBe(true);
        }
        expect(await indexExists(conn, "dailyCheckinCampaigns", "dailyCheckinCampaigns_campaignKey_unique")).toBe(true);
        expect(await indexExists(conn, "dailyCheckinRewardGrants", "dailyCheckinRewardGrants_checkin_rule_unique")).toBe(true);

        // The capped repair run's own high-water mark reaches exactly 0030 -
        // nothing past it was attempted (or needed to be, for this
        // documented incident's scope).
        expect(await latestRecordedMigrationTimestamp(conn)).toBe(MIGRATION_0030_WHEN);

        // A second, still-capped run against the same cutoff is then a
        // clean no-op: nothing is pending anymore, so nothing is
        // (re-)attempted.
        const secondRun = createTrackingLogger("[legacy-chain-test:second-pass]");
        await expect(
          runMigrationsWithLogging(conn, migrationsFolder, secondRun.logger, { untilTag: MIGRATION_0030_TAG })
        ).resolves.not.toThrow();
        expect(secondRun.completedTags).toEqual([]);
        expect(await latestRecordedMigrationTimestamp(conn)).toBe(MIGRATION_0030_WHEN);

        // Ordinary forward advancement the rest of the way to today's
        // newest migration - unlike everything above, this is a normal
        // "apply migrations that have genuinely never run yet" chain run,
        // not a repair of any rewind-induced desync, so it is always safe
        // regardless of which later migrations are guarded or not.
        await expect(runFullChain(conn)).resolves.not.toThrow();
        expect(await latestRecordedMigrationTimestamp(conn)).toBe(MIGRATION_LATEST_WHEN);

        // No existing application row was deleted or rewritten by any of
        // the six repaired migrations' guarded ADD COLUMN/CREATE
        // TABLE/CREATE INDEX statements.
        const [paymentRows]: any = await conn.query(`SELECT id, orderId, ocrConfidence FROM \`payments\` WHERE id = ?`, [paymentId]);
        expect(paymentRows).toHaveLength(1);
        expect(paymentRows[0].orderId).toBe(markerOrderId);
        expect(paymentRows[0].ocrConfidence).toBe(0);

        const [episodeRows]: any = await conn.query(`SELECT id, novelId, title FROM \`episodes\` WHERE id = ?`, [episodeId]);
        expect(episodeRows).toHaveLength(1);
        expect(episodeRows[0].novelId).toBe(markerNovelId);
        expect(episodeRows[0].title).toBe("Legacy Chain Test Episode");

        const [walletTopupRows]: any = await conn.query(
          `SELECT id, userId, requestedAmount FROM \`walletTopups\` WHERE id = ?`,
          [walletTopupId]
        );
        expect(walletTopupRows).toHaveLength(1);
        expect(walletTopupRows[0].userId).toBe(markerUserId);
        expect(walletTopupRows[0].requestedAmount).toBe("123.45");

        const [couponRows]: any = await conn.query(`SELECT id, code, maxDiscountAmount FROM \`coupons\` WHERE id = ?`, [couponId]);
        expect(couponRows).toHaveLength(1);
        expect(couponRows[0].code).toBe(markerCouponCode);
        expect(couponRows[0].maxDiscountAmount).toBe("10.00");
      } finally {
        await conn
          .query(`DELETE FROM \`payments\` WHERE id = ?`, [paymentId ?? -1])
          .catch(() => {});
        await conn
          .query(`DELETE FROM \`episodes\` WHERE id = ?`, [episodeId ?? -1])
          .catch(() => {});
        await conn
          .query(`DELETE FROM \`walletTopups\` WHERE id = ?`, [walletTopupId ?? -1])
          .catch(() => {});
        await conn
          .query(`DELETE FROM \`coupons\` WHERE id = ?`, [couponId ?? -1])
          .catch(() => {});
        // This test uniquely rewinds __drizzle_migrations bookkeeping -
        // restore the FULL chain (not just raw schema) so later test files
        // in this run see a correctly-recorded history, not just correct
        // tables.
        try {
          await restoreFullChain(conn);
        } finally {
          await closeMysqlConnectionSafely(conn);
        }
      }
    },
    120000
  );
});
