import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import mysql from "mysql2/promise";
import { buildTestDbConnectionOptions } from "./test-helpers/testDbConnectionOptions";
import { runMigrationsWithLogging, consoleMigrationLogger, readMigrationJournal } from "./test-helpers/migrateTestDbWithLogging";
import { EXPECTED_TEST_DATABASE_NAME } from "./test-helpers/testDatabaseGuard";
import { restoreToFullyMigratedWithRetry } from "./test-helpers/restoreWithEmergencyRetry";
import { closeMysqlConnectionSafely } from "./test-helpers/closeMysqlConnectionSafely";

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
 *
 * Test isolation (added after Gate B/C proved non-deterministic under real
 * Manus runs - failures included duplicate columns, migration journal
 * timestamp mismatches, and cleanup/schema inconsistencies): the observed
 * pattern is exactly what an async-test-timeout race produces - Vitest's
 * `testTimeout` races a test's returned promise against a timer; if the
 * timer wins, Vitest reports the test as failed and moves on to the NEXT
 * test, but the original test's still-pending database work (its own body,
 * or its `finally` cleanup) is NOT cancelled - it keeps running in the
 * background and can mutate shared schema/journal state WHILE the next
 * scenario's own setup is already running, producing exactly the
 * "duplicate column"/"journal mismatch" symptoms Gate B and Gate C
 * reported. Three changes address this directly:
 *   1. `describe.sequential(...)` makes execution order explicit in code,
 *      not just inherited from this project's global `sequence.concurrent:
 *      false` default.
 *   2. Each scenario's own per-test timeout is raised from 60s to 180s (see
 *      the constant below) - a value based on measured real Manus runtime
 *      for the most expensive scenario (a full migration chain against a
 *      completely empty database) plus headroom, so a legitimately slow
 *      but successful run is never mistaken for a hang and abandoned
 *      mid-flight. This is scoped to this file's own `it(...)` calls only -
 *      vitest.integration.config.ts's project-wide `testTimeout` is
 *      untouched.
 *   3. A dedicated MySQL named lock (GET_LOCK), held for this file's entire
 *      duration via beforeAll/afterAll, so a second process (a retried or
 *      overlapping gate run) can never execute these destructive scenarios
 *      concurrently against the same shared database.
 * Additionally, every scenario now explicitly re-verifies the fully-migrated
 * baseline (verifyFullyMigratedBaseline()) immediately after establishing
 * it and again after cleanup - turning a previous scenario's incomplete
 * cleanup into an immediate, clearly-attributed failure in the scenario
 * that actually inherited the bad state, instead of a confusing failure
 * surfacing later in a different, seemingly-unrelated scenario.
 */

const migrationsFolder = path.resolve(__dirname, "..", "drizzle");

/**
 * Based on measured real Manus runtime for this file's most expensive
 * scenario (a full migration chain, 0000 through the newest migration,
 * against a completely empty database) plus reasonable headroom - NOT a
 * blind bump. Exists specifically to prevent Vitest from marking a test
 * failed (and moving on to the next one) while its database work or
 * cleanup is still legitimately running in the background; it does not
 * hide a real hang, since every connection close inside these scenarios is
 * itself bounded by closeMysqlConnectionSafely()'s own timeout. Scoped to
 * this file's `it(...)` calls only - the project-wide testTimeout in
 * vitest.integration.config.ts is unchanged.
 */
const MIGRATION_0024_TEST_TIMEOUT_MS = 180000;

const LOCK_NAME = "ipenovel_test_migration_0024_suite";
const LOCK_TIMEOUT_SECONDS = 60;

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

async function indexExists(conn: mysql.Connection, tableName: string, indexName: string): Promise<boolean> {
  const [rows]: any = await conn.query(
    `SELECT COUNT(*) as cnt FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
    [tableName, indexName]
  );
  return Number(rows[0].cnt) > 0;
}

