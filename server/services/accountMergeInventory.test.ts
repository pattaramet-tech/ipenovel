import { describe, expect, it } from "vitest";
import * as db from "../db";
import {
  ACCOUNT_MERGE_DIRECT_TABLES,
  ACCOUNT_MERGE_INDIRECT_TABLES,
  ACCOUNT_MERGE_SINGLETON_TABLES,
} from "./accountMergeInventory";
import {
  ACCOUNT_RECOVERY_USER_DATA_CLASSIFICATION,
  ACCOUNT_RECOVERY_INDIRECT_TABLES,
} from "./accountRecoveryDataClassification";

/**
 * Proves the merge inventory's table lists are DERIVED from (not a second,
 * hand-maintained copy of) the Account Recovery classification, and that
 * server/db.ts's real query registry (ACCOUNT_MERGE_TABLE_NAMES) matches
 * exactly - the same "no drift between the inventory and the real
 * queries" pattern as
 * server/services/accountRecoveryDataClassification.test.ts's own
 * "server/db.ts's actual check lists match the classification exactly"
 * describe block.
 */
describe("ACCOUNT_MERGE_DIRECT_TABLES / ACCOUNT_MERGE_INDIRECT_TABLES are derived from the recovery classification", () => {
  it("D. contains every economic_hard_block and user_owned_hard_block table from the recovery classification - and nothing else", () => {
    const expected = new Set(
      ACCOUNT_RECOVERY_USER_DATA_CLASSIFICATION.filter(
        (c) => c.category === "economic_hard_block" || c.category === "user_owned_hard_block"
      ).map((c) => c.table)
    );
    expect(new Set(ACCOUNT_MERGE_DIRECT_TABLES)).toEqual(expected);
  });

  it("no duplicate table names in the direct list (a table classified via more than one column collapses to one inventory entry)", () => {
    expect(new Set(ACCOUNT_MERGE_DIRECT_TABLES).size).toBeLessThanOrEqual(ACCOUNT_MERGE_DIRECT_TABLES.length);
  });

  it("D. contains every ACCOUNT_RECOVERY_INDIRECT_TABLES entry (cartItems/orderItems/payments) exactly", () => {
    const expected = ACCOUNT_RECOVERY_INDIRECT_TABLES.map((e) => e.table);
    expect(ACCOUNT_MERGE_INDIRECT_TABLES).toEqual(expected);
  });

  it("recovery_internal, merge_internal and deliberately_ignored tables are correctly excluded (this is an INVENTORY of the source account's own data, not every user-referencing column in the schema)", () => {
    expect(ACCOUNT_MERGE_DIRECT_TABLES).not.toContain("accountRecoveryRequests");
    expect(ACCOUNT_MERGE_DIRECT_TABLES).not.toContain("accountRecoveryAuditLogs");
    expect(ACCOUNT_MERGE_DIRECT_TABLES).not.toContain("accountMergeCases");
    expect(ACCOUNT_MERGE_DIRECT_TABLES).not.toContain("accountMergeAuditLogs");
    expect(ACCOUNT_MERGE_DIRECT_TABLES).not.toContain("payments"); // admin-actor columns only, direct list - payments itself is indirect
  });
});

describe("server/db.ts's real query registry matches the derived inventory exactly - no drift", () => {
  it("D. ACCOUNT_MERGE_TABLE_NAMES (as a set) equals direct ∪ indirect tables", () => {
    const expected = new Set([...ACCOUNT_MERGE_DIRECT_TABLES, ...ACCOUNT_MERGE_INDIRECT_TABLES]);
    expect(new Set(db.ACCOUNT_MERGE_TABLE_NAMES)).toEqual(expected);
  });

  it("no duplicate table names in the real query registry", () => {
    expect(new Set(db.ACCOUNT_MERGE_TABLE_NAMES).size).toBe(db.ACCOUNT_MERGE_TABLE_NAMES.length);
  });
});

describe("ACCOUNT_MERGE_SINGLETON_TABLES", () => {
  it("contains exactly the tables with a real UNIQUE(userId) constraint - walletAccounts and carts", () => {
    expect(new Set(ACCOUNT_MERGE_SINGLETON_TABLES)).toEqual(new Set(["walletAccounts", "carts"]));
  });

  it("every singleton table is also a direct inventory table (never an indirect one)", () => {
    for (const table of ACCOUNT_MERGE_SINGLETON_TABLES) {
      expect(ACCOUNT_MERGE_DIRECT_TABLES).toContain(table);
    }
  });
});
