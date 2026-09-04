import { describe, expect, it } from "vitest";
import {
  findPaymentV2FoundationDataMismatches,
  reconcilePaymentV2FoundationData,
} from "../scripts/migrate.mjs";

describe("IPE-022 Payment V2 foundation startup readiness", () => {
  it("reconciles under the legacy users -> pointsAccounts lock order in one transaction", async () => {
    const statements: string[] = [];
    const conn = {
      query: async (sql: string) => {
        statements.push(sql);
        return [[], []];
      },
    };

    await reconcilePaymentV2FoundationData(conn);

    expect(statements[0]).toBe("START TRANSACTION");
    expect(statements[1]).toContain("FROM users ORDER BY id FOR UPDATE");
    expect(statements[2]).toContain("INSERT IGNORE INTO accountMutationGuards");
    expect(statements[3]).toContain("INSERT IGNORE INTO pointsAccounts");
    expect(statements[3]).toContain("ORDER BY pt.createdAt DESC, pt.id DESC");
    expect(statements[4]).toContain("FROM pointsAccounts ORDER BY userId FOR UPDATE");
    expect(statements[5]).toContain("UPDATE pointsAccounts");
    expect(statements[5]).toContain("pa.version = pa.version + 1");
    expect(statements[6]).toBe("COMMIT");
  });

  it("reports each missing-row/state/balance class with an exact count", async () => {
    const counts = [2, 1, 3, 4];
    const conn = {
      query: async () => [[{ mismatchCount: counts.shift() }]],
    };

    expect(await findPaymentV2FoundationDataMismatches(conn)).toEqual([
      "accountMutationGuards missing rows=2",
      "accountMutationGuards state mismatches=1",
      "pointsAccounts missing rows=3",
      "pointsAccounts latest-ledger balance mismatches=4",
    ]);
  });

  it("returns ready only when every read-only mismatch count is zero", async () => {
    const conn = {
      query: async () => [[{ mismatchCount: 0 }]],
    };
    expect(await findPaymentV2FoundationDataMismatches(conn)).toEqual([]);
  });
});