/**
 * `episodes.isPublished` and `episodes.sortOrder` are each covered by a
 * secondary index (episodes_isPublished_idx/episodes_isPublished_
 * createdAt_idx and episodes_sortOrder_idx, from migrations 0024/0026) -
 * TiDB (like MySQL) refuses to DROP COLUMN a column a secondary index still
 * covers. The scenarios below that simulate a partial legacy schema by
 * dropping those columns via dropColumnIfExists() must drop these
 * dependent indexes first. The migration chain re-run afterward recreates
 * all three naturally, so this never edits drizzle/schema.ts or the
 * migrations themselves - purely test-fixture ordering.
 */
const EPISODES_DEPENDENT_INDEXES = ["episodes_isPublished_idx", "episodes_isPublished_createdAt_idx", "episodes_sortOrder_idx"] as const;

/**
 * Drops `indexName` on `tableName` only if it currently exists, and only if
 * it is one of the specific, explicitly allowlisted dependent-index names
 * this test file is permitted to touch (EPISODES_DEPENDENT_INDEXES) -
 * never PRIMARY, never anything else, regardless of what's passed in.
 */
async function dropIndexIfExists(conn: mysql.Connection, tableName: string, indexName: string): Promise<void> {
  if ((EPISODES_DEPENDENT_INDEXES as readonly string[]).indexOf(indexName) === -1) {
    throw new Error(`dropIndexIfExists: refusing to drop "${indexName}" - it is not in the explicit test index allowlist.`);
  }
  if (await indexExists(conn, tableName, indexName)) {
    await conn.query(`ALTER TABLE \`${tableName}\` DROP INDEX \`${indexName}\``);
  }
}

/** Removes only the __drizzle_migrations rows recorded strictly after `afterWhen` - rewinds the resume high-water-mark without touching earlier, unrelated history. */
async function rewindMigrationHistoryAfter(conn: mysql.Connection, afterWhen: number): Promise<void> {
  await conn.query(`DELETE FROM \`__drizzle_migrations\` WHERE created_at > ?`, [afterWhen]);
}

async function runFullChain(conn: mysql.Connection) {
  await runMigrationsWithLogging(conn, migrationsFolder, consoleMigrationLogger("[integration-test]"));
}

const journal = readMigrationJournal(migrationsFolder);
const idx23When = journal.find((e) => e.tag === "0023_add_episode_sale_mode")!.when;
const idx24When = journal.find((e) => e.tag === "0024_widen_episode_content_mediumtext")!.when;
const idx27When = journal.find((e) => e.tag === "0027_add_daily_checkin_and_coupon_cap")!.when;
const latestJournalWhen = journal[journal.length - 1].when;

/**
 * Explicitly verifies the database is at the fully-migrated baseline -
 * called immediately after runFullChain(conn) at the START of every
 * scenario (proving it truly began from a clean baseline, not one silently
 * inherited from a possibly-incomplete previous cleanup) and again as part
 * of cleanup itself (proving cleanup actually finished, not just that it
 * was attempted). Added directly in response to Gate B/C's observed
 * failure class: an inherited bad state previously only became visible as
 * a confusing failure in a LATER, unrelated-looking scenario ("duplicate
 * column isPublished", a journal timestamp mismatch); this turns that into
 * an immediate, correctly-attributed failure at the point the bad state
 * actually originated.
 */
async function verifyFullyMigratedBaseline(conn: mysql.Connection): Promise<void> {
  const [rows]: any = await conn.query(`SELECT MAX(created_at) as latest FROM \`__drizzle_migrations\``);
  const liveLatest = Number(rows[0]?.latest ?? -1);
  if (liveLatest !== latestJournalWhen) {
    throw new Error(
      `verifyFullyMigratedBaseline: expected the migration journal high-water mark to be ${latestJournalWhen}, found ${liveLatest} - the database is not at the expected fully-migrated baseline (a previous scenario's cleanup may not have completed).`
    );
  }
  for (const table of ["episodePurchases", "readingProgress"]) {
    if (!(await tableExists(conn, table))) {
      throw new Error(`verifyFullyMigratedBaseline: expected table "${table}" to exist at the fully-migrated baseline.`);
    }
  }
  if (!(await columnExists(conn, "episodes", "content"))) {
    throw new Error(`verifyFullyMigratedBaseline: expected column "episodes.content" to exist at the fully-migrated baseline.`);
  }
  for (const idx of EPISODES_DEPENDENT_INDEXES) {
    if (!(await indexExists(conn, "episodes", idx))) {
      throw new Error(`verifyFullyMigratedBaseline: expected index "${idx}" to exist at the fully-migrated baseline.`);
    }
  }
}

