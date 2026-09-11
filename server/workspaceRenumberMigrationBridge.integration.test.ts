import path from "node:path";
import mysql from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CURRENT_WORKSPACE_RENUMBER_MIGRATIONS,
  LEGACY_WORKSPACE_RENUMBER_MIGRATIONS,
  bridgeRenumberedWorkspaceMigrations,
} from "../scripts/lib/workspaceRenumberMigrationBridge.mjs";
import { buildTestDbConnectionOptions, parseTestDbTransportMode } from "./test-helpers/testDbConnectionOptions";
import { closeMysqlConnectionSafely } from "./test-helpers/closeMysqlConnectionSafely";
import { resetToEmptySchema } from "./test-helpers/resetToEmptySchema";
import { consoleMigrationLogger, runMigrationsWithLogging } from "./test-helpers/migrateTestDbWithLogging";

const migrationsFolder = path.resolve(__dirname, "..", "drizzle");
const TIMEOUT = 180_000;

function requireTestUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error("Workspace renumber bridge integration tests require TEST_DATABASE_URL");
  return url;
}

async function connect(): Promise<mysql.Connection> {
  return mysql.createConnection(
    buildTestDbConnectionOptions(requireTestUrl(), parseTestDbTransportMode(process.env.TEST_DATABASE_TRANSPORT))
  );
}

async function runFullChain(conn: mysql.Connection): Promise<void> {
  await runMigrationsWithLogging(conn, migrationsFolder, consoleMigrationLogger("[workspace-renumber-bridge-test]"));
}

async function restoreCurrentSchema(conn: mysql.Connection): Promise<void> {
  await resetToEmptySchema(conn, requireTestUrl());
  await runFullChain(conn);
}

async function replaceCurrentWorkspaceMarkersWithLegacy(
  conn: mysql.Connection,
  legacyCreatedAts = LEGACY_WORKSPACE_RENUMBER_MIGRATIONS.map((migration) => migration.createdAt)
): Promise<void> {
  const currentCreatedAts = CURRENT_WORKSPACE_RENUMBER_MIGRATIONS.map((migration) => migration.createdAt);
  await conn.query(
    `DELETE FROM \`__drizzle_migrations\` WHERE created_at IN (${currentCreatedAts.map(() => "?").join(",")})`,
    currentCreatedAts
  );
  for (const createdAt of legacyCreatedAts) {
    await conn.query("INSERT INTO `__drizzle_migrations` (hash, created_at) VALUES (?, ?)", [
      `legacy-workspace-${createdAt}`,
      createdAt,
    ]);
  }
}

async function currentMarkerCount(conn: mysql.Connection): Promise<number> {
  const currentCreatedAts = CURRENT_WORKSPACE_RENUMBER_MIGRATIONS.map((migration) => migration.createdAt);
  const [rows]: any = await conn.query(
    `SELECT COUNT(*) AS n FROM \`__drizzle_migrations\` WHERE created_at IN (${currentCreatedAts.map(() => "?").join(",")})`,
    currentCreatedAts
  );
  return Number(rows[0].n);
}

describe.sequential("Workspace migration renumber bridge against a real disposable database", () => {
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
    "reconciles the complete pre-renumber Workspace 0039-0043 lineage without replaying DDL",
    async () => {
      await restoreCurrentSchema(conn);
      await replaceCurrentWorkspaceMarkersWithLegacy(conn);

      const [beforeTables]: any = await conn.query(
        "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name LIKE 'workspace%'"
      );

      const result = await bridgeRenumberedWorkspaceMigrations(conn, migrationsFolder);
      expect(result).toEqual({ bridged: true, reason: "legacy-workspace-renumber-lineage-verified" });
      expect(await currentMarkerCount(conn)).toBe(CURRENT_WORKSPACE_RENUMBER_MIGRATIONS.length);

      await runFullChain(conn);

      const [afterTables]: any = await conn.query(
        "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name LIKE 'workspace%'"
      );
      expect(Number(afterTables[0].n)).toBe(Number(beforeTables[0].n));
      expect(await currentMarkerCount(conn)).toBe(CURRENT_WORKSPACE_RENUMBER_MIGRATIONS.length);
    },
    TIMEOUT
  );

  it(
    "is a no-op for a database already on the current 0040-0044 lineage",
    async () => {
      await restoreCurrentSchema(conn);
      await expect(bridgeRenumberedWorkspaceMigrations(conn, migrationsFolder)).resolves.toEqual({
        bridged: false,
        reason: "already-current",
      });
    },
    TIMEOUT
  );

  it(
    "refuses a partial legacy Workspace lineage and writes no current markers",
    async () => {
      await restoreCurrentSchema(conn);
      const partialLegacy = LEGACY_WORKSPACE_RENUMBER_MIGRATIONS.slice(0, 4).map((migration) => migration.createdAt);
      await replaceCurrentWorkspaceMarkersWithLegacy(conn, partialLegacy);

      await expect(bridgeRenumberedWorkspaceMigrations(conn, migrationsFolder)).rejects.toThrow(
        /Legacy Workspace migration lineage is partial \(4\/5 markers present\)/i
      );
      expect(await currentMarkerCount(conn)).toBe(0);
    },
    TIMEOUT
  );

  it(
    "refuses a schema mismatch and writes no current markers",
    async () => {
      await restoreCurrentSchema(conn);
      await replaceCurrentWorkspaceMarkersWithLegacy(conn);
      await conn.query("ALTER TABLE `workspaceOutbox` DROP COLUMN `ownershipEpoch`");

      await expect(bridgeRenumberedWorkspaceMigrations(conn, migrationsFolder)).rejects.toThrow(
        /column workspaceOutbox\.ownershipEpoch/i
      );
      expect(await currentMarkerCount(conn)).toBe(0);
    },
    TIMEOUT
  );
});
