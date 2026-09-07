import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  bridgeLegacySelectedFeatureMigration,
  LEGACY_SELECTED_MIGRATION_CREATED_AT,
  LEGACY_SELECTED_REQUIRED_COLUMNS,
  LEGACY_SELECTED_REQUIRED_INDEXES,
  LEGACY_SELECTED_REQUIRED_TABLES,
  RECONSTRUCTED_SELECTED_MIGRATION,
} from "../../scripts/lib/reconstructedMigrationBridge.mjs";

const migrationsFolder = path.resolve(process.cwd(), "drizzle");

function makeCompatibleQuery(options?: { missingColumn?: string; partialMarkers?: boolean }) {
  const inserts: unknown[][] = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes("information_schema.tables") && sql.includes("__drizzle_migrations")) {
      return [[{ name: "__drizzle_migrations" }]];
    }
    if (sql.includes("WHERE created_at = ? LIMIT 1")) return [[]];
    if (sql.includes("FROM `__drizzle_migrations`") && sql.includes("WHERE created_at IN")) {
      const markers = options?.partialMarkers
        ? LEGACY_SELECTED_MIGRATION_CREATED_AT.slice(0, 1)
        : LEGACY_SELECTED_MIGRATION_CREATED_AT;
      return [markers.map((createdAt) => ({ createdAt }))];
    }
    if (sql.includes("information_schema.tables") && sql.includes("table_name IN")) {
      return [LEGACY_SELECTED_REQUIRED_TABLES.map((name) => ({ name }))];
    }
    if (sql.includes("information_schema.columns")) {
      const [table, column] = params.map(String);
      if (options?.missingColumn === `${table}.${column}`) return [[]];
      const required = LEGACY_SELECTED_REQUIRED_COLUMNS.find((entry) => entry.table === table && entry.column === column);
      return [[{ name: column, nullable: required?.nullable ? "YES" : "NO" }]];
    }
    if (sql.includes("information_schema.statistics")) {
      const [, index] = params.map(String);
      return [[{ name: index }]];
    }
    if (sql.startsWith("INSERT INTO `__drizzle_migrations`")) {
      inserts.push(params);
      return [[{ affectedRows: 1 }]];
    }
    throw new Error(`Unexpected query in bridge test: ${sql}`);
  });
  return { query, inserts };
}

describe("reconstructed selected-feature migration bridge", () => {
  it("leaves a fresh database untouched so normal migrations can run", async () => {
    const query = vi.fn(async () => [[]]);
    await expect(bridgeLegacySelectedFeatureMigration({ query }, migrationsFolder)).resolves.toEqual({
      bridged: false,
      reason: "no-migration-table",
    });
  });

  it("fails closed when only part of the legacy selected lineage is recorded", async () => {
    const { query, inserts } = makeCompatibleQuery({ partialMarkers: true });
    await expect(bridgeLegacySelectedFeatureMigration({ query }, migrationsFolder)).rejects.toThrow(
      /legacy selected-feature migration lineage is partial/i
    );
    expect(inserts).toHaveLength(0);
  });

  it("fails closed when the recorded legacy lineage does not match physical schema", async () => {
    const { query, inserts } = makeCompatibleQuery({ missingColumn: "sportsMatches.rewardKind" });
    await expect(bridgeLegacySelectedFeatureMigration({ query }, migrationsFolder)).rejects.toThrow(
      /schema does not match the reconstruction contract/i
    );
    expect(inserts).toHaveLength(0);
  });

  it("records only the reconstructed migration marker when legacy lineage and schema match", async () => {
    const { query, inserts } = makeCompatibleQuery();
    await expect(bridgeLegacySelectedFeatureMigration({ query }, migrationsFolder)).resolves.toEqual({
      bridged: true,
      reason: "legacy-selected-lineage-verified",
    });

    expect(inserts).toHaveLength(1);
    const sql = readFileSync(path.join(migrationsFolder, RECONSTRUCTED_SELECTED_MIGRATION.file), "utf8");
    const expectedHash = createHash("sha256").update(sql).digest("hex");
    expect(inserts[0]).toEqual([expectedHash, RECONSTRUCTED_SELECTED_MIGRATION.createdAt]);

    for (const { table, index } of LEGACY_SELECTED_REQUIRED_INDEXES) {
      expect(query).toHaveBeenCalledWith(expect.stringContaining("information_schema.statistics"), [table, index]);
    }
  });
});
