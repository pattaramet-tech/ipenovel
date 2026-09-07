import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  bridgeLegacySelectedFeatureMigration,
  LEGACY_ACCOUNT_SPORTS_MIGRATION_CREATED_AT,
  LEGACY_SELECTED_MIGRATION_CREATED_AT,
  LEGACY_SELECTED_REQUIRED_COLUMNS,
  LEGACY_SELECTED_REQUIRED_INDEXES,
  LEGACY_SELECTED_REQUIRED_TABLES,
  LEGACY_WORKSPACE_REQUIRED_FOREIGN_KEYS,
  LEGACY_WORKSPACE_REQUIRED_INDEXES,
  LEGACY_WORKSPACE_REQUIRED_TABLES,
  RECONSTRUCTED_SELECTED_MIGRATION,
} from "../../scripts/lib/reconstructedMigrationBridge.mjs";

const migrationsFolder = path.resolve(process.cwd(), "drizzle");

type QueryOptions = {
  markerMode?: "full" | "known5" | "unknownPartial";
  missingColumn?: string;
  preexistingWorkspaceTable?: string;
};

function makeCompatibleQuery(options: QueryOptions = {}) {
  const inserts: unknown[][] = [];
  const workspaceStatements: string[] = [];
  let workspaceApplied = options.markerMode !== "known5";

  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("information_schema.tables") && sql.includes("__drizzle_migrations")) {
      return [[{ name: "__drizzle_migrations" }]];
    }
    if (sql.includes("WHERE created_at = ? LIMIT 1")) return [[]];
    if (sql.includes("FROM `__drizzle_migrations`") && sql.includes("WHERE created_at IN")) {
      const markers =
        options.markerMode === "known5"
          ? LEGACY_ACCOUNT_SPORTS_MIGRATION_CREATED_AT
          : options.markerMode === "unknownPartial"
            ? LEGACY_SELECTED_MIGRATION_CREATED_AT.slice(0, 1)
            : LEGACY_SELECTED_MIGRATION_CREATED_AT;
      return [markers.map((createdAt) => ({ createdAt }))];
    }
    if (sql.includes("information_schema.tables") && sql.includes("table_name IN")) {
      const requested = params.map(String);
      const isWorkspaceRequest = requested.every((table) => table.toLowerCase().startsWith("workspace"));
      if (isWorkspaceRequest && !workspaceApplied) {
        return [options.preexistingWorkspaceTable ? [{ name: options.preexistingWorkspaceTable }] : []];
      }
      return [requested.map((name) => ({ name }))];
    }
    if (sql.includes("information_schema.columns")) {
      const [table, column] = params.map(String);
      if (options.missingColumn === `${table}.${column}`) return [[]];
      const required = LEGACY_SELECTED_REQUIRED_COLUMNS.find((entry) => entry.table === table && entry.column === column);
      return [[{ name: column, nullable: required?.nullable ? "YES" : "NO" }]];
    }
    if (sql.includes("information_schema.statistics")) {
      const [, index] = params.map(String);
      return [[{ name: index }]];
    }
    if (sql.includes("information_schema.key_column_usage")) {
      return [[{ name: "compatible_fk_name" }]];
    }
    if (
      /^CREATE TABLE `workspace/i.test(sql) ||
      /^ALTER TABLE `workspace/i.test(sql) ||
      /^CREATE (?:UNIQUE )?INDEX `[^`]+` ON `workspace/i.test(sql)
    ) {
      workspaceApplied = true;
      workspaceStatements.push(sql);
      return [[{ affectedRows: 0 }]];
    }
    if (sql.startsWith("INSERT INTO `__drizzle_migrations`")) {
      inserts.push(params);
      return [[{ affectedRows: 1 }]];
    }
    throw new Error(`Unexpected query in bridge test: ${sql}`);
  });
  return { query, inserts, workspaceStatements };
}

