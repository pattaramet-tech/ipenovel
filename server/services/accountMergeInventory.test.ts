import { describe, expect, it } from "vitest";
import { getTableColumns, is } from "drizzle-orm";
import { MySqlTable } from "drizzle-orm/mysql-core";
import * as schema from "../../drizzle/schema";
import * as db from "../db";
import {
  ACCOUNT_MERGE_DIRECT_TABLES,
  ACCOUNT_MERGE_INDIRECT_TABLES,
  ACCOUNT_MERGE_EXCLUDED_INDIRECT_TABLES,
  ACCOUNT_MERGE_SINGLETON_TABLES,
} from "./accountMergeInventory";
import {
  ACCOUNT_RECOVERY_USER_DATA_CLASSIFICATION,
  ACCOUNT_RECOVERY_INDIRECT_TABLES,
} from "./accountRecoveryDataClassification";

/** Reflects over the REAL drizzle/schema.ts (never a hand-typed list) and
 *  returns every table export whose column set includes a column literally
 *  named `columnName`. */
function schemaTablesWithColumnNamed(columnName: string): string[] {
  const out: string[] = [];
  for (const [exportName, value] of Object.entries(schema)) {
    if (!is(value as any, MySqlTable)) continue;
    const cols = getTableColumns(value as any);
    if (Object.values(cols).some((c: any) => c.name === columnName)) out.push(exportName);
  }
  return out;
}

/** Same, for a table carrying a mysqlEnum column that includes `enumValue`
 *  among its allowed values - the marker for "this row is scoped to one
 *  order payment / wallet top-up", e.g. sourceType / subjectType. */
