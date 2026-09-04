import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { eq } from "drizzle-orm";
import { accountMutationGuards, pointsAccounts } from "../drizzle/schema";
import * as db from "./db";
import {
  findPaymentV2FoundationDataMismatches,
  reconcilePaymentV2FoundationData,
} from "../scripts/migrate.mjs";
import { buildTestDbConnectionOptions, parseTestDbTransportMode } from "./test-helpers/testDbConnectionOptions";
import { closeMysqlConnectionSafely } from "./test-helpers/closeMysqlConnectionSafely";
import { resetToMigrationCutoff } from "./test-helpers/resetToMigrationCutoff";
import { runMigrationsWithLogging, consoleMigrationLogger } from "./test-helpers/migrateTestDbWithLogging";
import { getTestDb } from "./test-helpers/testDb";

const migrationsFolder = path.resolve(__dirname, "..", "drizzle");
const BEFORE_0045 = "0044_add_sports_vote_catalog_points_rewards";
const MIGRATION_0045 = "0045_add_payment_v2_foundation";
const MIGRATION_0046 = "0046_add_points_accounts_mutex";
const TIMEOUT = 240000;

function requireTestUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("IPE-022 deploy-safety test requires TEST_DATABASE_URL=.../ipenovel_test");
  return url;
}

async function connect(): Promise<mysql.Connection> {
  return mysql.createConnection(
    buildTestDbConnectionOptions(requireTestUrl(), parseTestDbTransportMode(process.env.TEST_DATABASE_TRANSPORT))
  );
}

function migrationStatements(tag: string): string[] {
  return fs
    .readFileSync(path.join(migrationsFolder, `${tag}.sql`), "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function executePrefix(conn: mysql.Connection, tag: string, count: number): Promise<void> {
  for (const statement of migrationStatements(tag).slice(0, count)) {
    await conn.query(statement);
  }
}

describe.sequential("IPE-022 restart-safe and mixed-version foundation - real disposable database", () => {
  it(
    "retries partial 0045/0046 DDL and converges legacy-created users plus ledger-only writes",
    async () => {
      const conn = await connect();
      try {
        await resetToMigrationCutoff(conn, requireTestUrl(), migrationsFolder, BEFORE_0045);

        const stamp = Date.now();
        const [pre45User]: any = await conn.query(
          "INSERT INTO `users` (openId,name,email,loginMethod,role) VALUES (?,?,?,?,?)",
          [`ipe022-pre45-${stamp}`, "IPE-022 pre45", `ipe022-pre45-${stamp}@example.test`, "test", "user"]
        );

        // Simulate a crash after 0045's CREATE TABLE + FK DDL implicitly
        // committed, but before its backfill/journal row. Re-running the real
        // migration must not hit TABLE_EXISTS or duplicate-FK errors.
        await executePrefix(conn, MIGRATION_0045, 6);
        await runMigrationsWithLogging(
          conn,
          migrationsFolder,
          consoleMigrationLogger("[ipe022-partial-0045]"),
          { untilTag: MIGRATION_0045 }
        );

        const [guardRows]: any = await conn.query(
          "SELECT userId,mergeState FROM accountMutationGuards WHERE userId=?",
          [pre45User.insertId]
        );
        expect(guardRows).toEqual([
          expect.objectContaining({ userId: pre45User.insertId, mergeState: "open" }),
        ]);

        await conn.query(
          "INSERT INTO pointsTransactions (userId,type,amount,balanceAfter,referenceType,referenceId) VALUES (?,?,?,?,?,?)",
          [pre45User.insertId, "earn", "10.00", "10.00", "ipe022_legacy", 1]
        );

        // Simulate 0046 stopping after CREATE, initial backfill, and effectKey
        // column creation. A legacy instance then commits a newer ledger row
        // before the retry; the rerun must add remaining objects and converge
        // the mirror to that newest row.
        await executePrefix(conn, MIGRATION_0046, 7);
        await conn.query(
          "INSERT INTO pointsTransactions (userId,type,amount,balanceAfter,referenceType,referenceId) VALUES (?,?,?,?,?,?)",
          [pre45User.insertId, "earn", "7.00", "17.00", "ipe022_legacy", 2]
        );
        await runMigrationsWithLogging(
          conn,
          migrationsFolder,
          consoleMigrationLogger("[ipe022-partial-0046]")
        );

        const [afterRetry]: any = await conn.query(
          "SELECT balance FROM pointsAccounts WHERE userId=?",
          [pre45User.insertId]
        );
        expect(afterRetry[0].balance).toBe("17.00");

        const [legacyUser]: any = await conn.query(
          "INSERT INTO `users` (openId,name,email,loginMethod,role) VALUES (?,?,?,?,?)",
          [`ipe022-rolling-${stamp}`, "IPE-022 rolling", `ipe022-rolling-${stamp}@example.test`, "test", "user"]
        );
        await conn.query(
          "INSERT INTO pointsTransactions (userId,type,amount,balanceAfter,referenceType,referenceId) VALUES (?,?,?,?,?,?)",
          [legacyUser.insertId, "earn", "23.00", "23.00", "ipe022_legacy", 3]
        );

        expect(await findPaymentV2FoundationDataMismatches(conn)).toEqual(expect.arrayContaining([
          "accountMutationGuards missing rows=1",
          "pointsAccounts missing rows=1",
        ]));

        // Production locked path repairs both missing rows before arithmetic;
        // it also proves the plain compatibility read sees the ledger-only
        // commit instead of returning a stale/missing mirror.
        expect(await db.getUserPointsBalance(legacyUser.insertId)).toBe("23.00");
        await db.withUserPointsLock(legacyUser.insertId, undefined, async (tx) => {
          expect(await db.getUserPointsBalance(legacyUser.insertId, tx)).toBe("23.00");
        });

        const guard = (await getTestDb()
          .select()
          .from(accountMutationGuards)
          .where(eq(accountMutationGuards.userId, legacyUser.insertId)))[0];
        const points = (await getTestDb()
          .select()
          .from(pointsAccounts)
          .where(eq(pointsAccounts.userId, legacyUser.insertId)))[0];
        expect(guard.mergeState).toBe("open");
        expect(points.balance).toBe("23.00");

        // Another old-instance ledger-only commit after the first runtime
        // convergence is visible immediately and is persisted to the mirror
        // on the next locked mutation boundary.
        await conn.query(
          "INSERT INTO pointsTransactions (userId,type,amount,balanceAfter,referenceType,referenceId) VALUES (?,?,?,?,?,?)",
          [legacyUser.insertId, "earn", "6.00", "29.00", "ipe022_legacy", 4]
        );
        expect(await db.getUserPointsBalance(legacyUser.insertId)).toBe("29.00");
        await db.withUserPointsLock(legacyUser.insertId, undefined, async () => undefined);

        await reconcilePaymentV2FoundationData(conn);
        expect(await findPaymentV2FoundationDataMismatches(conn)).toEqual([]);
        const [finalPoints]: any = await conn.query(
          "SELECT balance FROM pointsAccounts WHERE userId=?",
          [legacyUser.insertId]
        );
        expect(finalPoints[0].balance).toBe("29.00");
      } finally {
        await resetToMigrationCutoff(conn, requireTestUrl(), migrationsFolder, MIGRATION_0046);
        await closeMysqlConnectionSafely(conn);
      }
    },
    TIMEOUT
  );
});
