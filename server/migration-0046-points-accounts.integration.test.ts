import { describe, expect, it } from "vitest";
import path from "node:path";
import mysql from "mysql2/promise";
import { buildTestDbConnectionOptions, parseTestDbTransportMode } from "./test-helpers/testDbConnectionOptions";
import { closeMysqlConnectionSafely } from "./test-helpers/closeMysqlConnectionSafely";
import { resetToMigrationCutoff } from "./test-helpers/resetToMigrationCutoff";
import { runMigrationsWithLogging, consoleMigrationLogger } from "./test-helpers/migrateTestDbWithLogging";

const migrationsFolder = path.resolve(__dirname, "..", "drizzle");
const PREVIOUS = "0045_add_payment_v2_foundation";
const CURRENT = "0046_add_points_accounts_mutex";
const TIMEOUT = 180000;

function requireTestUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("migration 0046 integration test requires TEST_DATABASE_URL=.../ipenovel_test");
  return url;
}

async function connect(): Promise<mysql.Connection> {
  return mysql.createConnection(
    buildTestDbConnectionOptions(requireTestUrl(), parseTestDbTransportMode(process.env.TEST_DATABASE_TRANSPORT))
  );
}

describe.sequential("migration 0046 pointsAccounts backfill - real disposable database", () => {
  it(
    "upgrades a genuine 0045 baseline, backfills deterministic latest balances, and installs per-user effect uniqueness",
    async () => {
      const conn = await connect();
      try {
        await resetToMigrationCutoff(conn, requireTestUrl(), migrationsFolder, PREVIOUS);

        const stamp = Date.now();
        const [withHistory]: any = await conn.query(
          "INSERT INTO `users` (openId, name, email, loginMethod, role) VALUES (?,?,?,?,?)",
          [`m46-history-${stamp}`, "History User", `m46-history-${stamp}@example.test`, "test", "user"]
        );
        const [emptyHistory]: any = await conn.query(
          "INSERT INTO `users` (openId, name, email, loginMethod, role) VALUES (?,?,?,?,?)",
          [`m46-empty-${stamp}`, "Empty User", `m46-empty-${stamp}@example.test`, "test", "user"]
        );

        // Same second on purpose. 0046 must reproduce the old deterministic
        // application rule: createdAt DESC, then autoincrement id DESC.
        const createdAt = "2026-09-03 10:00:00";
        await conn.query(
          "INSERT INTO `pointsTransactions` (userId,type,amount,balanceAfter,referenceType,referenceId,note,createdAt) VALUES (?,?,?,?,?,?,?,?)",
          [withHistory.insertId, "earn", "10.00", "10.00", "m46_seed", 1, "older same-second row", createdAt]
        );
        await conn.query(
          "INSERT INTO `pointsTransactions` (userId,type,amount,balanceAfter,referenceType,referenceId,note,createdAt) VALUES (?,?,?,?,?,?,?,?)",
          [withHistory.insertId, "earn", "10.00", "20.00", "m46_seed", 2, "newer same-second row", createdAt]
        );

        await runMigrationsWithLogging(conn, migrationsFolder, consoleMigrationLogger("[migration-0046-test]"));

        const [accounts]: any = await conn.query(
          "SELECT userId,balance,version FROM `pointsAccounts` WHERE userId IN (?,?) ORDER BY userId",
          [withHistory.insertId, emptyHistory.insertId]
        );
        expect(accounts).toHaveLength(2);
        const historyAccount = accounts.find((row: any) => Number(row.userId) === Number(withHistory.insertId));
        const emptyAccount = accounts.find((row: any) => Number(row.userId) === Number(emptyHistory.insertId));
        expect(historyAccount.balance).toBe("20.00");
        expect(Number(historyAccount.version)).toBe(0);
        expect(emptyAccount.balance).toBe("0.00");

        const [columns]: any = await conn.query(
          "SELECT COUNT(*) AS cnt FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='pointsTransactions' AND column_name='effectKey'"
        );
        expect(Number(columns[0].cnt)).toBe(1);

        await conn.query(
          "INSERT INTO `pointsTransactions` (userId,type,amount,balanceAfter,referenceType,referenceId,effectKey) VALUES (?,?,?,?,?,?,?)",
          [withHistory.insertId, "earn", "1.00", "21.00", "m46_effect", 1, "same-effect"]
        );
        await expect(
          conn.query(
            "INSERT INTO `pointsTransactions` (userId,type,amount,balanceAfter,referenceType,referenceId,effectKey) VALUES (?,?,?,?,?,?,?)",
            [withHistory.insertId, "earn", "1.00", "22.00", "m46_effect", 2, "same-effect"]
          )
        ).rejects.toMatchObject({ code: "ER_DUP_ENTRY" });

        // NULL effect keys remain intentionally repeatable for legacy/free-form
        // ledger history, so adding the unique index does not invalidate old data.
        await conn.query(
          "INSERT INTO `pointsTransactions` (userId,type,amount,balanceAfter,effectKey) VALUES (?,?,?,?,NULL),(?,?,?,?,NULL)",
          [emptyHistory.insertId, "adjust", "0.00", "0.00", emptyHistory.insertId, "adjust", "0.00", "0.00"]
        );
      } finally {
        // Leave the shared disposable DB at the current fully-migrated, empty
        // baseline even if an assertion above fails.
        await resetToMigrationCutoff(conn, requireTestUrl(), migrationsFolder, CURRENT);
        await closeMysqlConnectionSafely(conn);
      }
    },
    TIMEOUT
  );
});