function schemaTablesWithEnumValue(enumValue: string): string[] {
  const out: string[] = [];
  for (const [exportName, value] of Object.entries(schema)) {
    if (!is(value as any, MySqlTable)) continue;
    const cols = getTableColumns(value as any);
    if (Object.values(cols).some((c: any) => Array.isArray(c.enumValues) && c.enumValues.includes(enumValue))) {
      out.push(exportName);
    }
  }
  return out;
}

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
    // Equality, not <=: `new Set(list).size === list.length` is FALSE iff the
    // list contains a duplicate. The old `toBeLessThanOrEqual` could never
    // fail - a set is never larger than the list it came from - so it proved
    // nothing.
    expect(new Set(ACCOUNT_MERGE_DIRECT_TABLES).size).toBe(ACCOUNT_MERGE_DIRECT_TABLES.length);
  });

  it("D. contains every ACCOUNT_RECOVERY_INDIRECT_TABLES entry (cartItems/orderItems/payments/orderHistory) exactly", () => {
    const expected = ACCOUNT_RECOVERY_INDIRECT_TABLES.map((e) => e.table);
    expect(ACCOUNT_MERGE_INDIRECT_TABLES).toEqual(expected);
  });

  it("D. orderHistory - a per-order audit table with NO direct user column - is in the indirect inventory (the P2-2 gap)", () => {
    expect(ACCOUNT_MERGE_INDIRECT_TABLES).toContain("orderHistory");
    expect(db.ACCOUNT_MERGE_TABLE_NAMES).toContain("orderHistory");
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

/**
 * The completeness audit for transitive (indirect) relations - the P2-2
 * blocker. These tests reflect over the REAL drizzle/schema.ts and check
 * each discovered child table against db.ts's REAL query registry
 * (db.ACCOUNT_MERGE_TABLE_NAMES) ∪ the explicit exclusion list. They
 * deliberately do NOT compare two lists both derived from the recovery
 * classification - schema discovery is the independent third source, so a
 * gap like "orderHistory was never inventoried" fails the suite rather than
 * hiding because both derived lists agreed with each other.
 */
describe("transitive-relation completeness - every order/cart-scoped child table is resolved", () => {
  // Discovered by reflection, not hand-typed: cartItems, couponUsages,
  // orderHistory, orderItems, payments, purchases.
  const orderOrCartScoped = [
    ...schemaTablesWithColumnNamed("orderId"),
    ...schemaTablesWithColumnNamed("cartId"),
  ];

  it("reflection found the expected order/cart-scoped tables (sanity - discovery is not silently empty)", () => {
    expect(orderOrCartScoped).toEqual(
      expect.arrayContaining(["cartItems", "orderItems", "payments", "orderHistory", "couponUsages", "purchases"])
    );
  });

  it("every order/cart-scoped table is either inventoried (real query registry) or explicitly excluded with a reason - never silently dropped", () => {
    const excludedNames = new Set(ACCOUNT_MERGE_EXCLUDED_INDIRECT_TABLES.map((e) => e.table));
    const unresolved = orderOrCartScoped.filter(
      (t) => !db.ACCOUNT_MERGE_TABLE_NAMES.includes(t) && !excludedNames.has(t)
    );
    expect(unresolved).toEqual([]);
  });

  it("orderHistory specifically resolves to INVENTORIED (its rows are the source's own order audit trail), not excluded", () => {
    expect(db.ACCOUNT_MERGE_TABLE_NAMES).toContain("orderHistory");
    expect(ACCOUNT_MERGE_EXCLUDED_INDIRECT_TABLES.map((e) => e.table)).not.toContain("orderHistory");
  });
});

describe("transitive-relation completeness - every order-payment/top-up-scoped evidence table is resolved", () => {
  // Discovered by reflection: ocrVerificationAttempts, paymentSlipClaims,
  // paymentSlipLegacyCollisions, paymentSlipLegacyUnknown,
  // paymentSlipReviewResolutions.
  const paymentScoped = schemaTablesWithEnumValue("order_payment");

  it("reflection found the expected payment/top-up-scoped tables (sanity)", () => {
    expect(paymentScoped).toEqual(
      expect.arrayContaining([
        "paymentSlipClaims",
        "paymentSlipLegacyCollisions",
        "paymentSlipLegacyUnknown",
        "ocrVerificationAttempts",
        "paymentSlipReviewResolutions",
      ])
    );
  });

  it("every payment/top-up-scoped table is either inventoried or explicitly excluded with a reason", () => {
    const excludedNames = new Set(ACCOUNT_MERGE_EXCLUDED_INDIRECT_TABLES.map((e) => e.table));
    const unresolved = paymentScoped.filter(
      (t) => !db.ACCOUNT_MERGE_TABLE_NAMES.includes(t) && !excludedNames.has(t)
    );
    expect(unresolved).toEqual([]);
  });

  it("all of them resolve to EXCLUDED - global anti-replay / OCR-diagnostic / admin-adjudication artifacts are never re-parented by a merge", () => {
    for (const t of paymentScoped) {
      expect(ACCOUNT_MERGE_EXCLUDED_INDIRECT_TABLES.map((e) => e.table)).toContain(t);
      expect(db.ACCOUNT_MERGE_TABLE_NAMES).not.toContain(t);
    }
  });
});

describe("ACCOUNT_MERGE_EXCLUDED_INDIRECT_TABLES is an explicit, reasoned list - never a silent catch-all", () => {
  it("every entry names a real, currently-existing schema table export", () => {
    const realTables = new Set(
      Object.entries(schema)
        .filter(([, v]) => is(v as any, MySqlTable))
        .map(([n]) => n)
    );
    for (const entry of ACCOUNT_MERGE_EXCLUDED_INDIRECT_TABLES) {
      expect(realTables.has(entry.table)).toBe(true);
    }
  });

  it("every entry has a non-empty via and a substantive reason (>= 20 chars)", () => {
    for (const entry of ACCOUNT_MERGE_EXCLUDED_INDIRECT_TABLES) {
      expect(entry.via.trim().length).toBeGreaterThan(0);
      expect(entry.reason.trim().length).toBeGreaterThanOrEqual(20);
    }
  });

  it("no table is BOTH inventoried and excluded - the two lists are disjoint", () => {
    const both = ACCOUNT_MERGE_EXCLUDED_INDIRECT_TABLES.map((e) => e.table).filter((t) =>
      db.ACCOUNT_MERGE_TABLE_NAMES.includes(t)
    );
    expect(both).toEqual([]);
  });

  it("no duplicate table names within the exclusion list", () => {
    const names = ACCOUNT_MERGE_EXCLUDED_INDIRECT_TABLES.map((e) => e.table);
    expect(new Set(names).size).toBe(names.length);
  });
});
