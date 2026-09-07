import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../..", import.meta.url);
const source = (path: string) => readFileSync(new URL(path, root), "utf8");

describe("workspace M03 Checker/Kanban dual-run static boundaries", () => {
  it("keeps the 0040 migration additive and Workspace-only", () => {
    const migration = source("drizzle/0040_workspace_checker_kanban_foundation.sql");
    expect(migration).not.toMatch(/DROP TABLE|DROP COLUMN|DROP FOREIGN KEY/i);
    for (const table of [
      "workspaceCheckerRuleSets",
      "workspaceCheckerRuns",
      "workspaceCheckerFindings",
      "workspaceKanbanBoards",
      "workspaceKanbanColumns",
      "workspaceKanbanCards",
      "workspaceKanbanTransitions",
    ]) {
      expect(migration).toContain(table);
    }
    expect(migration).not.toMatch(/payment|ocr|slip|wallet/i);
  });

  it("binds checker dedupe to snapshot + rule set + engine version", () => {
    const schema = source("drizzle/schema.ts");
    expect(schema).toContain('uniqueIndex("wcr_snapshot_rule_engine_unique")');
    expect(schema).toContain("table.snapshotId, table.ruleSetId, table.engineVersion");
    expect(schema).toContain('uniqueIndex("wcr_idempotency_unique")');
  });

  it("keeps Kanban movement truth in immutable transitions with optimistic card versions", () => {
    const schema = source("drizzle/schema.ts");
    const service = source("server/workspace/checkerKanban.service.ts");
    expect(schema).toContain('uniqueIndex("wkt_card_idempotency_unique")');
    expect(service).toContain("eq(workspaceKanbanCards.version, input.expectedVersion)");
    expect(service).toContain("workspaceKanbanTransitions");
  });

  it("does not mutate migration ownership or implement publish/AI side effects", () => {
    const service = source("server/workspace/checkerKanban.service.ts");
    expect(service).not.toMatch(/insert\(workspaceMigrationRegistry\)|update\(workspaceMigrationRegistry\)|delete\(workspaceMigrationRegistry\)/);
    expect(service).not.toMatch(/workspacePublish|workspaceAi|outbox|episodePurchases|walletTransactions/);
  });
});
