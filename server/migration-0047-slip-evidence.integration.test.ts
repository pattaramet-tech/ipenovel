import { describe, expect, it } from "vitest";
import path from "node:path";
import mysql from "mysql2/promise";
import { buildTestDbConnectionOptions, parseTestDbTransportMode } from "./test-helpers/testDbConnectionOptions";
import { closeMysqlConnectionSafely } from "./test-helpers/closeMysqlConnectionSafely";
import { resetToMigrationCutoff } from "./test-helpers/resetToMigrationCutoff";
import { runMigrationsWithLogging, consoleMigrationLogger } from "./test-helpers/migrateTestDbWithLogging";

const migrationsFolder = path.resolve(__dirname, "..", "drizzle");
const PREVIOUS = "0046_add_points_accounts_mutex";
const CURRENT = "0047_add_slip_evidence_foundation";
const TIMEOUT = 180000;

function requireTestUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("migration 0047 integration test requires TEST_DATABASE_URL=.../ipenovel_test");
  return url;
}

async function connect(): Promise<mysql.Connection> {
  return mysql.createConnection(
    buildTestDbConnectionOptions(requireTestUrl(), parseTestDbTransportMode(process.env.TEST_DATABASE_TRANSPORT))
  );
}

describe.sequential("migration 0047 slip evidence foundation - real disposable database", () => {
  it(
    "upgrades a genuine 0046 baseline conservatively: epochs are backfilled but legacy bytes/extraction are never promoted to immutable/version-bound evidence",
    async () => {
      const conn = await connect();
      try {
        await resetToMigrationCutoff(conn, requireTestUrl(), migrationsFolder, PREVIOUS);
        const stamp = Date.now();
        const [user]: any = await conn.query(
          "INSERT INTO `users` (openId,name,email,loginMethod,role) VALUES (?,?,?,?,?)",
          [`m47-${stamp}`, "M47 User", `m47-${stamp}@example.test`, "test", "user"]
        );
        const userId = Number(user.insertId);
        const [order]: any = await conn.query(
          "INSERT INTO `orders` (orderNumber,userId,subtotal,discountAmount,pointsDiscountAmount,totalAmount,status,paymentStatus) VALUES (?,?,?,?,?,?,?,?)",
          [`M47-${stamp}`, userId, "10.00", "0.00", "0.00", "10.00", "pending", "submitted"]
        );
        const legacyExtracted = JSON.stringify({ fileHash: "a".repeat(64), referenceRaw: "legacy-ref" });
        const [paymentWithSlip]: any = await conn.query(
          "INSERT INTO `payments` (orderId,slipImageUrl,slipSubmittedAt,status,extractedData,ocrConfidence,ocrDecision) VALUES (?,?,?,?,?,?,?)",
          [order.insertId, "https://d2xsxph8kpxj0f.cloudfront.net/legacy/m47.jpg", "2026-09-03 12:00:00", "pending_review", legacyExtracted, 50, "needs_review"]
        );
        const [order2]: any = await conn.query(
          "INSERT INTO `orders` (orderNumber,userId,subtotal,discountAmount,pointsDiscountAmount,totalAmount,status,paymentStatus) VALUES (?,?,?,?,?,?,?,?)",
          [`M47-NO-${stamp}`, userId, "10.00", "0.00", "0.00", "10.00", "pending", "unpaid"]
        );
        const [paymentNoSlip]: any = await conn.query(
          "INSERT INTO `payments` (orderId,status,ocrConfidence,ocrDecision) VALUES (?,?,?,?)",
          [order2.insertId, "pending", 0, "needs_review"]
        );
        const [walletWithSlip]: any = await conn.query(
          "INSERT INTO `walletTopups` (userId,requestedAmount,bonusAmount,creditedAmount,slipImageUrl,slipSubmittedAt,status,extractedData,approvalSource,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
          [userId, "100.00", "0.00", "100.00", "r2p:payment-slips/legacy/unregistered.jpg", "2026-09-03 12:00:00", "pending_review", legacyExtracted, "manual", "2026-09-03 12:00:00", "2026-09-03 12:00:00"]
        );

        await runMigrationsWithLogging(conn, migrationsFolder, consoleMigrationLogger("[migration-0047-test]"));

        const [payments]: any = await conn.query(
          "SELECT id,evidenceVersion,evidenceClass,evidenceObjectKey,evidenceFileHash,extractedDataEvidenceVersion FROM payments WHERE id IN (?,?) ORDER BY id",
          [paymentWithSlip.insertId, paymentNoSlip.insertId]
        );
        const pSlip = payments.find((r: any) => Number(r.id) === Number(paymentWithSlip.insertId));
        const pEmpty = payments.find((r: any) => Number(r.id) === Number(paymentNoSlip.insertId));
        expect(Number(pSlip.evidenceVersion)).toBe(1);
        expect(pSlip.evidenceClass).toBe("legacy_compatibility_required");
        expect(pSlip.evidenceObjectKey).toBeNull();
        expect(pSlip.evidenceFileHash).toBeNull();
        expect(pSlip.extractedDataEvidenceVersion).toBeNull();
        expect(Number(pEmpty.evidenceVersion)).toBe(0);
        expect(pEmpty.extractedDataEvidenceVersion).toBeNull();

        const [wallets]: any = await conn.query(
          "SELECT evidenceVersion,evidenceClass,evidenceObjectKey,evidenceFileHash,extractedDataEvidenceVersion FROM walletTopups WHERE id=?",
          [walletWithSlip.insertId]
        );
        expect(Number(wallets[0].evidenceVersion)).toBe(1);
        expect(wallets[0].evidenceClass).toBe("legacy_compatibility_required");
        expect(wallets[0].evidenceObjectKey).toBeNull();
        expect(wallets[0].evidenceFileHash).toBeNull();
        expect(wallets[0].extractedDataEvidenceVersion).toBeNull();

        const [registry]: any = await conn.query("SELECT COUNT(*) AS cnt FROM slipEvidenceObjects");
        expect(Number(registry[0].cnt)).toBe(0);
      } finally {
        await resetToMigrationCutoff(conn, requireTestUrl(), migrationsFolder, CURRENT);
        await closeMysqlConnectionSafely(conn);
      }
    },
    TIMEOUT
  );
});
