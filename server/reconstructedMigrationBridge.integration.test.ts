import path from "node:path";
import mysql from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  bridgeLegacySelectedFeatureMigration,
  LEGACY_ACCOUNT_SPORTS_MIGRATION_CREATED_AT,
  LEGACY_SELECTED_MIGRATION_CREATED_AT,
  LEGACY_WORKSPACE_REQUIRED_TABLES,
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

async function replaceCurrentMarkerWithMarkers(conn: mysql.Connection, markers: number[]): Promise<void> {
  await conn.query("DELETE FROM `__drizzle_migrations` WHERE created_at = ?", [RECONSTRUCTED_SELECTED_MIGRATION.createdAt]);
  for (const createdAt of markers) {
    await conn.query("INSERT INTO `__drizzle_migrations` (hash, created_at) VALUES (?, ?)", [
      `legacy-selected-${createdAt}`,
      createdAt,
    ]);
  }
}

async function removeWorkspaceSchema(conn: mysql.Connection): Promise<void> {
  await conn.query("SET FOREIGN_KEY_CHECKS = 0");
  try {
    for (const table of LEGACY_WORKSPACE_REQUIRED_TABLES) {
      await conn.query(`DROP TABLE \`${table}\``);
    }
  } finally {
    await conn.query("SET FOREIGN_KEY_CHECKS = 1");
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
      await replaceCurrentMarkerWithMarkers(conn, LEGACY_SELECTED_MIGRATION_CREATED_AT);

      const result = await bridgeLegacySelectedFeatureMigration(conn, migrationsFolder);
      expect(result).toEqual({ bridged: true, reason: "legacy-selected-lineage-verified" });
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
    },
    TIMEOUT
  );

  it(
    "reconciles the Preview 5/8 state by creating only the missing Workspace schema and preserving existing rows",
    async () => {
      await restoreCurrentSchema(conn);
      await conn.query(
        "INSERT INTO `accountMergeAuditLogs` (`action`, `safeMetadata`) VALUES ('preview_5_of_8_sentinel', 'keep-me-too')"
      );
      await removeWorkspaceSchema(conn);
      await replaceCurrentMarkerWithMarkers(conn, LEGACY_ACCOUNT_SPORTS_MIGRATION_CREATED_AT);

      const [beforeWorkspaceRows]: any = await conn.query(
        "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name LIKE 'workspace%'"
      );
      expect(Number(beforeWorkspaceRows[0].n)).toBe(0);

      const result = await bridgeLegacySelectedFeatureMigration(conn, migrationsFolder);
      expect(result).toEqual({ bridged: true, reason: "legacy-account-sports-with-workspace-reconciled" });
      await runFullChain(conn);

      const [sentinelRows]: any = await conn.query(
        "SELECT `safeMetadata` FROM `accountMergeAuditLogs` WHERE `action` = 'preview_5_of_8_sentinel'"
      );
      expect(sentinelRows).toEqual([{ safeMetadata: "keep-me-too" }]);

      const [workspaceRows]: any = await conn.query(
        "SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name LIKE 'workspace%'"
      );
      const workspaceNames = new Set(workspaceRows.map((row: any) => String(row.name).toLowerCase()));
      for (const table of LEGACY_WORKSPACE_REQUIRED_TABLES) expect(workspaceNames.has(table.toLowerCase())).toBe(true);

      const [legacyMarkerRows]: any = await conn.query(
        `SELECT created_at AS createdAt FROM \`__drizzle_migrations\` WHERE created_at IN (${LEGACY_SELECTED_MIGRATION_CREATED_AT.map(
          () => "?"
        ).join(",")})`,
        LEGACY_SELECTED_MIGRATION_CREATED_AT
      );
      expect(legacyMarkerRows.map((row: any) => Number(row.createdAt)).sort()).toEqual(
        [...LEGACY_ACCOUNT_SPORTS_MIGRATION_CREATED_AT].sort()
      );

      const [currentMarkerRows]: any = await conn.query(
        "SELECT COUNT(*) AS n FROM `__drizzle_migrations` WHERE created_at = ?",
        [RECONSTRUCTED_SELECTED_MIGRATION.createdAt]
      );
      expect(Number(currentMarkerRows[0].n)).toBe(1);
    },
    TIMEOUT
  );

  it(
    "refuses an unsupported partial legacy lineage and does not write the reconstructed marker",
    async () => {
      await restoreCurrentSchema(conn);
      await replaceCurrentMarkerWithMarkers(conn, LEGACY_SELECTED_MIGRATION_CREATED_AT.slice(0, 1));

      await expect(bridgeLegacySelectedFeatureMigration(conn, migrationsFolder)).rejects.toThrow(
        /not the supported 0040-0044-only state/i
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
