import { describe, expect, it } from "vitest";
import { getTableColumns, is } from "drizzle-orm";
import { MySqlTable } from "drizzle-orm/mysql-core";
import * as schema from "../../drizzle/schema";
import {
  ADMIN_USER_DELETION_CLASSIFICATION,
  ADMIN_USER_DELETION_INDIRECT_TABLES,
} from "./adminUserDeletionClassification";

/**
 * Exhaustive, REFLECTION-based (not hand-maintained-list-based) proof that
 * every user-referencing column in drizzle/schema.ts has been deliberately
 * classified for the Admin Users Management hard-delete safety check - see
 * adminUserDeletionClassification.ts's own top-of-file docstring. Mirrors
 * server/services/accountRecoveryDataClassification.test.ts's pattern
 * exactly, applied to this feature's own (deliberately separate)
 * classification list.
 */

const USER_REFERENCE_COLUMN_NAME_PATTERN =
  /userid|ownerid|createdby|reviewedby|approvedby|actorid|adminid|recipientid|requesterid/i;

type DiscoveredColumn = { table: string; column: string };

function discoverUserReferenceColumns(): DiscoveredColumn[] {
  const found: DiscoveredColumn[] = [];
  for (const [exportName, value] of Object.entries(schema)) {
    if (!is(value, MySqlTable)) continue;
    const columns = getTableColumns(value as any);
    for (const [columnKey, column] of Object.entries(columns)) {
      const col = column as { dataType?: string };
      if (col.dataType !== "number") continue;
      if (!USER_REFERENCE_COLUMN_NAME_PATTERN.test(columnKey)) continue;
      found.push({ table: exportName, column: columnKey });
    }
  }
  return found;
}

function discoverAllTableNames(): Set<string> {
  const names = new Set<string>();
  for (const [exportName, value] of Object.entries(schema)) {
    if (!is(value, MySqlTable)) continue;
    names.add(exportName);
  }
  return names;
}

describe("ADMIN_USER_DELETION_CLASSIFICATION is exhaustive and up to date", () => {
  const discovered = discoverUserReferenceColumns();
  const discoveredKeys = new Set(discovered.map((d) => `${d.table}.${d.column}`));
  const classifiedKeys = new Set(
    ADMIN_USER_DELETION_CLASSIFICATION.map((c) => `${c.table}.${c.column}`)
  );

  it("discovery actually found something (sanity check that reflection itself works, not silently returning an empty list)", () => {
    expect(discovered.length).toBeGreaterThan(20);
  });

  it("every discovered user-referencing column in the schema has a classification entry - fails when a new column is added without a classification decision", () => {
    const unclassified = discovered.filter((d) => !classifiedKeys.has(`${d.table}.${d.column}`));
    expect(unclassified).toEqual([]);
  });

  it("every classification entry corresponds to a real, currently-existing table+column - fails when one is renamed/removed and this file goes stale", () => {
    const stale = ADMIN_USER_DELETION_CLASSIFICATION.filter(
      (c) => !discoveredKeys.has(`${c.table}.${c.column}`)
    );
    expect(stale).toEqual([]);
  });

  it("no duplicate (table, column) entries in the classification list", () => {
    const keys = ADMIN_USER_DELETION_CLASSIFICATION.map((c) => `${c.table}.${c.column}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("every classification entry has a non-empty reason", () => {
    for (const entry of ADMIN_USER_DELETION_CLASSIFICATION) {
      expect(entry.reason.trim().length).toBeGreaterThan(10);
    }
  });

  it("exactly one entry is classified as login_data (authIdentities.userId) - never treated as a blocker", () => {
    const loginData = ADMIN_USER_DELETION_CLASSIFICATION.filter((c) => c.category === "login_data");
    expect(loginData).toEqual([
      expect.objectContaining({ table: "authIdentities", column: "userId" }),
    ]);
  });

  it("actor/admin reference columns that Account Recovery deliberately ignores are treated as blockers here (audit_or_actor) - deletion has a strictly stricter policy", () => {
    const actorTables = ADMIN_USER_DELETION_CLASSIFICATION.filter((c) => c.category === "audit_or_actor").map(
      (c) => `${c.table}.${c.column}`
    );
    expect(actorTables).toEqual(
      expect.arrayContaining([
        "orderHistory.actorUserId",
        "payments.reviewedByUserId",
        "payments.approvedByAdminId",
        "topupLogs.createdBy",
        "walletTopups.reviewedByUserId",
        "walletTopups.approvedByAdminId",
        "dailyCheckinCampaigns.createdBy",
      ])
    );
  });

  it("[review finding on PR #45] adminUserAuditLogs.actorAdminId (WHO performed a past edit/delete) is audit_or_actor - a former admin's identity must remain protected even after they're demoted to role=\"user\"", () => {
    const entry = ADMIN_USER_DELETION_CLASSIFICATION.find(
      (c) => c.table === "adminUserAuditLogs" && c.column === "actorAdminId"
    );
    expect(entry?.category).toBe("audit_or_actor");
  });

  it("adminUserAuditLogs.targetUserId (WHAT was done to a user) stays never_blocks - the record of a past action on this account must survive its deletion, unlike who performed it", () => {
    const entry = ADMIN_USER_DELETION_CLASSIFICATION.find(
      (c) => c.table === "adminUserAuditLogs" && c.column === "targetUserId"
    );
    expect(entry?.category).toBe("never_blocks");
  });

  it("does not let always-provisioned cascade rows block deletion of every otherwise-empty account", () => {
    expect(ADMIN_USER_DELETION_CLASSIFICATION).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: "pointsAccounts", column: "userId", category: "never_blocks" }),
      expect.objectContaining({ table: "accountMutationGuards", column: "userId", category: "never_blocks" }),
    ]));
  });
});

describe("indirect (no-direct-column) tables are documented and real", () => {
  const allTableNames = discoverAllTableNames();

  it("every ADMIN_USER_DELETION_INDIRECT_TABLES entry names a real table export", () => {
    for (const entry of ADMIN_USER_DELETION_INDIRECT_TABLES) {
      expect(allTableNames.has(entry.table)).toBe(true);
    }
  });

  it("cartItems, orderItems, and payments (no direct userId column) are present in the indirect inventory", () => {
    const tableNames = ADMIN_USER_DELETION_INDIRECT_TABLES.map((e) => e.table);
    expect(tableNames).toContain("cartItems");
    expect(tableNames).toContain("orderItems");
    expect(tableNames).toContain("payments");
  });
});