/** Runs the full chain and then explicitly verifies the result - the one function every scenario uses to establish (or restore) its starting/ending baseline. */
async function runFullChainAndVerify(conn: mysql.Connection): Promise<void> {
  await runFullChain(conn);
  await verifyFullyMigratedBaseline(conn);
}

/**
 * Fully restores episodes/episodePurchases/readingProgress to the complete,
 * correct end state - always run in a finally block regardless of what a
 * test intentionally broke.
 *
 * Cleanup failures here used to be silently swallowed (`.catch(() => {})`),
 * which could leave the shared test database dirty and turn one real
 * failure into a cascade of confusing, unrelated-looking failures in every
 * later test in this file. This delegates the actual retry/throw control
 * flow to restoreToFullyMigratedWithRetry() (see test-helpers/
 * restoreWithEmergencyRetry.ts and its dedicated unit tests) so a cleanup
 * failure is NEVER swallowed: it either resolves for real (primary or
 * verified emergency retry both succeeded AND independently re-verified via
 * verifyFullyMigratedBaseline()) or throws - preserving the primary failure
 * - so this test is correctly reported as failed instead of silently
 * leaving the shared database dirty for later tests.
 */
async function restoreToFullyMigrated(conn: mysql.Connection): Promise<void> {
  await restoreToFullyMigratedWithRetry(
    () => runFullChainAndVerify(conn),
    {
      connect,
      queryLiveDatabaseName: async (emergencyConn) => {
        const [rows]: any = await emergencyConn.query("SELECT DATABASE() AS name");
        return rows?.[0]?.name ?? null;
      },
      runCleanup: runFullChainAndVerify,
      closeConnection: (emergencyConn) => closeMysqlConnectionSafely(emergencyConn),
      expectedDatabaseName: EXPECTED_TEST_DATABASE_NAME,
    }
  );
}

/**
 * Every test's own finally block must close ITS connection (`conn`) even
 * when restoreToFullyMigrated() throws - restoreToFullyMigratedWithRetry()
 * now throws on real cleanup failure (see above), and a plain
 * `await restoreToFullyMigrated(conn); await conn.end();` sequence would
 * skip the second statement entirely if the first throws, leaking the
 * connection. This wraps both so the connection is always released -
 * through closeMysqlConnectionSafely(), never a bare `.end()` - regardless
 * of whether cleanup ultimately succeeded.
 */
async function cleanupTestConnection(conn: mysql.Connection): Promise<void> {
  try {
    await restoreToFullyMigrated(conn);
  } finally {
    await closeMysqlConnectionSafely(conn);
  }
}

