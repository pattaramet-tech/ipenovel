import { describe, expect, it } from "vitest";
import {
  ACCOUNT_MERGE_DIRECT_TABLES,
  ACCOUNT_MERGE_INDIRECT_TABLES,
} from "./accountMergeInventory";
import {
  IPE007_FINANCIAL_HISTORY_TABLES,
  IPE007_HANDLED_DIRECT_TABLES,
  IPE007_HANDLED_INDIRECT_TABLES,
  IPE007_PRESERVED_VIA_ORDER_TABLES,
} from "./accountMergeDataReconciliationService";

function sorted(values: readonly string[]) {
  return [...values].sort();
}

describe("IPE-007 executable scope stays aligned with the reflected Account Merge inventory", () => {
  it("partitions every direct table exactly once between IPE-007 and immutable IPE-006 financial history", () => {
    const handled = [
      ...IPE007_HANDLED_DIRECT_TABLES,
      ...IPE007_FINANCIAL_HISTORY_TABLES,
    ];
    expect(new Set(handled).size).toBe(handled.length);
    expect(sorted(handled)).toEqual(sorted(ACCOUNT_MERGE_DIRECT_TABLES));
  });

  it("partitions every indirect table exactly once between explicit cart handling and order-child preservation", () => {
    const handled = [
      ...IPE007_HANDLED_INDIRECT_TABLES,
      ...IPE007_PRESERVED_VIA_ORDER_TABLES,
    ];
    expect(new Set(handled).size).toBe(handled.length);
    expect(sorted(handled)).toEqual(sorted(ACCOUNT_MERGE_INDIRECT_TABLES));
  });

  it("never assigns Wallet/Points/history tables to the Phase-4 writer", () => {
    for (const table of IPE007_FINANCIAL_HISTORY_TABLES) {
      expect(IPE007_HANDLED_DIRECT_TABLES).not.toContain(table as any);
    }
  });
});
