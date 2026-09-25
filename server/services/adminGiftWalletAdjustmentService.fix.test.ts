import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  AdminGiftWalletAdjustmentError,
  assertIdempotentReplayMatches,
  classifyGiftScope,
} from "./adminGiftWalletAdjustmentService";

const root = resolve(process.cwd());
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("IPE-048 C02 fix contract", () => {
  const priorCredit = {
    action: "WALLET_CREDIT",
    targetUserId: 42,
    amount: "10.00",
    novelId: null,
    linkedOriginalAdjustmentId: null,
  };

  it("allows normalized same-request idempotent replay", () => {
    expect(assertIdempotentReplayMatches(priorCredit, {
      action: "WALLET_CREDIT", targetUserId: 42, amount: "10",
    })).toBe(priorCredit);
  });
  it.each([
    [{ action: "WALLET_CREDIT", targetUserId: 99, amount: "10" }],
    [{ action: "WALLET_CLAWBACK", targetUserId: 42, amount: "10" }],
    [{ action: "WALLET_CREDIT", targetUserId: 42, amount: "11" }],
    [{ action: "WALLET_CREDIT", targetUserId: 42, amount: "10", novelId: 7 }],
    [{ action: "WALLET_CREDIT", targetUserId: 42, amount: "10", linkedOriginalAdjustmentId: 9 }],
  ])("fails closed when an idempotency key is reused for a different payload", (input) => {
    expect(() => assertIdempotentReplayMatches(priorCredit, input as any))
      .toThrowError(AdminGiftWalletAdjustmentError);
  });

  it("uses one gift-scope classifier for exact grantable and skipped episodes", () => {
    const result = classifyGiftScope(
      [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
      [{ episodeId: 1 }],
      [{ episodeId: 2 }],
      [{ episodeId: 3 }]
    );
    expect(result.grantable.map(e => e.id)).toEqual([4]);
    expect(result.skipped.map(e => e.id)).toEqual([1, 2, 3]);
  });

  it("keeps duplicate-key race recovery payload-bound", () => {
    const source = read("server/services/adminGiftWalletAdjustmentService.ts");
    expect(source).toContain("isDuplicateKeyError(error)");
    expect(source.match(/assertIdempotentReplayMatches\(replay, input\)/g)).toHaveLength(1);
  });
  it("includes gifted-only and mixed provenance in myLibrary", () => {
    const routers = read("server/routers.ts");
    expect(routers).toContain("adminGiftEntitlements: s.adminGiftEntitlements");
    expect(routers).toContain('entitlementSource: purchase ? "wallet" as const : "admin_gift" as const');
    expect(routers).toContain("pricePaid: purchase?.pricePaid ?? null");
  });

  it("preserves the baht symbol in order-service user messages", () => {
    const orderService = read("server/services/orderService.ts");
    expect(orderService).toContain("฿${minPurchase.toFixed(2)}");
    expect(orderService).toContain('"5% off, capped at');
    expect(orderService).not.toContain("เธฟ");
  });

  it("keeps migrations 0040-0045 contiguous and journal/file aligned", () => {
    const journal = JSON.parse(read("drizzle/meta/_journal.json"));
    const tail = journal.entries.filter((entry: any) => entry.idx >= 40 && entry.idx <= 45);
    expect(tail.map((entry: any) => entry.idx)).toEqual([40, 41, 42, 43, 44, 45]);
    expect(tail.at(-1)?.tag).toBe("0045_admin_gift_wallet_adjustment");
    for (const entry of tail) {
      expect(existsSync(resolve(root, "drizzle", `${entry.tag}.sql`))).toBe(true);
    }
  });
  it("keeps 0045 snapshot as the canonical post-IPE-048 generation baseline", () => {
    const prev = JSON.parse(read("drizzle/meta/0044_snapshot.json"));
    const current = JSON.parse(read("drizzle/meta/0045_snapshot.json"));
    expect(current.version).toBe("5");
    expect(current.dialect).toBe("mysql");
    expect(current.prevId).toBe(prev.id);
    expect(current.tables.adminGiftWalletAdjustments).toBeDefined();
    expect(current.tables.adminGiftEntitlements).toBeDefined();
    expect(current.tables.workspacePublishOwnershipTransitions).toEqual(prev.tables.workspacePublishOwnershipTransitions);
  });

});