describe("reconstructed selected-feature migration bridge", () => {
  it("leaves a fresh database untouched so normal migrations can run", async () => {
    const query = vi.fn(async () => [[]]);
    await expect(bridgeLegacySelectedFeatureMigration({ query }, migrationsFolder)).resolves.toEqual({
      bridged: false,
      reason: "no-migration-table",
    });
  });

  it("fails closed for an unsupported partial legacy lineage", async () => {
    const { query, inserts } = makeCompatibleQuery({ markerMode: "unknownPartial" });
    await expect(bridgeLegacySelectedFeatureMigration({ query }, migrationsFolder)).rejects.toThrow(
      /not the supported 0040-0044-only state/i
    );
    expect(inserts).toHaveLength(0);
  });

  it("reconciles the exact 0040-0044-only state by applying only Workspace statements", async () => {
    const { query, inserts, workspaceStatements } = makeCompatibleQuery({ markerMode: "known5" });
    await expect(bridgeLegacySelectedFeatureMigration({ query }, migrationsFolder)).resolves.toEqual({
      bridged: true,
      reason: "legacy-account-sports-with-workspace-reconciled",
    });

    expect(workspaceStatements.length).toBeGreaterThan(LEGACY_WORKSPACE_REQUIRED_TABLES.length);
    expect(workspaceStatements.every((sql) => sql.includes("workspace"))).toBe(true);
    expect(workspaceStatements.some((sql) => sql.includes("accountMerge"))).toBe(false);
    expect(workspaceStatements.some((sql) => /^ALTER TABLE `sports/i.test(sql))).toBe(false);
    expect(inserts).toHaveLength(1);

    for (const { table, index } of LEGACY_WORKSPACE_REQUIRED_INDEXES) {
      expect(query).toHaveBeenCalledWith(expect.stringContaining("information_schema.statistics"), [table, index]);
    }
    for (const { table, column, referencedTable, referencedColumn } of LEGACY_WORKSPACE_REQUIRED_FOREIGN_KEYS) {
      expect(query).toHaveBeenCalledWith(expect.stringContaining("information_schema.key_column_usage"), [
        table,
        column,
        referencedTable,
        referencedColumn,
      ]);
    }
  });

  it("fails closed when the known 5/8 state already contains Workspace tables", async () => {
    const { query, inserts, workspaceStatements } = makeCompatibleQuery({
      markerMode: "known5",
      preexistingWorkspaceTable: "workspaceWorkspaces",
    });
    await expect(bridgeLegacySelectedFeatureMigration({ query }, migrationsFolder)).rejects.toThrow(
      /pre-existing Workspace schema objects/i
    );
    expect(workspaceStatements).toHaveLength(0);
    expect(inserts).toHaveLength(0);
  });

  it("fails closed when the recorded legacy lineage does not match physical schema", async () => {
    const { query, inserts } = makeCompatibleQuery({ missingColumn: "sportsMatches.rewardKind" });
    await expect(bridgeLegacySelectedFeatureMigration({ query }, migrationsFolder)).rejects.toThrow(
      /schema does not match the reconstruction contract/i
    );
    expect(inserts).toHaveLength(0);
  });

  it("records only the reconstructed migration marker when the complete lineage and schema match", async () => {
    const { query, inserts, workspaceStatements } = makeCompatibleQuery();
    await expect(bridgeLegacySelectedFeatureMigration({ query }, migrationsFolder)).resolves.toEqual({
      bridged: true,
      reason: "legacy-selected-lineage-verified",
    });

    expect(workspaceStatements).toHaveLength(0);
    expect(inserts).toHaveLength(1);
    const sql = readFileSync(path.join(migrationsFolder, RECONSTRUCTED_SELECTED_MIGRATION.file), "utf8");
    const expectedHash = createHash("sha256").update(sql).digest("hex");
    expect(inserts[0]).toEqual([expectedHash, RECONSTRUCTED_SELECTED_MIGRATION.createdAt]);

    for (const { table, index } of LEGACY_SELECTED_REQUIRED_INDEXES) {
      expect(query).toHaveBeenCalledWith(expect.stringContaining("information_schema.statistics"), [table, index]);
    }
    expect(LEGACY_SELECTED_REQUIRED_TABLES).toEqual(
      expect.arrayContaining([...LEGACY_WORKSPACE_REQUIRED_TABLES])
    );
  });
});
