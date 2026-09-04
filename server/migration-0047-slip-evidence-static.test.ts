import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  REQUIRED_COLUMNS,
  REQUIRED_COLUMN_SHAPES,
  REQUIRED_FOREIGN_KEYS,
  REQUIRED_INDEXES,
  REQUIRED_TABLES,
} from "../scripts/migrate.mjs";

const migration = fs.readFileSync(
  path.resolve(process.cwd(), "drizzle/0047_add_immutable_slip_evidence.sql"),
  "utf8"
);
const dbCode = fs.readFileSync(path.resolve(process.cwd(), "server/db.ts"), "utf8");

describe("migration 0047 immutable/versioned evidence static contract", () => {
  it("is additive and guards every ALTER for restart-safe retry", () => {
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS `slipEvidenceUploads`/);
    expect(migration).toMatch(/CREATE TABLE IF NOT EXISTS `slipEvidenceBindings`/);
    expect(migration).toMatch(/information_schema\.columns/);
    expect(migration).toMatch(/information_schema\.statistics/);
    expect(migration).toMatch(/information_schema\.referential_constraints/);
    expect(migration).not.toMatch(/DROP TABLE|DROP COLUMN|TRUNCATE/i);
  });

  it("has exact owner/source/version/object/hash uniqueness and references", () => {
    expect(REQUIRED_TABLES).toEqual(expect.arrayContaining([
      "slipEvidenceUploads",
      "slipEvidenceBindings",
      "payments",
      "walletTopups",
    ]));
    expect(REQUIRED_INDEXES).toEqual(expect.arrayContaining([
      expect.objectContaining({
        table: "slipEvidenceUploads",
        index: "slipEvidenceUploads_objectIdentity_unique",
        unique: true,
        columns: ["objectIdentity"],
      }),
      expect.objectContaining({
        table: "slipEvidenceBindings",
        index: "slipEvidenceBindings_source_version_unique",
        unique: true,
        columns: ["sourceType", "sourceId", "evidenceVersion"],
      }),
    ]));
    expect(REQUIRED_FOREIGN_KEYS).toEqual(expect.arrayContaining([
      expect.objectContaining({
        table: "payments",
        constraint: "payments_slipEvidenceId_fk",
        deleteRule: "RESTRICT",
      }),
      expect.objectContaining({
        table: "walletTopups",
        constraint: "walletTopups_slipEvidenceId_fk",
        deleteRule: "RESTRICT",
      }),
    ]));
    const migration0047SecurityColumns = REQUIRED_COLUMNS.filter(({ table }) =>
      table === "payments" ||
      table === "walletTopups" ||
      table === "slipEvidenceUploads" ||
      table === "slipEvidenceBindings"
    );
    for (const required of migration0047SecurityColumns) {
      expect(REQUIRED_COLUMN_SHAPES).toContainEqual(expect.objectContaining(required));
    }
  });

  it("keeps both registries append-only in application code", () => {
    expect(dbCode).toMatch(/insert\(slipEvidenceUploads\)/);
    expect(dbCode).toMatch(/insert\(slipEvidenceBindings\)/);
    expect(dbCode).not.toMatch(/update\(slipEvidenceUploads\)|delete\(slipEvidenceUploads\)/);
    expect(dbCode).not.toMatch(/update\(slipEvidenceBindings\)|delete\(slipEvidenceBindings\)/);
  });
});