describe.sequential("migration 0024/0025/0028 repair - real disposable test database", () => {
  // A dedicated named lock held for this file's ENTIRE run (acquired once
  // before any scenario, released once after all of them) - so a second
  // process (an overlapping or retried gate run) can never execute these
  // destructive scenarios concurrently against the same shared database.
  // This is distinct from (and does not replace) describe.sequential()
  // above, which only orders execution WITHIN this one process - the named
  // lock is the cross-process guarantee.
  let lockConnection: mysql.Connection | null = null;
  let lockHeld = false;

  beforeAll(async () => {
    lockConnection = await connect();
    if (!lockConnection) return; // no TEST_DATABASE_URL - every test below already no-ops in this case
    const [rows]: any = await lockConnection.query("SELECT GET_LOCK(?, ?) AS acquired", [LOCK_NAME, LOCK_TIMEOUT_SECONDS]);
    const acquired = rows?.[0]?.acquired;
    if (acquired !== 1) {
      throw new Error(
        `migration-0024 integration suite: could not acquire the dedicated named lock "${LOCK_NAME}" within ${LOCK_TIMEOUT_SECONDS}s (GET_LOCK returned ${acquired}) - another process appears to be running these destructive scenarios concurrently.`
      );
    }
    lockHeld = true;
  }, (LOCK_TIMEOUT_SECONDS + 30) * 1000);

  afterAll(async () => {
    if (!lockConnection) return;
    try {
      if (lockHeld) {
        const [rows]: any = await lockConnection.query("SELECT RELEASE_LOCK(?) AS released", [LOCK_NAME]);
        const released = rows?.[0]?.released;
        // Only ever reported as released when RELEASE_LOCK genuinely
        // returns 1 - anything else (0 = not held by this session, NULL =
        // lock did not exist) is a non-fatal warning, never silently
        // treated as a successful release.
        if (released !== 1) {
          console.warn(
            `[migration-0024 integration test] RELEASE_LOCK did not report success (non-fatal): returned ${released}`
          );
        }
      }
    } finally {
      await closeMysqlConnectionSafely(lockConnection);
    }
  }, 30000);

  it("1. a completely empty database (no relevant tables, no migration history) migrates 0000 through the newest migration successfully", async () => {
    const conn = await connect();
    if (!conn) return;
    try {
      // Drop every table in this database and every migration record -
      // this IS "completely empty" with respect to this migration chain's
      // own bookkeeping (__drizzle_migrations), which is what determines
      // whether migrations 0000-0022's non-idempotent CREATE TABLE
      // statements are even attempted. (Deliberately does NOT call
      // runFullChainAndVerify() first - the whole point of this scenario
      // is to start from nothing, not from a verified baseline.)
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
      await cleanupTestConnection(conn!);
    }
  }, MIGRATION_0024_TEST_TIMEOUT_MS);

  it("2. episodes exists without the legacy reader columns - migration 0024 creates them", async () => {
    const conn = await connect();
    if (!conn) return;
    try {
      await runFullChainAndVerify(conn); // verified fully-migrated baseline
      await rewindMigrationHistoryAfter(conn, idx23When); // pretend only 0000-0023 ever ran
      // isPublished/sortOrder are covered by secondary indexes (see
      // EPISODES_DEPENDENT_INDEXES) - TiDB refuses to drop those columns
      // while the indexes still cover them, so drop the indexes first.
      for (const idx of EPISODES_DEPENDENT_INDEXES) {
        await dropIndexIfExists(conn, "episodes", idx);
      }
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
      // The migration chain must recreate the dependent indexes naturally, not just the columns.
      for (const idx of EPISODES_DEPENDENT_INDEXES) {
        expect(await indexExists(conn, "episodes", idx)).toBe(true);
      }
    } finally {
      await cleanupTestConnection(conn!);
    }
  }, MIGRATION_0024_TEST_TIMEOUT_MS);

  it("3. journal history shows 0023 already applied, but the 0024 prerequisites are missing", async () => {
    const conn = await connect();
    if (!conn) return;
    try {
      await runFullChainAndVerify(conn);
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
      await cleanupTestConnection(conn!);
    }
  }, MIGRATION_0024_TEST_TIMEOUT_MS);

  it("4. only some legacy columns are present - migration adds exactly the missing ones without erroring on the rest", async () => {
    const conn = await connect();
    if (!conn) return;
    try {
      await runFullChainAndVerify(conn);
      await rewindMigrationHistoryAfter(conn, idx23When);
      // isPublished/sortOrder are covered by secondary indexes (see
      // EPISODES_DEPENDENT_INDEXES) - TiDB refuses to drop those columns
      // while the indexes still cover them, so drop the indexes first.
      for (const idx of EPISODES_DEPENDENT_INDEXES) {
        await dropIndexIfExists(conn, "episodes", idx);
      }
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
      // The migration chain must recreate the dependent indexes naturally, not just the columns.
      for (const idx of EPISODES_DEPENDENT_INDEXES) {
        expect(await indexExists(conn, "episodes", idx)).toBe(true);
      }
    } finally {
      await cleanupTestConnection(conn!);
    }
  }, MIGRATION_0024_TEST_TIMEOUT_MS);

  it("5. the full legacy schema is already present (e.g. via a manual drizzle-kit push) - migration is a guarded no-op", async () => {
    const conn = await connect();
    if (!conn) return;
    try {
      await runFullChainAndVerify(conn);
      await rewindMigrationHistoryAfter(conn, idx23When);
      // Everything already present (it never was dropped) - this is the
      // "already fully correct, migration must not error" case.
      expect(await columnExists(conn, "episodes", "content")).toBe(true);
      expect(await tableExists(conn, "episodePurchases")).toBe(true);
      expect(await tableExists(conn, "readingProgress")).toBe(true);

      await expect(runFullChain(conn)).resolves.not.toThrow();

      expect(await columnExists(conn, "episodes", "content")).toBe(true);
    } finally {
      await cleanupTestConnection(conn!);
    }
  }, MIGRATION_0024_TEST_TIMEOUT_MS);

  it("6. readingProgress is missing entirely despite the journal already being fully recorded - migration 0028 recreates it", async () => {
    const conn = await connect();
    if (!conn) return;
    try {
      await runFullChainAndVerify(conn); // full history recorded, including 0028
      await dropTableIfExists(conn, "readingProgress");
      expect(await tableExists(conn, "readingProgress")).toBe(false);

      // History is already past 0024/0025 - only a migration newer than
      // everything before it (0028) can possibly run now.
      const [rows]: any = await conn.query(`SELECT COUNT(*) as cnt FROM \`__drizzle_migrations\` WHERE created_at > ?`, [idx27When]);
      expect(Number(rows[0].cnt)).toBeGreaterThan(0); // 0028 already recorded from runFullChainAndVerify() above

      // Rewind ONLY 0028's own record so it can run again and prove the repair.
      await conn.query(`DELETE FROM \`__drizzle_migrations\` WHERE created_at > ?`, [idx27When]);

      await expect(runFullChain(conn)).resolves.not.toThrow();
      expect(await tableExists(conn, "readingProgress")).toBe(true);
      expect(await columnExists(conn, "readingProgress", "currentChapterNumber")).toBe(true);
    } finally {
      await cleanupTestConnection(conn!);
    }
  }, MIGRATION_0024_TEST_TIMEOUT_MS);

  it("7. readingProgress exists without the 0025 TOC columns - migration 0025 adds exactly those", async () => {
    const conn = await connect();
    if (!conn) return;
    try {
      await runFullChainAndVerify(conn);
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
      await cleanupTestConnection(conn!);
    }
  }, MIGRATION_0024_TEST_TIMEOUT_MS);

  it("8. migration rerun is idempotent - running the full chain twice in a row makes no further changes", async () => {
    const conn = await connect();
    if (!conn) return;
    try {
      await runFullChainAndVerify(conn);
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
      await cleanupTestConnection(conn!);
    }
  }, MIGRATION_0024_TEST_TIMEOUT_MS);

  it("9. the final schema agrees with drizzle/schema.ts for the objects this repair concerns", async () => {
    const conn = await connect();
    if (!conn) return;
    try {
      await runFullChainAndVerify(conn);

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
      await cleanupTestConnection(conn!);
    }
  }, MIGRATION_0024_TEST_TIMEOUT_MS);

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
    let when1 = -1;
    let when2 = -1;
    try {
      // Explicit, verified baseline before computing synthetic timestamps -
      // this scenario does not mutate the real schema, but it DOES read
      // and write __drizzle_migrations, so it must start from the same
      // guaranteed-correct state every other scenario does.
      await runFullChainAndVerify(conn);

      // The synthetic entries' `when` values must be strictly greater than
      // BOTH the highest timestamp in the repo's own journal AND whatever is
      // currently the live high-water mark in this shared database's
      // __drizzle_migrations table. Hardcoded small values like `when: 1`/
      // `when: 2` are invalid here: this table's real high-water mark is
      // already far larger (every real migration in drizzle/meta/_journal.json
      // has already run against this database via runFullChainAndVerify()
      // above), so drizzle's resume logic - "pending if
      // lastMigration.created_at < entry.when" - would see both synthetic
      // entries as already-in-the-past and skip them entirely, meaning the
      // intentionally invalid SQL in tag2 would never even be attempted and
      // this test would pass for the wrong reason.
      const repositoryJournalMax = Math.max(...journal.map((entry) => entry.when));
      const [liveMaxRows]: any = await conn.query(`SELECT MAX(created_at) as latest FROM \`__drizzle_migrations\``);
      const liveDatabaseMax = Number(liveMaxRows[0]?.latest ?? 0);
      const syntheticBaseWhen = Math.max(repositoryJournalMax, liveDatabaseMax) + 1000; // safe positive offset, clear of both watermarks
      when1 = syntheticBaseWhen;
      when2 = syntheticBaseWhen + 1;

      fs.mkdirSync(path.join(tmpFolder, "meta"));
      fs.writeFileSync(
        path.join(tmpFolder, "meta", "_journal.json"),
        JSON.stringify({
          version: "5",
          dialect: "mysql",
          entries: [
            { idx: 0, version: "5", when: when1, tag: tag1, breakpoints: true },
            { idx: 1, version: "5", when: when2, tag: tag2, breakpoints: true },
          ],
        })
      );
      fs.writeFileSync(path.join(tmpFolder, `${tag1}.sql`), "CREATE TABLE IF NOT EXISTS `ipenovel_synthetic_ok` (id int);");
      fs.writeFileSync(path.join(tmpFolder, `${tag2}.sql`), "THIS IS NOT VALID SQL AND MUST FAIL;");

      await expect(runMigrationsWithLogging(conn, tmpFolder, consoleMigrationLogger("[integration-test]"))).rejects.toThrow();

      // Verified directly (never via a global MAX(created_at) comparison,
      // which could be wrong if unrelated valid rows with even newer
      // timestamps legitimately exist elsewhere in the table): the
      // successful synthetic migration's exact row exists, and the failed
      // synthetic migration's exact row does not.
      const [successRows]: any = await conn.query(
        `SELECT COUNT(*) as cnt FROM \`__drizzle_migrations\` WHERE created_at = ?`,
        [when1]
      );
      expect(Number(successRows[0].cnt)).toBe(1);

      const [failedRows]: any = await conn.query(
        `SELECT COUNT(*) as cnt FROM \`__drizzle_migrations\` WHERE created_at = ?`,
        [when2]
      );
      expect(Number(failedRows[0].cnt)).toBe(0);

      const [tableRows]: any = await conn.query(
        `SELECT COUNT(*) as cnt FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'ipenovel_synthetic_ok'`
      );
      expect(Number(tableRows[0].cnt)).toBe(1); // the successful migration's DDL really ran
    } finally {
      // Cleanup deletes only these exact synthetic timestamps - never a
      // range - so it can never touch real migration history. Cleanup
      // failures are never swallowed: restoreToFullyMigrated() (via
      // cleanupTestConnection()) still throws on a genuine failure below,
      // it is only the synthetic-row/table teardown here that is
      // best-effort (there is nothing further to escalate to if deleting
      // two specific, already-isolated synthetic rows fails - the real
      // schema-restoration guarantee is restoreToFullyMigrated()'s, invoked
      // via cleanupTestConnection() below regardless).
      if (when1 !== -1) {
        await conn.query(`DELETE FROM \`__drizzle_migrations\` WHERE created_at IN (${when1}, ${when2})`).catch(() => {});
      }
      await conn.query("DROP TABLE IF EXISTS `ipenovel_synthetic_ok`").catch(() => {});
      fs.rmSync(tmpFolder, { recursive: true, force: true });
      await cleanupTestConnection(conn);
    }
  }, MIGRATION_0024_TEST_TIMEOUT_MS);
});
