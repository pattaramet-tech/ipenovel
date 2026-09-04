import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import * as db from "./db";
import { findMissingSchemaObjects } from "../scripts/migrate.mjs";
import { buildTestDbConnectionOptions, parseTestDbTransportMode } from "./test-helpers/testDbConnectionOptions";
import { closeMysqlConnectionSafely } from "./test-helpers/closeMysqlConnectionSafely";
import { resetToMigrationCutoff } from "./test-helpers/resetToMigrationCutoff";
import { runMigrationsWithLogging, consoleMigrationLogger } from "./test-helpers/migrateTestDbWithLogging";

const migrationsFolder = path.resolve(__dirname, "..", "drizzle");
const PREVIOUS = "0046_add_points_accounts_mutex";
const CURRENT = "0047_add_immutable_slip_evidence";
const TIMEOUT = 240000;

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

function migrationStatements(): string[] {
  return fs
    .readFileSync(path.join(migrationsFolder, `${CURRENT}.sql`), "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
}

describe.sequential("migration 0047 immutable slip evidence - real disposable MariaDB", () => {
  it("retries partial DDL, verifies exact shapes, and serializes concurrent replacements into monotonic versions", async () => {
    const conn = await connect();
    try {
      await resetToMigrationCutoff(conn, requireTestUrl(), migrationsFolder, PREVIOUS);

      // Simulate a process exit after the first DDL statement committed but
      // before the migration journal advanced. The real retry must converge.
      await conn.query(migrationStatements()[0]);
      await runMigrationsWithLogging(conn, migrationsFolder, consoleMigrationLogger("[migration-0047-test]"));
      expect(await findMissingSchemaObjects(conn)).toEqual([]);

      const stamp = Date.now();
      const [user]: any = await conn.query(
        "INSERT INTO users (openId,name,email,loginMethod,role) VALUES (?,?,?,?,?)",
        [`ipe026-${stamp}`, "IPE-026", `ipe026-${stamp}@example.test`, "test", "user"]
      );
      await conn.query(
        "INSERT INTO accountMutationGuards (userId,generation,mergeState) VALUES (?,0,'open')",
        [user.insertId]
      );
      const [order]: any = await conn.query(
        "INSERT INTO orders (orderNumber,userId,totalAmount,status,paymentStatus) VALUES (?,?,?,'pending','submitted')",
        [`IPE026-${stamp}`, user.insertId, "100.00"]
      );
      const [payment]: any = await conn.query(
        "INSERT INTO payments (orderId,status,ocrConfidence) VALUES (?,'pending',0)",
        [order.insertId]
      );

      const hashA = "a".repeat(64);
      const hashB = "b".repeat(64);
      const refA = `r2p:payment-slips/${user.insertId}/${hashA}/a-${stamp}.png`;
      const refB = `r2p:payment-slips/${user.insertId}/${hashB}/b-${stamp}.png`;
      await db.registerImmutableSlipUpload({
        objectIdentity: refA,
        ownerUserId: user.insertId,
        fileHash: hashA,
        objectSize: 101,
        mimeType: "image/png",
      });
      await db.registerImmutableSlipUpload({
        objectIdentity: refB,
        ownerUserId: user.insertId,
        fileHash: hashB,
        objectSize: 102,
        mimeType: "image/png",
      });

      const published = await Promise.all([
        db.publishReplacementSlipIfReviewable(payment.insertId, {
          slipImageUrl: refA,
          slipSubmittedAt: new Date(),
          extractedData: JSON.stringify({ fileHash: hashA }),
          fileHash: hashA,
        }),
        db.publishReplacementSlipIfReviewable(payment.insertId, {
          slipImageUrl: refB,
          slipSubmittedAt: new Date(),
          extractedData: JSON.stringify({ fileHash: hashB }),
          fileHash: hashB,
        }),
      ]);
      expect(published).toEqual([true, true]);

      const [subjectRows]: any = await conn.query(
        "SELECT evidenceVersion,slipEvidenceClass,slipEvidenceId,extractedEvidenceVersion FROM payments WHERE id=?",
        [payment.insertId]
      );
      expect(subjectRows[0]).toMatchObject({ slipEvidenceClass: "modern_immutable" });
      expect(Number(subjectRows[0].evidenceVersion)).toBe(2);
      expect(Number(subjectRows[0].extractedEvidenceVersion)).toBe(2);
      expect(subjectRows[0].slipEvidenceId).not.toBeNull();

      const [bindings]: any = await conn.query(
        "SELECT evidenceVersion,ownerUserId,sourceType,sourceId,fileHash FROM slipEvidenceBindings WHERE sourceType='order_payment' AND sourceId=? ORDER BY evidenceVersion",
        [payment.insertId]
      );
      expect(bindings.map((row: any) => Number(row.evidenceVersion))).toEqual([1, 2]);
      expect(new Set(bindings.map((row: any) => row.fileHash))).toEqual(new Set([hashA, hashB]));
      expect(bindings.every((row: any) => Number(row.ownerUserId) === Number(user.insertId))).toBe(true);

      const [otherUser]: any = await conn.query(
        "INSERT INTO users (openId,name,email,loginMethod,role) VALUES (?,?,?,?,?)",
        [`ipe026-other-${stamp}`, "IPE-026 other", `ipe026-other-${stamp}@example.test`, "test", "user"]
      );
      const otherHash = "d".repeat(64);
      const otherRef = `r2p:payment-slips/${otherUser.insertId}/${otherHash}/other-${stamp}.png`;
      await db.registerImmutableSlipUpload({
        objectIdentity: otherRef,
        ownerUserId: otherUser.insertId,
        fileHash: otherHash,
        objectSize: 103,
        mimeType: "image/png",
      });
      await expect(db.publishReplacementSlipIfReviewable(payment.insertId, {
        slipImageUrl: otherRef,
        slipSubmittedAt: new Date(),
        extractedData: JSON.stringify({ fileHash: otherHash }),
        fileHash: otherHash,
      })).rejects.toMatchObject({ code: "IMMUTABLE_EVIDENCE_OWNER_MISMATCH" });
      const [afterRejectedOwner]: any = await conn.query(
        "SELECT evidenceVersion FROM payments WHERE id=?",
        [payment.insertId]
      );
      expect(Number(afterRejectedOwner[0].evidenceVersion)).toBe(2);

      // The durable registry itself is write-once by unique identity: a
      // second row cannot associate the published identity with other bytes.
      await expect(conn.query(
        "INSERT INTO slipEvidenceUploads (objectIdentity,ownerUserId,fileHash,objectSize,mimeType) VALUES (?,?,?,?,?)",
        [refA, user.insertId, "c".repeat(64), 999, "image/png"]
      )).rejects.toMatchObject({ code: "ER_DUP_ENTRY" });
    } finally {
      await resetToMigrationCutoff(conn, requireTestUrl(), migrationsFolder, CURRENT);
      await closeMysqlConnectionSafely(conn);
    }
  }, TIMEOUT);
});
