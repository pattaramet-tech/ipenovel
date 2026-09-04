import { describe, it, expect } from "vitest";
import * as db from "./db";

/**
 * Connection-free proof that Account Merge reads the authoritative
 * pointsAccounts row introduced by migration 0046, with the temporary
 * rolling-deploy ledger fallback required while old instances can still
 * append ledger-only writes.
 */

/** A minimal drizzle-select chain stand-in. Records the selected projection
 * and source table, then resolves the terminal `.limit()` to `rows`. */
function recordingTx(resultSets: Array<Array<{ balance?: string; id?: number }>>) {
  const recorded: { projections: unknown[]; tables: unknown[] } = { projections: [], tables: [] };
  let rows: Array<{ balance?: string; id?: number }> = [];
  const chain: any = {
    select(projection: unknown) {
      recorded.projections.push(projection);
      rows = resultSets[recorded.projections.length - 1] ?? [];
      return chain;
    },
    from(table: unknown) { recorded.tables.push(table); return chain; },
    where() { return chain; },
    orderBy() { return chain; },
    limit() { return Promise.resolve(rows); },
  };
  return { chain, recorded };
}

describe("getAccountMergePointsBalance - authoritative points account", () => {
  it("reads the dedicated pointsAccounts balance rather than rescanning ledger chronology", async () => {
    const { chain, recorded } = recordingTx([[{ balance: "42.00" }]]);

    const balance = await db.getAccountMergePointsBalance(123, chain);

    expect(balance).toBe("42.00");
    expect(String((recorded.tables[0] as any)?.[Symbol.for("drizzle:Name")])).toBe("pointsAccounts");
    expect(Object.keys(recorded.projections[0] as object)).toEqual(["balance"]);
  });

  it("returns the current authoritative balance as a string", async () => {
    const { chain } = recordingTx([[{ balance: "1350.75" }]]);
    expect(await db.getAccountMergePointsBalance(7, chain)).toBe("1350.75");
  });

  it("prefers a newer legacy ledger balance during the mixed-version bridge", async () => {
    const { chain } = recordingTx([[{ balance: "10.00" }], [{ balanceAfter: "17.00" } as any]]);
    expect(await db.getAccountMergePointsBalance(7, chain)).toBe("17.00");
  });

  it("returns \"0.00\" for an unknown user with no points account", async () => {
    const { chain } = recordingTx([[], []]);
    expect(await db.getAccountMergePointsBalance(7, chain)).toBe("0.00");
  });
});
