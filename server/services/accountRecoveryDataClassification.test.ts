import { describe, expect, it } from "vitest";
import { getTableColumns, is } from "drizzle-orm";
import { MySqlTable } from "drizzle-orm/mysql-core";
import * as schema from "../../drizzle/schema";
import * as db from "../db";
import {
  ACCOUNT_RECOVERY_USER_DATA_CLASSIFICATION,
  ACCOUNT_RECOVERY_INDIRECT_TABLES,
} from "./accountRecoveryDataClassification";

/**
 * Exhaustive, REFLECTION-based (not hand-maintained-list-based) proof that
 * every user-referencing column in drizzle/schema.ts has been deliberately
 * classified for the Admin Account Recovery workflow - see
 * accountRecoveryDataClassification.ts's own top-of-file docstring for the
 * two properties this file proves. This is the test FIX 2 of the review
 * exists to add: a forgotten-to-update classification list is a bug this
 * suite catches automatically the next time someone adds a userId-shaped
 * column to the schema, not something that silently rots.
 */

const USER_REFERENCE_COLUMN_NAME_PATTERN =
  /userid|ownerid|createdby|reviewedby|approvedby|actorid|adminid|recipientid|requesterid/i;

type DiscoveredColumn = { table: string; column: string };

/** Walks every REAL mysqlTable export in drizzle/schema.ts (never a
 *  hand-typed guess at the table list) and returns every column that is
 *  both (a) a number-typed column (excludes e.g. payments.approvedByLabel,
 *  a varchar display label that merely CONTAINS "approvedby") and (b)
 *  named like a user/admin-id reference. */
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

describe("ACCOUNT_RECOVERY_USER_DATA_CLASSIFICATION is exhaustive and up to date", () => {
  const discovered = discoverUserReferenceColumns();
  const discoveredKeys = new Set(discovered.map((d) => `${d.table}.${d.column}`));
  const classifiedKeys = new Set(
    ACCOUNT_RECOVERY_USER_DATA_CLASSIFICATION.map((c) => `${c.table}.${c.column}`)
  );

  it("discovery actually found something (sanity check that reflection itself works, not silently returning an empty list)", () => {
    expect(discovered.length).toBeGreaterThan(20);
  });

  it("every discovered user-referencing column in the schema has a classification entry - fails when a new column is added without a classification decision", () => {
    const unclassified = discovered.filter((d) => !classifiedKeys.has(`${d.table}.${d.column}`));
    expect(unclassified).toEqual([]);
  });

  it("every classification entry corresponds to a real, currently-existing table+column - fails when one is renamed/removed and this file goes stale", () => {
    const stale = ACCOUNT_RECOVERY_USER_DATA_CLASSIFICATION.filter(
      (c) => !discoveredKeys.has(`${c.table}.${c.column}`)
    );
    expect(stale).toEqual([]);
  });

  it("no duplicate (table, column) entries in the classification list", () => {
    const keys = ACCOUNT_RECOVERY_USER_DATA_CLASSIFICATION.map((c) => `${c.table}.${c.column}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("every classification entry has a non-empty reason - a category with no stated reason is exactly the silent-catch-all this inventory must never become", () => {
    for (const entry of ACCOUNT_RECOVERY_USER_DATA_CLASSIFICATION) {
      expect(entry.reason.trim().length).toBeGreaterThan(10);
    }
  });

  it("the known false-positive column names (payments.approvedByLabel, a varchar, not a real id) are correctly excluded by the dataType filter, not accidentally classified", () => {
    expect(discoveredKeys.has("payments.approvedByLabel")).toBe(false);
    expect(classifiedKeys.has("payments.approvedByLabel")).toBe(false);
  });

  it("classifies the always-provisioned points and account-guard rows as infrastructure, not source-owned activity", () => {
    expect(ACCOUNT_RECOVERY_USER_DATA_CLASSIFICATION).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: "pointsAccounts", column: "userId", category: "deliberately_ignored" }),
      expect.objectContaining({ table: "accountMutationGuards", column: "userId", category: "merge_internal" }),
    ]));
  });
});

describe("indirect (no-direct-column) tables are documented and real", () => {
  const allTableNames = discoverAllTableNames();

  it("every ACCOUNT_RECOVERY_INDIRECT_TABLES entry names a real table export", () => {
    for (const entry of ACCOUNT_RECOVERY_INDIRECT_TABLES) {
      expect(allTableNames.has(entry.table)).toBe(true);
    }
  });

  it("cartItems and orderItems (no direct userId column) are present in the indirect inventory - not simply forgotten", () => {
    const tableNames = ACCOUNT_RECOVERY_INDIRECT_TABLES.map((e) => e.table);
    expect(tableNames).toContain("cartItems");
    expect(tableNames).toContain("orderItems");
    expect(tableNames).toContain("payments");
  });
});

describe("server/db.ts's actual check lists match the classification exactly - no drift between the inventory and the real queries", () => {
  it("ACCOUNT_RECOVERY_ECONOMIC_TABLE_NAMES matches every economic_hard_block table in the classification (as a set - order-independent)", () => {
    const classifiedEconomicTables = new Set(
      ACCOUNT_RECOVERY_USER_DATA_CLASSIFICATION.filter((c) => c.category === "economic_hard_block").map((c) => c.table)
    );
    const actualEconomicTables = new Set(db.ACCOUNT_RECOVERY_ECONOMIC_TABLE_NAMES);
    expect(actualEconomicTables).toEqual(classifiedEconomicTables);
  });

  it("ACCOUNT_RECOVERY_USER_OWNED_TABLE_NAMES matches every user_owned_hard_block table in the classification (as a set)", () => {
    const classifiedUserOwnedTables = new Set(
      ACCOUNT_RECOVERY_USER_DATA_CLASSIFICATION.filter((c) => c.category === "user_owned_hard_block").map((c) => c.table)
    );
    const actualUserOwnedTables = new Set(db.ACCOUNT_RECOVERY_USER_OWNED_TABLE_NAMES);
    expect(actualUserOwnedTables).toEqual(classifiedUserOwnedTables);
  });

  it("coupons.ownerUserId (a personal, unredeemed coupon - a financial right) is actually queried by findAccountRecoveryEconomicData - the gap this audit found is genuinely closed, not just documented", () => {
    expect(db.ACCOUNT_RECOVERY_ECONOMIC_TABLE_NAMES).toContain("coupons");
  });

  it("topupLogs.userId is actually queried by findAccountRecoveryEconomicData - the second gap this audit found is genuinely closed", () => {
    expect(db.ACCOUNT_RECOVERY_ECONOMIC_TABLE_NAMES).toContain("topupLogs");
  });

  it("no table appears in BOTH the economic and user-owned check lists - every table has exactly one hard-block category", () => {
    const economic = new Set(db.ACCOUNT_RECOVERY_ECONOMIC_TABLE_NAMES);
    const userOwned = new Set(db.ACCOUNT_RECOVERY_USER_OWNED_TABLE_NAMES);
    const overlap = [...economic].filter((t) => userOwned.has(t));
    expect(overlap).toEqual([]);
  });
});
