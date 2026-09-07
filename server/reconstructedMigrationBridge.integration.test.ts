import path from "node:path";
import mysql from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bridgeLegacySelectedFeatureMigration,
  LEGACY_SELECTED_MIGRATION_CREATED_AT,
  RECONSTRUCTED_SELECTED_MIGRATION,
} from "../scripts/lib/reconstructedMigrationBridge.mjs";
import { buildTestDbConnectionOptions, parseTestDbTransportMode } from "./test-helpers/testDbConnectionOptions";
import { closeMysqlConnectionSafely } from "./test-helpers/closeMysqlConnectionSafely";
import { resetToEmptySchema } from "./test-helpers/resetToEmptySchema";
import { consoleMigrationLogger, runMigrationsWithLogging } from "./test-helpers/migrateTestDbWithLogging";

const migrationsFolder = path.resolve(__dirname, "..", "drizzle");
const TIMEOUT = 180_000;

function requireTestUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("reconstructed migration bridge integration tests require TEST_DATABASE_URL");
  return url;
}

async function connect(): Promise<mysql.Connection> {
  return mysql.createConnection(
    buildTestDbConnectionOptions(requireTestUrl(), parseTestDbTransportMode(process.env.TEST_DATABASE_TRANSPORT))
  );
}

async function runFullChain(conn: mysql.Connection): Promise<void> {
  await runMigrationsWithLogging(conn, migrationsFolder, consoleMigrationLogger("[reconstruction-bridge-test]"));
}

async function restoreCurrentSchema(conn: mysql.Connection): Promise<void> {
  await resetToEmptySchema(conn, requireTestUrl());
  await runFullChain(conn);
}

async function replaceCurrentMarkerWithLegacyLineage(conn: mysql.Connection, markerCount: number): Promise<void> {
  await conn.query("DELETE FROM `__drizzle_migrations` WHERE created_at = ?", [RECONSTRUCTED_SELECTED_MIGRATION.createdAt]);
  for (const createdAt of LEGACY_SELECTED_MIGRATION_CREATED_AT.slice(0, markerCount)) {
    await conn.query("INSERT INTO `__drizzle_migrations` (hash, created_at) VALUES (?, ?)", [
      `legacy-selected-${createdAt}`,
      createdAt,
    ]);
  }
}

describe.sequential("reconstructed migration bridge against a real disposable database", () => {
  let conn: mysql.Connection;

  beforeAll(async () => {
    conn = await connect();
    await restoreCurrentSchema(conn);
  }, TIMEOUT);

  afterAll(async () => {
    if (conn) {
      try {
        await restoreCurrentSchema(conn);
      } finally {
        await closeMysqlConnectionSafely(conn);
      }
    }
  }, TIMEOUT);

  it(
    "bridges a complete legacy selected-feature lineage without replaying DDL or changing existing rows",
    async () => {
      await restoreCurrentSchema(conn);
      await conn.query(
        "INSERT INTO `accountMergeAuditLogs` (`action`, `safeMetadata`) VALUES ('legacy_bridge_sentinel', 'keep-me')"
      );
      await replaceCurrentMarkerWithLegacyLineage(conn, LEGACY_SELECTED_MIGRATION_CREATED_AT.length);

      const result = await bridgeLegacySelectedFeatureMigration(conn, migrationsFolder);
      expect(result).toEqual({ bridged: true, reason: "legacy-selected-lineage-verified" });

      // This is the exact resume step that used to replay reconstructed 0037
      // and fail with ER_TABLE_EXISTS_ERROR. With the verified bridge marker
      // in place it must be a no-op for 0037.
      await runFullChain(conn);

      const [sentinelRows]: any = await conn.query(
        "SELECT `safeMetadata` FROM `accountMergeAuditLogs` WHERE `action` = 'legacy_bridge_sentinel'"
      );
      expect(sentinelRows).toEqual([{ safeMetadata: "keep-me" }]);

      const [currentMarkerRows]: any = await conn.query(
        "SELECT COUNT(*) AS n FROM `__drizzle_migrations` WHERE created_at = ?",
        [RECONSTRUCTED_SELECTED_MIGRATION.createdAt]
      );
      expect(Number(currentMarkerRows[0].n)).toBe(1);

      const [legacyMarkerRows]: any = await conn.query(
        `SELECT COUNT(*) AS n FROM \`__drizzle_migrations\` WHERE created_at IN (${LEGACY_SELECTED_MIGRATION_CREATED_AT.map(
          () => "?"
        ).join(",")})`,
        LEGACY_SELECTED_MIGRATION_CREATED_AT
      );
      expect(Number(legacyMarkerRows[0].n)).toBe(LEGACY_SELECTED_MIGRATION_CREATED_AT.length);
    },
    TIMEOUT
  );

  it(
    "refuses a partial legacy lineage and does not write the reconstructed marker",
    async () => {
      await restoreCurrentSchema(conn);
      await replaceCurrentMarkerWithLegacyLineage(conn, 1);

      await expect(bridgeLegacySelectedFeatureMigration(conn, migrationsFolder)).rejects.toThrow(
        /legacy selected-feature migration lineage is partial/i
      );

      const [currentMarkerRows]: any = await conn.query(
        "SELECT COUNT(*) AS n FROM `__drizzle_migrations` WHERE created_at = ?",
        [RECONSTRUCTED_SELECTED_MIGRATION.createdAt]
      );
      expect(Number(currentMarkerRows[0].n)).toBe(0);
    },
    TIMEOUT
  );
});
