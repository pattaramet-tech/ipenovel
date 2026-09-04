import path from "node:path";
import { describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { findMissingSchemaObjects } from "../scripts/migrate.mjs";
import { buildTestDbConnectionOptions, parseTestDbTransportMode } from "./test-helpers/testDbConnectionOptions";
import { closeMysqlConnectionSafely } from "./test-helpers/closeMysqlConnectionSafely";
import { resetToMigrationCutoff } from "./test-helpers/resetToMigrationCutoff";
import { runMigrationsWithLogging, consoleMigrationLogger } from "./test-helpers/migrateTestDbWithLogging";

const migrationsFolder = path.resolve(__dirname, "..", "drizzle");
const PREVIOUS = "0048_repair_immutable_slip_evidence";
const CURRENT = "0049_repair_immutable_slip_evidence_shapes";

function requireTestUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("migration 0049 integration test requires TEST_DATABASE_URL=.../ipenovel_test");
  return url;
}

describe.sequential("migration 0049 immutable slip evidence shape repair", () => {
  it("converges the seven stale column shapes reported by production startup", async () => {
    const conn = await mysql.createConnection(
      buildTestDbConnectionOptions(requireTestUrl(), parseTestDbTransportMode(process.env.TEST_DATABASE_TRANSPORT))
    );
    try {
      await resetToMigrationCutoff(conn, requireTestUrl(), migrationsFolder, PREVIOUS);

      await conn.query("ALTER TABLE payments MODIFY COLUMN slipEvidenceClass varchar(64) NULL DEFAULT NULL");
      await conn.query("ALTER TABLE payments MODIFY COLUMN slipEvidenceId int NOT NULL DEFAULT 0");
      await conn.query("ALTER TABLE payments MODIFY COLUMN extractedEvidenceVersion bigint NULL DEFAULT NULL");
      await conn.query("ALTER TABLE walletTopups MODIFY COLUMN slipEvidenceClass varchar(64) NULL DEFAULT NULL");
      await conn.query("ALTER TABLE walletTopups MODIFY COLUMN slipEvidenceId int NOT NULL DEFAULT 0");
      await conn.query("ALTER TABLE walletTopups MODIFY COLUMN extractedEvidenceVersion bigint NULL DEFAULT NULL");
      await conn.query("ALTER TABLE slipEvidenceBindings MODIFY COLUMN uploadId int NOT NULL DEFAULT 0");

      const before = await findMissingSchemaObjects(conn);
      expect(before).toEqual(expect.arrayContaining([
        "column shape payments.slipEvidenceClass",
        "column shape payments.slipEvidenceId",
        "column shape payments.extractedEvidenceVersion",
        "column shape walletTopups.slipEvidenceClass",
        "column shape walletTopups.slipEvidenceId",
        "column shape walletTopups.extractedEvidenceVersion",
        "column shape slipEvidenceBindings.uploadId",
      ]));

      await runMigrationsWithLogging(conn, migrationsFolder, consoleMigrationLogger("[migration-0049-test]"));
      expect(await findMissingSchemaObjects(conn)).toEqual([]);
    } finally {
      await resetToMigrationCutoff(conn, requireTestUrl(), migrationsFolder, CURRENT);
      await closeMysqlConnectionSafely(conn);
    }
  }, 240000);
});
