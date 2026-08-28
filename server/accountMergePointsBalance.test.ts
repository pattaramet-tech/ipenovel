import { describe, it, expect } from "vitest";
import { drizzle } from "drizzle-orm/mysql2";
import * as db from "./db";

/**
 * Connection-free unit proof that the Advanced Account Merge points-balance
 * read (getAccountMergePointsBalance) uses the CANONICAL production
 * chronology - `(createdAt DESC, id DESC)` - not `id DESC` alone.
 *
 * P2 review finding (PR #48, Codex thread r3880961888): sorting only by the
 * auto-increment id can select a different `balanceAfter` than the
 * production balance whenever points rows were imported/backfilled with a
 * `createdAt` that does not match insertion order. The fix delegates to
 * getUserPointsBalance, whose two-column ordering (and same-second id
 * tiebreak) is already locked by
 * server/daily-checkin-foundation.integration.test.ts.
 *
 * This test injects a fake query handle (`tx`) that records the exact
 * `.orderBy(...)` arguments the read builds, then renders them with the
 * real MySQL dialect. Before the fix the recorded ordering was a single
 * `` `id` desc `` term - this suite fails on that.
 */

const dialectDb = drizzle("mysql://user:pass@localhost:3306/db", { mode: "default" });

function renderSql(fragment: unknown): string {
  return (dialectDb as any).dialect.sqlToQuery(fragment).sql as string;
}

/** A minimal drizzle-select chain stand-in. Records the orderBy arguments
 *  and resolves the terminal `.limit()` to `rows`. */
function recordingTx(rows: Array<{ balanceAfter: string }>) {
  const recorded: { orderBy: unknown[] } = { orderBy: [] };
  const chain: any = {
    select() { return chain; },
    from() { return chain; },
    where() { return chain; },
    orderBy(...args: unknown[]) { recorded.orderBy = args; return chain; },
    limit() { return Promise.resolve(rows); },
  };
  return { chain, recorded };
}

describe("getAccountMergePointsBalance - canonical points-ledger chronology", () => {
  it("orders by BOTH createdAt DESC and id DESC (not id alone)", async () => {
    const { chain, recorded } = recordingTx([{ balanceAfter: "42.00" }]);

    const balance = await db.getAccountMergePointsBalance(123, chain);

    expect(balance).toBe("42.00");
    expect(recorded.orderBy).toHaveLength(2);
    const rendered = recorded.orderBy.map(renderSql).join(" | ");
    expect(rendered).toContain("`createdAt` desc");
    expect(rendered).toContain("`id` desc");
    // createdAt must be the PRIMARY sort key; id is only the tiebreak.
    expect(rendered.indexOf("`createdAt` desc")).toBeLessThan(rendered.indexOf("`id` desc"));
  });

  it("returns the most-recent row's balanceAfter as a string", async () => {
    const { chain } = recordingTx([{ balanceAfter: "1350.75" }]);
    expect(await db.getAccountMergePointsBalance(7, chain)).toBe("1350.75");
  });

  it("returns \"0.00\" (never null/undefined) when the account has no points transactions", async () => {
    const { chain } = recordingTx([]);
    expect(await db.getAccountMergePointsBalance(7, chain)).toBe("0.00");
  });
});
