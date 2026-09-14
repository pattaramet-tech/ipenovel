import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(process.cwd());
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("IPE-048 static safety contract", () => {
  it("keeps wallet mutation behind canonical wallet service primitive", () => {
    const service = read("server/services/adminGiftWalletAdjustmentService.ts");
    expect(service).toContain("adminWalletLedgerAdjustment");
    expect(service).not.toContain("tx.update(walletAccounts).set({ balance:");
  });

  it("requires preview balance, strong confirmation and no negative wallet", () => {
    const service = read("server/services/adminGiftWalletAdjustmentService.ts");
    expect(service).toContain("STALE_PREVIEW");
    expect(service).toContain("CONFIRM USER ${input.targetUserId}");
    expect(service).toContain("WALLET_CLAWBACK");
    expect(service).toContain("NEGATIVE_WALLET_UNSUPPORTED");
  });

  it("uses distinct admin-gift provenance and prevents fake paid purchase rows", () => {
    const service = read("server/services/adminGiftWalletAdjustmentService.ts");
    expect(service).toContain("adminGiftEntitlements");
    expect(service).not.toContain("insert(purchases).values");
    expect(service).not.toContain("insert(episodePurchases).values");
  });

it("wires admin route, navigation and forward migration 0045", () => {
  const app = read("client/src/App.tsx");
  const nav = read("client/src/config/adminNavItems.ts");
  const migration = read("drizzle/0045_admin_gift_wallet_adjustment.sql");
  expect(app).toContain("/admin/gift-wallet-adjustment");
  expect(nav).toContain("Gift / Wallet Adjustment");
  expect(migration).toContain("adminGiftWalletAdjustments");
  expect(migration).toContain("adminGiftEntitlements");
  expect(migration).toContain("idempotencyKey");
});

it("integrates gift access into reader and purchase prevention", () => {
  expect(read("server/services/readerService.ts")).toContain("adminGiftEntitlements");
  expect(read("server/services/episodePurchaseService.ts")).toContain("adminGiftEntitlements");
  expect(read("server/services/orderService.ts")).toContain("hasAdminGiftEntitlement");
  expect(read("server/services/entitlementLookupService.ts")).toContain('"admin_gift"');
});
});
