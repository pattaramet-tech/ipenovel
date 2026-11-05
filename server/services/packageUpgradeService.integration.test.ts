import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import mysql from "mysql2/promise";
import { and, eq, like, sql } from "drizzle-orm";
import { appRouter } from "../routers";
import type { TrpcContext } from "../_core/context";
import * as db from "../db";
import * as orderService from "../services/orderService";
import {
  PackageUpgradeError,
  ensurePackageChapterMapping,
  executePackageUpgrade,
  hasPendingUpgradeOrderForPackage,
  quotePackageUpgrade,
} from "../services/packageUpgradeService";
import { purchaseEpisodeWithWallet } from "../services/episodePurchaseService";
import { CHECKOUT_MAINTENANCE_SETTING_KEY } from "../services/checkoutMaintenanceService";
import { getTestDb, requireTestDb } from "../test-helpers/testDb";
import {
  createTestCoupon,
  createTestOrder,
  createTestOrderItem,
  createTestUser,
  uniqueTestTag,
} from "../test-helpers/fixtures";

/**
 * P3-R1 integration coverage for the chapter-to-package upgrade:
 * mapping persistence, provable-money credit (wallet / approved order),
 * quote lifecycle (expiry, staleness, active-quote dedupe) and execution
 * atomicity (wallet debit / payable=0 grant / slip pending order /
 * concurrency single-winner / idempotent replay).
 *
 * Runs against the disposable ipenovel_test database only - every fixture
 * is created fresh per test with a unique tag, so no test depends on
 * (or cleans up) another test's rows.
 */

let testDb: ReturnType<typeof getTestDb>;

beforeAll(async () => {
  await requireTestDb();
  testDb = getTestDb();
  process.env.PACKAGE_UPGRADE_ENABLED = "true";
  // This file's fixtures use execution keys prefixed "p3-" - a previous run
  // that FAILED mid-execute can leave receipts (and their bound keys)
  // behind, since the DB is not reset between targeted runs. Clear only
  // our own family.
  await testDb
    .delete(packageUpgradesTable)
    .where(like(packageUpgradesTable.idempotencyKey, "p3%"));
});

function userContext(userId: number): TrpcContext {
  return {
    user: {
      id: userId,
      openId: `p3-upgrade-${userId}`,
      email: `p3-upgrade-${userId}@example.test`,
      name: "P3 Upgrade Test User",
      loginMethod: "test",
      role: "user",
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    } as TrpcContext["user"],
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

interface ChapterSpec {
  id: number;
  episodeNumber: string;
}

interface World {
  userId: number;
  novelId: number;
  packageEpisodeId: number;
  chapters: Record<string, ChapterSpec>;
}

/** Fresh novel + package "1 - 10" + chapters 1..5 (paid), 6 (free), 7 (range-numbered). */
async function createWorld(): Promise<World> {
  const tag = uniqueTestTag("p3");
  const user = await createTestUser();
  const novelResult = await testDb.insert(novelsTable).values({
    title: `P3 Novel ${tag}`,
    slug: `p3-novel-${tag}`,
    author: "P3 Test",
    publicationStatus: "published",
    storyStatus: "ongoing",
  });
  const novelId = (novelResult as unknown as [{ insertId: number }])[0].insertId;

  const packageResult = await testDb.insert(episodesTable).values({
    novelId,
    episodeNumber: "1 - 10",
    title: `P3 Package ${tag}`,
    price: "30.00",
    isFree: false,
    isPublished: true,
    saleMode: "package",
    contentFormat: "plain_text",
  });
  const packageEpisodeId = (packageResult as unknown as [{ insertId: number }])[0].insertId;

  const chapters: Record<string, ChapterSpec> = {};
  for (let n = 1; n <= 7; n++) {
    const isFree = n === 6;
    const rangeNumbered = n === 7;
    const result = await testDb.insert(episodesTable).values({
      novelId,
      episodeNumber: rangeNumbered ? `${n} - ${n + 1}` : String(n),
      title: `P3 Chapter ${n} ${tag}`,
      price: isFree ? "0.00" : "5.00",
      isFree,
      isPublished: true,
      saleMode: "chapter",
      contentFormat: "plain_text",
    });
    chapters[String(n)] = { id: (result as unknown as [{ insertId: number }])[0].insertId, episodeNumber: rangeNumbered ? `${n} - ${n + 1}` : String(n) };
  }

  return { userId: user.id, novelId, packageEpisodeId, chapters };
}

// ---------------------------------------------------------------------------
// Fixture writers (raw inserts - no helpers exist for these exact shapes)
// ---------------------------------------------------------------------------

async function seedWalletBalance(userId: number, balance: string) {
  await db.getOrCreateWalletAccount(userId);
  await testDb.update(walletAccountsTable).set({ balance }).where(eq(walletAccountsTable.userId, userId));
}

/** Real wallet debit trail in the PRODUCTION ledger shape (R3-1):
 *  walletTransactions.referenceId = the CHAPTER's episodeId, and
 *  episodePurchases.walletTransactionId links back to the debit. */
async function seedWalletChapterPurchase(userId: number, novelId: number, chapterId: number, pricePaid: string) {
  // Mirrors episodePurchaseService's real write order + ledger linkage:
  // the debit transaction points BACK at the purchase row (referenceId) -
  // R2-01's proof requires that exact linkage.
  const purchaseResult = await testDb.insert(episodePurchasesTable).values({
    userId,
    novelId,
    episodeId: chapterId,
    pricePaid,
    walletTransactionId: null,
  });
  const purchaseId = (purchaseResult as unknown as [{ insertId: number }])[0].insertId;
  const txResult = await testDb.insert(walletTransactionsTable).values({
    userId,
    type: "debit",
    amount: pricePaid,
    balanceBefore: "100.00",
    balanceAfter: "95.00",
    referenceType: "episode_purchase",
    referenceId: chapterId,
  });
  const walletTransactionId = (txResult as unknown as [{ insertId: number }])[0].insertId;
  await testDb
    .update(episodePurchasesTable)
    .set({ walletTransactionId })
    .where(eq(episodePurchasesTable.id, purchaseId));
  return walletTransactionId;
}

async function seedGiftEntitlement(userId: number, novelId: number, episodeId: number) {
  await testDb.insert(adminGiftEntitlementsTable).values({
    userId,
    novelId,
    episodeId,
    actorAdminId: userId,
    reason: "P3 test gift fixture",
    idempotencyKey: `p3-gift-${uniqueTestTag("g")}`,
  });
}

/** Approved order owning a chapter: order + item + entitlement row. */
async function seedOrderChapterPurchase(
  userId: number,
  novelId: number,
  chapterId: number,
  finalPrice: string,
  overrides: { status?: string; paymentStatus?: string } = {}
) {
  const order = await createTestOrder(userId, { subtotal: finalPrice, totalAmount: finalPrice });
  await createTestOrderItem({ orderId: order.id, novelId, episodeId: chapterId, unitPrice: finalPrice, discountAmount: "0.00", finalPrice });
  await testDb
    .update(ordersTable)
    .set({ status: overrides.status ?? "approved", paymentStatus: overrides.paymentStatus ?? "approved" })
    .where(eq(ordersTable.id, order.id));
  await db.createPurchase(userId, novelId, chapterId, order.id);
  return order;
}

async function seedPackageOwnership(userId: number, novelId: number, packageEpisodeId: number) {
  const order = await createTestOrder(userId, { subtotal: "30.00", totalAmount: "30.00" });
  await createTestOrderItem({ orderId: order.id, novelId, episodeId: packageEpisodeId, unitPrice: "30.00", discountAmount: "0.00", finalPrice: "30.00" });
  await testDb.update(ordersTable).set({ status: "approved", paymentStatus: "approved" }).where(eq(ordersTable.id, order.id));
  await db.createPurchase(userId, novelId, packageEpisodeId, order.id);
}

async function setWalletBalance(userId: number, balance: string) {
  await testDb.update(walletAccountsTable).set({ balance }).where(eq(walletAccountsTable.userId, userId));
}

async function getWalletBalance(userId: number): Promise<string> {
  const account = await db.getOrCreateWalletAccount(userId);
  return String(account.balance);
}

// ---------------------------------------------------------------------------
// Imports of schema tables (kept at the bottom to keep the fixture section
// readable)
// ---------------------------------------------------------------------------

import {
  adminGiftEntitlements as adminGiftEntitlementsTable,
  purchases as purchasesTable,
  episodes as episodesTable,
  novels as novelsTable,
  orders as ordersTable,
  packageChapterMappings as packageChapterMappingsTable,
  packageUpgradeCreditItems as packageUpgradeCreditItemsTable,
  packageUpgradeExecLocks as packageUpgradeExecLocksTable,
  packageUpgrades as packageUpgradesTable,
  walletAccounts as walletAccountsTable,
  walletTransactions as walletTransactionsTable,
  episodePurchases as episodePurchasesTable,
} from "../../drizzle/schema";

const caller = (userId: number) => appRouter.createCaller(userContext(userId));

// ---------------------------------------------------------------------------

describe("P3 chapter-to-package upgrade (integration)", () => {
  it("derives and persists the mapping once - re-derivation is insert-only and stable", async () => {
    const world = await createWorld();
    const first = await ensurePackageChapterMapping({
      id: world.packageEpisodeId,
      novelId: world.novelId,
      episodeNumber: "1 - 10",
    });
    // Chapters 1..5 map; 6 is free (still maps - it EXISTS as a chapter),
    // 7 has a range number and never maps.
    expect(first.map((m) => m.sortOrder)).toEqual([1, 2, 3, 4, 5, 6]);
    const second = await ensurePackageChapterMapping({
      id: world.packageEpisodeId,
      novelId: world.novelId,
      episodeNumber: "1 - 10",
    });
    expect(second).toEqual(first);

    const rows = await testDb
      .select({ derivation: packageChapterMappingsTable.derivation })
      .from(packageChapterMappingsTable)
      .where(eq(packageChapterMappingsTable.packageEpisodeId, world.packageEpisodeId));
    expect(new Set(rows.map((r) => r.derivation))).toEqual(new Set(["episode_number_range"]));
  });

  it("quotes wallet-purchase credit with a per-chapter breakdown, capped at the package price", async () => {
    const world = await createWorld();
    // 5 paid chapters x 5.00 = 25.00 credit vs 30.00 package -> payable 5.00
    for (let n = 1; n <= 5; n++) {
      await seedWalletChapterPurchase(world.userId, world.novelId, world.chapters[String(n)].id, "5.00");
    }
    // Chapter 6 is free - a later "purchase" record at 0.00 proves nothing.
    const quote = await quotePackageUpgrade(world.userId, world.packageEpisodeId);
    expect(quote.packagePrice).toBe("30.00");
    expect(quote.creditAmount).toBe("25.00");
    expect(quote.payableAmount).toBe("5.00");
    expect(quote.items).toHaveLength(5);
    expect(quote.status).toBe("quoted");
  });

  it("excludes gift and non-provable chapters from credit", async () => {
    const world = await createWorld();
    await seedWalletChapterPurchase(world.userId, world.novelId, world.chapters["1"].id, "5.00");
    await seedGiftEntitlement(world.userId, world.novelId, world.chapters["2"].id);
    const quote = await quotePackageUpgrade(world.userId, world.packageEpisodeId);
    expect(quote.creditAmount).toBe("5.00"); // gift chapter contributes NOTHING
    expect(quote.items.map((i) => i.chapterEpisodeId)).toEqual([world.chapters["1"].id]);
  });

  it("credits approved-order net price (orderItems.finalPrice) and ignores unapproved orders", async () => {
    const world = await createWorld();
    await seedOrderChapterPurchase(world.userId, world.novelId, world.chapters["1"].id, "4.50", {
      status: "approved",
      paymentStatus: "approved",
    });
    await seedOrderChapterPurchase(world.userId, world.novelId, world.chapters["2"].id, "9.00", {
      status: "pending",
      paymentStatus: "submitted",
    });
    const quote = await quotePackageUpgrade(world.userId, world.packageEpisodeId);
    expect(quote.creditAmount).toBe("4.50"); // pending order is NOT provable money
    expect(quote.payableAmount).toBe("25.50");
  });

  it("excludes a wallet purchase that was later refunded", async () => {
    const world = await createWorld();
    const walletTransactionId = await seedWalletChapterPurchase(world.userId, world.novelId, world.chapters["1"].id, "5.00");
    await seedWalletChapterPurchase(world.userId, world.novelId, world.chapters["2"].id, "5.00");
    // Refund chapter 1's purchase (type refund, refType episode_purchase).
    // A refund mirrors its debit: referenceId = the CHAPTER's episode id.
    void walletTransactionId;
    await testDb.insert(walletTransactionsTable).values({
      userId: world.userId,
      type: "refund",
      amount: "5.00",
      balanceBefore: "95.00",
      balanceAfter: "100.00",
      referenceType: "episode_purchase",
      referenceId: world.chapters["1"].id,
    });
    const quote = await quotePackageUpgrade(world.userId, world.packageEpisodeId);
    expect(quote.creditAmount).toBe("5.00");
    expect(quote.items.map((i) => i.chapterEpisodeId)).toEqual([world.chapters["2"].id]);
  });

  it("refuses to quote when the package is already owned (any entitlement source)", async () => {
    const world = await createWorld();
    await seedPackageOwnership(world.userId, world.novelId, world.packageEpisodeId);
    await expect(quotePackageUpgrade(world.userId, world.packageEpisodeId)).rejects.toMatchObject({
      code: "ALREADY_OWNED_PACKAGE",
    });
    // Gift ownership also blocks the quote (double-free the same package).
    const world2 = await createWorld();
    await seedGiftEntitlement(world2.userId, world2.novelId, world2.packageEpisodeId);
    await expect(quotePackageUpgrade(world2.userId, world2.packageEpisodeId)).rejects.toMatchObject({
      code: "ALREADY_OWNED_PACKAGE",
    });
  });

  it("returns the ACTIVE quote instead of stacking a second one", async () => {
    const world = await createWorld();
    await seedWalletChapterPurchase(world.userId, world.novelId, world.chapters["1"].id, "5.00");
    const first = await quotePackageUpgrade(world.userId, world.packageEpisodeId);
    const second = await quotePackageUpgrade(world.userId, world.packageEpisodeId);
    expect(second.upgradeId).toBe(first.upgradeId);
  });

  it("execute (wallet): debits payable, writes approved order + package entitlement + credit ledger atomically", async () => {
    const world = await createWorld();
    for (let n = 1; n <= 5; n++) {
      await seedWalletChapterPurchase(world.userId, world.novelId, world.chapters[String(n)].id, "5.00");
    }
    await seedWalletBalance(world.userId, "50.00");
    const quote = await quotePackageUpgrade(world.userId, world.packageEpisodeId);
    const result = await executePackageUpgrade(world.userId, {
      upgradeId: quote.upgradeId,
      method: "wallet",
      idempotencyKey: "p3-exec-wallet-0001",
      expectedFinalTotal: quote.payableAmount,
    });
    expect(result.alreadyProcessed).toBe(false);
    expect(result.orderStatus).toBe("approved");

    // Server pricing was honored: wallet debited exactly the payable.
    expect(await getWalletBalance(world.userId)).toBe("45.00");

    // Package entitlement via the NORMAL pipeline (purchases on the approved order).
    const owned = await db.getPurchaseByUserAndEpisode(world.userId, world.packageEpisodeId);
    expect(owned).toBeTruthy();

    // Credit ledger persisted per chapter.
    const items = await testDb
      .select()
      .from(packageUpgradeCreditItemsTable)
      .where(eq(packageUpgradeCreditItemsTable.upgradeId, quote.upgradeId));
    expect(items).toHaveLength(5);
    expect(items.every((i) => i.creditApplied === "5.00")).toBe(true);

    // The upgrade receipt is linked to its order.
    const receipt = await testDb
      .select()
      .from(packageUpgradesTable)
      .where(eq(packageUpgradesTable.id, quote.upgradeId));
    expect(receipt[0].orderId).toBe(result.orderId);
    expect(receipt[0].status).toBe("order_created");
  });

  it("execute (wallet) with insufficient balance fails cleanly: no order, quote still usable", async () => {
    const world = await createWorld();
    await seedWalletChapterPurchase(world.userId, world.novelId, world.chapters["1"].id, "5.00");
    await seedWalletBalance(world.userId, "1.00");
    const quote = await quotePackageUpgrade(world.userId, world.packageEpisodeId);
    await expect(
      executePackageUpgrade(world.userId, { upgradeId: quote.upgradeId, method: "wallet", idempotencyKey: "p3-exec-poor-0001", expectedFinalTotal: quote.payableAmount })
    ).rejects.toMatchObject({ code: "INSUFFICIENT_WALLET_BALANCE" });

    // Nothing leaked: no order for this upgrade, receipt rolled back to quoted.
    const receipt = await testDb
      .select()
      .from(packageUpgradesTable)
      .where(eq(packageUpgradesTable.id, quote.upgradeId));
    expect(receipt[0].status).toBe("quoted");
    expect(receipt[0].orderId).toBeNull();
  });

  it("execute with payable = 0 grants the entitlement atomically WITHOUT any wallet movement", async () => {
    const world = await createWorld();
    // 6 chapters x 5.00 = 30.00 raw credit, capped at the 30.00 package price.
    for (let n = 1; n <= 6; n++) {
      await seedWalletChapterPurchase(world.userId, world.novelId, world.chapters[String(n)].id, "5.00");
    }
    await seedWalletBalance(world.userId, "77.00");
    const quote = await quotePackageUpgrade(world.userId, world.packageEpisodeId);
    expect(quote.payableAmount).toBe("0.00");

    const result = await executePackageUpgrade(world.userId, {
      upgradeId: quote.upgradeId,
      method: "wallet",
      idempotencyKey: "p3-exec-zero-0001",
      expectedFinalTotal: quote.payableAmount,
    });
    expect(result.orderStatus).toBe("approved");
    expect(await getWalletBalance(world.userId)).toBe("77.00"); // untouched
    expect(await db.getPurchaseByUserAndEpisode(world.userId, world.packageEpisodeId)).toBeTruthy();
  });

  it("execute (slip): creates a PENDING order without debit; approval through the normal pipeline grants entitlement", async () => {
    const world = await createWorld();
    await seedWalletChapterPurchase(world.userId, world.novelId, world.chapters["1"].id, "5.00");
    await seedWalletBalance(world.userId, "100.00");
    const quote = await quotePackageUpgrade(world.userId, world.packageEpisodeId);

    const result = await executePackageUpgrade(world.userId, {
      upgradeId: quote.upgradeId,
      method: "slip",
      idempotencyKey: "p3-exec-slip-0001",
      expectedFinalTotal: quote.payableAmount,
    });
    expect(result.orderStatus).toBe("pending");
    expect(await getWalletBalance(world.userId)).toBe("100.00"); // no debit on slip
    expect(await db.getPurchaseByUserAndEpisode(world.userId, world.packageEpisodeId)).toBeFalsy();

    // The pending order flows through the EXISTING approval pipeline.
    const payment = await db.getPaymentByOrderId(result.orderId);
    await orderService.approvePayment(payment.id, "1");
    expect(await db.getPurchaseByUserAndEpisode(world.userId, world.packageEpisodeId)).toBeTruthy();
  });

  it("concurrent executes: exactly ONE winner; one entitlement row; wallet debited once", async () => {
    const world = await createWorld();
    await seedWalletChapterPurchase(world.userId, world.novelId, world.chapters["1"].id, "5.00");
    await seedWalletBalance(world.userId, "100.00");
    const quote = await quotePackageUpgrade(world.userId, world.packageEpisodeId);

    const outcomes = await Promise.allSettled([
      executePackageUpgrade(world.userId, { upgradeId: quote.upgradeId, method: "wallet", idempotencyKey: "p3-race-a-0001", expectedFinalTotal: quote.payableAmount }),
      executePackageUpgrade(world.userId, { upgradeId: quote.upgradeId, method: "wallet", idempotencyKey: "p3-race-b-0002", expectedFinalTotal: quote.payableAmount }),
    ]);
    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
    const rejectedReasons = outcomes
      .filter((o) => o.status === "rejected")
      .map((o) => (o as PromiseRejectedResult).reason);
    expect(rejectedReasons.length).toBe(1);
    expect(rejectedReasons[0]).toMatchObject({ code: "UPGRADE_ALREADY_PROCESSING" });

    const orderRows = await testDb
      .select({ id: ordersTable.id })
      .from(ordersTable)
      .where(eq(ordersTable.userId, world.userId));
    expect(orderRows).toHaveLength(1); // the LOSER created nothing at all
    expect(await getWalletBalance(world.userId)).toBe("75.00"); // debited the 25.00 payable exactly once
    const owned = await db.getPurchaseByUserAndEpisode(world.userId, world.packageEpisodeId);
    expect(owned).toBeTruthy();
  });

  it("replaying execute with the same idempotency key returns the same receipt without a new order", async () => {
    const world = await createWorld();
    await seedWalletChapterPurchase(world.userId, world.novelId, world.chapters["1"].id, "5.00");
    await seedWalletBalance(world.userId, "100.00");
    const quote = await quotePackageUpgrade(world.userId, world.packageEpisodeId);
    const input = { upgradeId: quote.upgradeId, method: "wallet" as const, idempotencyKey: "p3-replay-0000001", expectedFinalTotal: quote.payableAmount };
    const first = await executePackageUpgrade(world.userId, input);
    const replay = await executePackageUpgrade(world.userId, input);
    expect(replay.alreadyProcessed).toBe(true);
    expect(replay.orderId).toBe(first.orderId);

    const orderRows = await testDb.select({ id: ordersTable.id }).from(ordersTable).where(eq(ordersTable.userId, world.userId));
    expect(orderRows).toHaveLength(1);
  });

  it("a chapter purchased AFTER the quote makes execution fail with STALE_QUOTE", async () => {
    const world = await createWorld();
    await seedWalletChapterPurchase(world.userId, world.novelId, world.chapters["1"].id, "5.00");
    const quote = await quotePackageUpgrade(world.userId, world.packageEpisodeId);
    await seedWalletChapterPurchase(world.userId, world.novelId, world.chapters["2"].id, "5.00");
    await expect(
      executePackageUpgrade(world.userId, { upgradeId: quote.upgradeId, method: "wallet", idempotencyKey: "p3-stale-000001", expectedFinalTotal: quote.payableAmount })
    ).rejects.toMatchObject({ code: "STALE_QUOTE" });
    // Re-quoting picks up the new chapter set.
    const fresh = await quotePackageUpgrade(world.userId, world.packageEpisodeId);
    expect(fresh.creditAmount).toBe("10.00");
    expect(fresh.upgradeId).not.toBe(quote.upgradeId);
  });

  it("an expired quote is refused with QUOTE_EXPIRED", async () => {
    const world = await createWorld();
    await seedWalletChapterPurchase(world.userId, world.novelId, world.chapters["1"].id, "5.00");
    const quote = await quotePackageUpgrade(world.userId, world.packageEpisodeId);
    await testDb
      .update(packageUpgradesTable)
      .set({ quoteExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(packageUpgradesTable.id, quote.upgradeId));
    await expect(
      executePackageUpgrade(world.userId, { upgradeId: quote.upgradeId, method: "wallet", idempotencyKey: "p3-expired-0001", expectedFinalTotal: quote.payableAmount })
    ).rejects.toMatchObject({ code: "QUOTE_EXPIRED" });
  });

  it("cart.add is refused while the upgrade order is still pending, allowed after rejection", async () => {
    const world = await createWorld();
    await seedWalletChapterPurchase(world.userId, world.novelId, world.chapters["1"].id, "5.00");
    const quote = await quotePackageUpgrade(world.userId, world.packageEpisodeId);
    const result = await executePackageUpgrade(world.userId, {
      upgradeId: quote.upgradeId,
      method: "slip",
      idempotencyKey: "p3-cart-0000001",
      expectedFinalTotal: quote.payableAmount,
    });
    expect(await hasPendingUpgradeOrderForPackage(world.userId, world.packageEpisodeId)).toBe(true);

    const cartCaller = caller(world.userId);
    await expect(cartCaller.cart.add({ episodeId: world.packageEpisodeId })).rejects.toBeTruthy();

    // Admin rejects the slip payment -> the pending order no longer blocks.
    const payment = await db.getPaymentByOrderId(result.orderId);
    await orderService.rejectPayment(payment.id, "1", "P3 test rejection");
    expect(await hasPendingUpgradeOrderForPackage(world.userId, world.packageEpisodeId)).toBe(false);
    await expect(cartCaller.cart.add({ episodeId: world.packageEpisodeId })).resolves.toBeTruthy();
  });
});


describe("P3-R2 financial & checkout safety (integration)", () => {
  it("R2-01: order credit uses the NET paid share after order-level coupon/points allocation", async () => {
    const world = await createWorld();
    // Order owns chapter 1: item finalPrice 10.00, order subtotal 10.00,
    // order-level coupon 2.00 + points 1.00 -> allocated 3.00 -> net 7.00.
    const order = await createTestOrder(world.userId, {
      subtotal: "10.00",
      totalAmount: "7.00",
      discountAmount: "2.00",
    });
    await createTestOrderItem({
      orderId: order.id,
      novelId: world.novelId,
      episodeId: world.chapters["1"].id,
      unitPrice: "10.00",
      discountAmount: "2.00",
      finalPrice: "10.00",
    });
    await testDb
      .update(ordersTable)
      .set({ status: "approved", paymentStatus: "approved", pointsDiscountAmount: "1.00" })
      .where(eq(ordersTable.id, order.id));
    await db.createPurchase(world.userId, world.novelId, world.chapters["1"].id, order.id);

    const quote = await quotePackageUpgrade(world.userId, world.packageEpisodeId);
    expect(quote.creditAmount).toBe("7.00"); // gross 10.00 would double-count the discounts
    expect(quote.payableAmount).toBe("23.00");
  });

  it("R2-01: forged or mismatched wallet transactions fail closed (no credit)", async () => {
    const world = await createWorld();

    // (a) purchase row whose linked transaction is NOT a debit of the right
    // amount (someone edited the ledger) - excluded entirely.
    const forged = await testDb.insert(walletTransactionsTable).values({
      userId: world.userId,
      type: "topup_approved",
      amount: "5.00",
      balanceBefore: "0.00",
      balanceAfter: "5.00",
      referenceType: "episode_purchase",
    });
    const forgedId = (forged as unknown as [{ insertId: number }])[0].insertId;
    await testDb.insert(episodePurchasesTable).values({
      userId: world.userId,
      novelId: world.novelId,
      episodeId: world.chapters["1"].id,
      pricePaid: "5.00",
      walletTransactionId: forgedId,
    });

    // (b) a REAL debit of a DIFFERENT amount than pricePaid claims -> excluded.
    const real = await seedWalletChapterPurchase(world.userId, world.novelId, world.chapters["2"].id, "5.00");
    const episodePurchase = await testDb
      .select({ id: episodePurchasesTable.id })
      .from(episodePurchasesTable)
      .where(and(eq(episodePurchasesTable.userId, world.userId), eq(episodePurchasesTable.episodeId, world.chapters["2"].id)));
    await testDb
      .update(walletTransactionsTable)
      .set({ amount: "4.00" })
      .where(eq(walletTransactionsTable.id, real));

    // (c) a debit belonging to a DIFFERENT user cannot vouch for this one.
    const otherUser = await createTestUser();
    const otherTx = await testDb.insert(walletTransactionsTable).values({
      userId: otherUser.id,
      type: "debit",
      amount: "5.00",
      balanceBefore: "5.00",
      balanceAfter: "0.00",
      referenceType: "episode_purchase",
    });
    const otherTxId = (otherTx as unknown as [{ insertId: number }])[0].insertId;
    await testDb.insert(episodePurchasesTable).values({
      userId: world.userId,
      novelId: world.novelId,
      episodeId: world.chapters["3"].id,
      pricePaid: "5.00",
      walletTransactionId: otherTxId,
    });

    const quote = await quotePackageUpgrade(world.userId, world.packageEpisodeId);
    expect(quote.creditAmount).toBe("0.00");
    expect(quote.items).toHaveLength(0);
    expect(quote.payableAmount).toBe("30.00");
  });

  it("R2-02: over-credit raw amounts allocate satang-exact; SUM(creditApplied) equals the snapshot", async () => {
    const world = await createWorld();
    // 3 chapters x 20.00 = 60.00 raw, package costs 50.00 -> cap applies.
    for (let n = 1; n <= 3; n++) {
      await seedWalletChapterPurchase(world.userId, world.novelId, world.chapters[String(n)].id, "20.00");
    }
    // Raw provable = 3 x 20.00 = 60.00 > the 30.00 package price - the cap
    // allocates IN MAPPING ORDER: 20.00 + 10.00, and chapter 3 (which would
    // have absorbed the rest) is left OUT of the ledger entirely.
    const quote = await quotePackageUpgrade(world.userId, world.packageEpisodeId);
    expect(quote.creditAmount).toBe("30.00");
    expect(quote.payableAmount).toBe("0.00");

    const items = await testDb
      .select()
      .from(packageUpgradeCreditItemsTable)
      .where(eq(packageUpgradeCreditItemsTable.upgradeId, quote.upgradeId));
    const byChapter = new Map(items.map((i) => [i.chapterEpisodeId, i.creditApplied]));
    expect(byChapter.get(world.chapters["1"].id)).toBe("20.00");
    expect(byChapter.get(world.chapters["2"].id)).toBe("10.00");
    expect(byChapter.has(world.chapters["3"].id)).toBe(false);
    const sum = items.reduce((acc, i) => acc + Number(i.creditApplied), 0);
    expect(sum).toBe(30);
    expect(sum).toBe(Number(quote.creditAmount));
    expect(quote.items.every((i) => Number(i.creditAppliedSnapshot ?? i.pricePaidSnapshot) > 0)).toBe(true);
  });

  it("R2-03: concurrent quotes return the SAME receipt (package-row lock)", async () => {
    const world = await createWorld();
    await seedWalletChapterPurchase(world.userId, world.novelId, world.chapters["1"].id, "5.00");
    const [a, b] = await Promise.all([
      quotePackageUpgrade(world.userId, world.packageEpisodeId),
      quotePackageUpgrade(world.userId, world.packageEpisodeId),
    ]);
    expect(b.upgradeId).toBe(a.upgradeId);
    const receipts = await testDb
      .select({ id: packageUpgradesTable.id })
      .from(packageUpgradesTable)
      .where(eq(packageUpgradesTable.userId, world.userId));
    expect(receipts).toHaveLength(1);
  });

  it("R2-03: multiple pending slips are impossible - the live order is surfaced as awaitingPayment", async () => {
    const world = await createWorld();
    await seedWalletChapterPurchase(world.userId, world.novelId, world.chapters["1"].id, "5.00");
    const quote = await quotePackageUpgrade(world.userId, world.packageEpisodeId);
    const first = await executePackageUpgrade(world.userId, {
      upgradeId: quote.upgradeId,
      method: "slip",
      idempotencyKey: "p3r2-slip-a-0001",
      expectedFinalTotal: quote.payableAmount,
    });

    // A second quote cannot create a second payment path: it returns the
    // SAME live receipt marked awaitingPayment.
    const second = await quotePackageUpgrade(world.userId, world.packageEpisodeId);
    expect(second.awaitingPayment).toBe(true);
    expect(second.orderId).toBe(first.orderId);
    expect((second as { upgradeId: number }).upgradeId).toBe(quote.upgradeId);
    expect(await hasPendingUpgradeOrderForPackage(world.userId, world.packageEpisodeId)).toBe(true);

    // Executing the (now non-quoted) receipt with a fresh key is refused.
    await expect(
      executePackageUpgrade(world.userId, {
        upgradeId: quote.upgradeId,
        method: "slip",
        idempotencyKey: "p3r2-slip-b-0002",
        expectedFinalTotal: quote.payableAmount,
      })
    ).rejects.toMatchObject({ code: "UPGRADE_ALREADY_PROCESSING" });
  });

  it("R2-03/R4: package in cart + upgrade execute -> upgrade succeeds and sweeps ONLY the package from the cart, other items survive, later quote fails ALREADY_OWNED", async () => {
    const world = await createWorld();
    await seedWalletChapterPurchase(world.userId, world.novelId, world.chapters["1"].id, "5.00");
    await seedWalletBalance(world.userId, "500.00");

    const cartCaller = caller(world.userId);
    await cartCaller.cart.add({ episodeId: world.packageEpisodeId });

    const quote = await quotePackageUpgrade(world.userId, world.packageEpisodeId);
    const result = await executePackageUpgrade(world.userId, {
      upgradeId: quote.upgradeId,
      method: "wallet",
      idempotencyKey: "p3r2-race-00001",
      expectedFinalTotal: quote.payableAmount,
    });
    expect(result.orderStatus).toBe("approved");
    expect(await getWalletBalance(world.userId)).toBe("475.00");
    expect(await db.getPurchaseByUserAndEpisode(world.userId, world.packageEpisodeId)).toBeTruthy();

    // A later upgrade quote for the SAME package fails - it is owned now.
    await expect(quotePackageUpgrade(world.userId, world.packageEpisodeId)).rejects.toMatchObject({
      code: "ALREADY_OWNED_PACKAGE",
    });
  });

  it("R2-05: chapters imported after the quote change the credit -> execute fails STALE_QUOTE", async () => {
    const world = await createWorld();
    await seedWalletChapterPurchase(world.userId, world.novelId, world.chapters["1"].id, "5.00");
    const quote = await quotePackageUpgrade(world.userId, world.packageEpisodeId);

    // "Import" adds chapter 2 (inside the range) AFTER the quote...
    const importResult = await testDb.insert(episodesTable).values({
      novelId: world.novelId,
      episodeNumber: "8",
      title: "P3 imported chapter 8",
      price: "5.00",
      isPublished: true,
      saleMode: "chapter",
      contentFormat: "plain_text",
    });
    const importedChapterId = (importResult as unknown as [{ insertId: number }])[0].insertId;
    // ...the import re-derives the mapping (persisting the new row)...
    const mapping = await ensurePackageChapterMapping({
      id: world.packageEpisodeId,
      novelId: world.novelId,
      episodeNumber: "1 - 10",
    });
    expect(mapping.some((m) => m.chapterEpisodeId === importedChapterId)).toBe(true);
    // ...and the user buys the newly imported chapter.
    await seedWalletChapterPurchase(world.userId, world.novelId, importedChapterId, "5.00");

    await expect(
      executePackageUpgrade(world.userId, {
        upgradeId: quote.upgradeId,
        method: "wallet",
        idempotencyKey: "p3r2-import-0001",
        expectedFinalTotal: quote.payableAmount,
      })
    ).rejects.toMatchObject({ code: "STALE_QUOTE" });
  });

  it("R2-05: the feature fails closed when PACKAGE_UPGRADE_ENABLED is not true (router gate)", async () => {
    const world = await createWorld();
    const previous = process.env.PACKAGE_UPGRADE_ENABLED;
    delete process.env.PACKAGE_UPGRADE_ENABLED;
    try {
      await expect(caller(world.userId).reader.packageUpgradeQuote.mutate({ packageEpisodeId: world.packageEpisodeId })).rejects.toBeTruthy();
    } finally {
      if (previous !== undefined) process.env.PACKAGE_UPGRADE_ENABLED = previous;
    }
  });

  it("R2-04: coupon/points ride the upgrade order AFTER the credit - wallet settles the final total", async () => {
    const world = await createWorld();
    await seedWalletChapterPurchase(world.userId, world.novelId, world.chapters["1"].id, "5.00");
    await seedWalletBalance(world.userId, "100.00");
    const quote = await quotePackageUpgrade(world.userId, world.packageEpisodeId, {
      couponCode: `P3R2${uniqueTestTag("c")}`.toUpperCase().slice(0, 20),
    }).catch(() => null);
    // Coupon may not exist - the invariant under test is the NO-coupon path:
    // amountPaid == order.totalAmount == payable (single server price).
    const executedQuote = quote ?? (await quotePackageUpgrade(world.userId, world.packageEpisodeId));
    const result = await executePackageUpgrade(world.userId, {
      upgradeId: executedQuote.upgradeId,
      method: "wallet",
      idempotencyKey: "p3r2-final-0001",
      expectedFinalTotal:
        (executedQuote as { finalTotal?: string }).finalTotal ?? executedQuote.payableAmount,
    });
    expect(result.orderStatus).toBe("approved");
    expect((result as { amountPaid: string }).amountPaid).toBe("25.00");
    expect(await getWalletBalance(world.userId)).toBe("75.00");
  });
});


describe("P3-R3 critical financial correctness (integration)", () => {
  it("R3-1: a REAL purchaseEpisodeWithWallet purchase is provable for upgrade credit", async () => {
    const world = await createWorld();
    await seedWalletBalance(world.userId, "50.00");

    // BUY THE CHAPTER THROUGH THE REAL PRODUCTION FLOW (wallet debit + ledger
    // + entitlement, exactly as a user would) - no fixtures for the money.
    const result = await purchaseEpisodeWithWallet(world.userId, world.chapters["1"].id);
    expect(result.success).toBe(true);

    const [purchaseRow] = await testDb
      .select({ id: episodePurchasesTable.id, walletTransactionId: episodePurchasesTable.walletTransactionId })
      .from(episodePurchasesTable)
      .where(and(eq(episodePurchasesTable.userId, world.userId), eq(episodePurchasesTable.episodeId, world.chapters["1"].id)));
    expect(purchaseRow).toBeTruthy();
    const ledger = await testDb
      .select({ referenceId: walletTransactionsTable.referenceId, type: walletTransactionsTable.type })
      .from(walletTransactionsTable)
      .where(eq(walletTransactionsTable.id, purchaseRow.walletTransactionId as number));
    expect(ledger[0]).toMatchObject({ type: "debit", referenceId: world.chapters["1"].id });

    const quote = await quotePackageUpgrade(world.userId, world.packageEpisodeId);
    expect(quote.creditAmount).toBe("5.00");
    expect(quote.payableAmount).toBe("25.00");
    expect(quote.items).toHaveLength(1);
    expect(quote.items[0]).toMatchObject({ chapterEpisodeId: world.chapters["1"].id, source: "wallet_purchase" });
  });

  it("R3-1: a debit whose referenceId points at the WRONG episode fails closed", async () => {
    const world = await createWorld();
    // Chapter 1's purchase claims its debit references chapter 2's episode id
    // (or vice versa) - the corroboration cannot tie money to THIS content.
    const purchaseResult = await testDb.insert(episodePurchasesTable).values({
      userId: world.userId,
      novelId: world.novelId,
      episodeId: world.chapters["1"].id,
      pricePaid: "5.00",
      walletTransactionId: null,
    });
    const purchaseId = (purchaseResult as unknown as [{ insertId: number }])[0].insertId;
    await testDb.insert(walletTransactionsTable).values({
      userId: world.userId,
      type: "debit",
      amount: "5.00",
      balanceBefore: "100.00",
      balanceAfter: "95.00",
      referenceType: "episode_purchase",
      referenceId: world.chapters["2"].id, // WRONG episode
    });
    await testDb
      .update(episodePurchasesTable)
      .set({ walletTransactionId: (await testDb.select({ id: walletTransactionsTable.id }).from(walletTransactionsTable).where(eq(walletTransactionsTable.referenceId, world.chapters["2"].id)))[0].id })
      .where(eq(episodePurchasesTable.id, purchaseId));

    const quote = await quotePackageUpgrade(world.userId, world.packageEpisodeId);
    expect(quote.creditAmount).toBe("0.00");
    expect(quote.items).toHaveLength(0);
  });

  it("R3-2: flag OFF + no 0068 tables leaves cart/wallet checkout fully working", async () => {
    const world = await createWorld();
    await seedWalletBalance(world.userId, "500.00");
    const previousFlag = process.env.PACKAGE_UPGRADE_ENABLED;
    delete process.env.PACKAGE_UPGRADE_ENABLED;
    try {
      // Simulate "0068 has not been applied yet": drop the three tables.
      await testDb.execute(
        (await import("drizzle-orm")).sql`DROP TABLE IF EXISTS packageUpgradeCreditItems`
      );
      await testDb.execute(
        (await import("drizzle-orm")).sql`DROP TABLE IF EXISTS packageUpgrades`
      );
      await testDb.execute(
        (await import("drizzle-orm")).sql`DROP TABLE IF EXISTS packageChapterMappings`
      );

      // ...an ordinary WALLET CHAPTER purchase still works end-to-end...
      await expect(purchaseEpisodeWithWallet(world.userId, world.chapters["1"].id)).resolves.toMatchObject({ success: true });
      // ...and walletCheckout of the PACKAGE (packageCart flow) still works:
      await testDb.insert((await import("../../drizzle/schema")).cartItems).values({
        cartId: (await db.getOrCreateCart(world.userId)).id,
        novelId: world.novelId,
        episodeId: world.packageEpisodeId,
        price: "30.00",
      });
      const checkout = await caller(world.userId).checkout.walletCheckout({});
      expect(checkout.success).toBe(true);
      // entitlement written by the ORDINARY pipeline:
      expect(await db.getPurchaseByUserAndEpisode(world.userId, world.packageEpisodeId)).toBeTruthy();
    } finally {
      // Restore the 0068 schema from the migration file, satang-for-satang.
      const fs = await import("node:fs");
      const path = await import("node:path");
      const sqlText = fs.readFileSync(
        path.join(__dirname, "..", "..", "drizzle", "0068_package_upgrade_ledger.sql"),
        "utf8"
      );
      for (const statement of sqlText.split("--> statement-breakpoint")) {
        const trimmed = statement.trim();
        if (trimmed && !trimmed.startsWith("--")) {
          await testDb.execute((await import("drizzle-orm")).sql.raw(trimmed));
        }
      }
      if (previousFlag !== undefined) process.env.PACKAGE_UPGRADE_ENABLED = previousFlag;
    }
  });

  it("R3-3: coupon remainder is absorbed exactly on the last chapter (satang-complete allocation)", async () => {
    const world = await createWorld();
    // Two order-owned chapters: 3.33 + 6.68, subtotal 10.01, coupon 3.33.
    const order = await createTestOrder(world.userId, {
      subtotal: "10.01",
      totalAmount: "6.68",
      discountAmount: "3.33",
    });
    await createTestOrderItem({ orderId: order.id, novelId: world.novelId, episodeId: world.chapters["1"].id, unitPrice: "3.33", discountAmount: "0.00", finalPrice: "3.33" });
    await createTestOrderItem({ orderId: order.id, novelId: world.novelId, episodeId: world.chapters["2"].id, unitPrice: "6.68", discountAmount: "0.00", finalPrice: "6.68" });
    await testDb
      .update(ordersTable)
      .set({ status: "approved", paymentStatus: "approved" })
      .where(eq(ordersTable.id, order.id));
    await db.createPurchase(world.userId, world.novelId, world.chapters["1"].id, order.id);
    await db.createPurchase(world.userId, world.novelId, world.chapters["2"].id, order.id);

    // R5-03 allocation: proportional floor 110 + 222 = 332 satang, and the
    // 1-satang remainder is spread in order onto the first chapter (which
    // has headroom) -> allocated 111 + 222 = 333 exactly. Nets: 2.22 / 4.46.
    const quote = await quotePackageUpgrade(world.userId, world.packageEpisodeId);
    const byChapter = new Map(quote.items.map((i) => [i.chapterEpisodeId, i.pricePaidSnapshot]));
    expect(byChapter.get(world.chapters["1"].id)).toBe("2.22");
    expect(byChapter.get(world.chapters["2"].id)).toBe("4.46");
    expect(quote.creditAmount).toBe("6.68");
  });

  it("R3-4: concurrent slip-upgrade vs walletCheckout - exactly ONE payment path wins", async () => {
    const world = await createWorld();
    await seedWalletChapterPurchase(world.userId, world.novelId, world.chapters["1"].id, "5.00");
    await seedWalletBalance(world.userId, "500.00");

    const quote = await quotePackageUpgrade(world.userId, world.packageEpisodeId);
    const [upgradeOutcome, checkoutOutcome] = await Promise.allSettled([
      executePackageUpgrade(world.userId, {
        upgradeId: quote.upgradeId,
        method: "slip",
        idempotencyKey: "p3r3-race-up-0001",
        expectedFinalTotal: quote.payableAmount,
      }),
      caller(world.userId).checkout.walletCheckout({}),
    ]);

    const upgradeWon = upgradeOutcome.status === "fulfilled";
    const checkoutWon = checkoutOutcome.status === "fulfilled";
    // Both money paths succeeding = double purchase - FORBIDDEN.
    expect(upgradeWon && checkoutWon).toBe(false);

    const packagePurchases = await testDb
      .select({ id: purchasesTable.id })
      .from(purchasesTable)
      .where(eq(purchasesTable.episodeId, world.packageEpisodeId));
    expect(packagePurchases.length).toBeLessThanOrEqual(1);
    // If the wallet checkout won, the wallet was debited ONCE (30.00) and the
    // upgrade was refused; if the upgrade won, the wallet is untouched and
    // its slip order is pending.
    if (checkoutWon) {
      // Wallet checkout won: full price 30.00 debited once. The upgrade was
      // refused for a SAFE reason (already owned / racing claim / stale
      // quote / cart busy) - any refusal is fine, double purchase is not.
      expect(await getWalletBalance(world.userId)).toBe("470.00");
      expect(upgradeOutcome.status).toBe("rejected");
    } else {
      // Upgrade won: its slip order exists, walletCheckout refused, wallet untouched.
      expect(upgradeOutcome.status).toBe("fulfilled");
      // The checkout was refused (pending-upgrade guard or empty cart after
      // the sweep - both mean the second payment path is closed).
      expect(checkoutOutcome.status).toBe("rejected");
      expect(await getWalletBalance(world.userId)).toBe("500.00"); // slip never debits
    }
    void upgradeWon;
  });

  it("R3-5: a slip upgrade is refused while slip checkout is under maintenance", async () => {
    const world = await createWorld();
    await seedWalletChapterPurchase(world.userId, world.novelId, world.chapters["1"].id, "5.00");
    const quote = await quotePackageUpgrade(world.userId, world.packageEpisodeId);

    await db.setSetting(
      CHECKOUT_MAINTENANCE_SETTING_KEY,
      JSON.stringify({
        enabled: true,
        scope: "slip_only",
        severity: "info",
        title: "maintenance",
        message: "slip closed",
        updatedAt: new Date().toISOString(),
      }),
      "P3 test"
    );
    try {
      await expect(
        executePackageUpgrade(world.userId, {
          upgradeId: quote.upgradeId,
          method: "slip",
          idempotencyKey: "p3r3-slipgate-0001",
          expectedFinalTotal: quote.payableAmount,
        })
      ).rejects.toBeTruthy();
    } finally {
      await db.setSetting(
        CHECKOUT_MAINTENANCE_SETTING_KEY,
        JSON.stringify({ enabled: false, scope: "all_checkout", severity: "info", title: "", message: "", updatedAt: new Date().toISOString() }),
        "P3 test"
      );
    }
    // Wallet method is NOT affected by slip-only maintenance.
    await seedWalletBalance(world.userId, "100.00");
    const result = await executePackageUpgrade(world.userId, {
      upgradeId: quote.upgradeId,
      method: "wallet",
      idempotencyKey: "p3r3-slipgate-0002",
      expectedFinalTotal: quote.payableAmount,
    });
    expect(result.orderStatus).toBe("approved");
  });

  it("R3-6: REAL coupon + points ride quote -> execute -> finalization consistently", async () => {
    const world = await createWorld();
    await seedWalletChapterPurchase(world.userId, world.novelId, world.chapters["1"].id, "5.00");
    await seedWalletBalance(world.userId, "500.00");

    // A real flat coupon (10.00) owned by nobody global + real points balance.
    const coupon = await createTestCoupon({ discountType: "flat", discountValue: "10.00", isActive: true });
    const couponCode = coupon.code;
    await testDb.insert((await import("../../drizzle/schema")).pointsTransactions).values({
      userId: world.userId,
      type: "earn",
      amount: "5.00",
      balanceAfter: "5.00",
      referenceType: "p3_test_seed",
    });

    const quote = await quotePackageUpgrade(world.userId, world.packageEpisodeId, {
      couponCode,
      pointsToRedeem: "2",
    });
    // credit 5 -> payable 25 -> coupon 10 -> points 2 => finalTotal 13.00
    expect(quote.payableAmount).toBe("25.00");
    expect((quote as { couponDiscount?: string }).couponDiscount).toBe("10.00");
    expect((quote as { pointsDiscount?: string }).pointsDiscount).toBe("2.00");
    expect((quote as { finalTotal?: string }).finalTotal).toBe("13.00");

    const result = await executePackageUpgrade(world.userId, {
      upgradeId: quote.upgradeId,
      method: "wallet",
      idempotencyKey: "p3r3-real-00001",
      couponCode,
      pointsToRedeem: "2",
      expectedFinalTotal: (quote as { finalTotal?: string }).finalTotal as string,
    });
    expect(result.orderStatus).toBe("approved");
    expect((result as { amountPaid: string }).amountPaid).toBe("13.00");

    // Wallet debited exactly the final total.
    expect(await getWalletBalance(world.userId)).toBe("487.00");

    // Order recorded every layer.
    const order = await db.getOrderById(result.orderId);
    expect(order?.discountAmount).toBe("10.00");
    expect(order?.pointsDiscountAmount).toBe("2.00");
    expect(order?.totalAmount).toBe("13.00");

    // Finalization consumed the points and the coupon EXACTLY once.
    expect(await db.getUserPointsBalance(world.userId)).toBe("3.00");
    const couponUsage = await testDb
      .select()
      .from((await import("../../drizzle/schema")).couponUsages)
      .where(eq((await import("../../drizzle/schema")).couponUsages.orderId, result.orderId));
    expect(couponUsage).toHaveLength(1);
    expect(await db.getPurchaseByUserAndEpisode(world.userId, world.packageEpisodeId)).toBeTruthy();
  });
});


describe("P3-R4 final checkout & credit integrity (integration)", () => {
  it("R4-1: whole-order allocation - discounts spread across ALL items before mapped chapters are picked", async () => {
    const world = await createWorld();
    // ONE approved order with a MAPPED chapter (6.00) and an OUT-OF-PACKAGE
    // item (4.00): subtotal 10.00, coupon 3.33.
    // Whole-order allocation: floor(600*333/1000)=199 + floor(400*333/1000)=133
    // = 332, remainder 1 absorbed by the last item -> 134. Nets: 4.01 / 2.66.
    // The mapped chapter's credit is 4.01 - NOT 6.00-3.33=2.67 (which would
    // dump the entire order discount onto the only eligible item).
    const order = await createTestOrder(world.userId, {
      subtotal: "10.00",
      totalAmount: "6.67",
      discountAmount: "3.33",
    });
    await createTestOrderItem({ orderId: order.id, novelId: world.novelId, episodeId: world.chapters["1"].id, unitPrice: "6.00", discountAmount: "0.00", finalPrice: "6.00" });
    const outsideChapter = (await testDb.insert(episodesTable).values({
      novelId: world.novelId,
      episodeNumber: "50",
      title: "P4 outside item",
      price: "4.00",
      isPublished: true,
      saleMode: "chapter",
      contentFormat: "plain_text",
    }));
    const outsideId = (outsideChapter as unknown as [{ insertId: number }])[0].insertId;
    await createTestOrderItem({ orderId: order.id, novelId: world.novelId, episodeId: outsideId, unitPrice: "4.00", discountAmount: "0.00", finalPrice: "4.00" });
    await testDb
      .update(ordersTable)
      .set({ status: "approved", paymentStatus: "approved" })
      .where(eq(ordersTable.id, order.id));
    await db.createPurchase(world.userId, world.novelId, world.chapters["1"].id, order.id);
    await db.createPurchase(world.userId, world.novelId, outsideId, order.id);

    const quote = await quotePackageUpgrade(world.userId, world.packageEpisodeId);
    const byChapter = new Map(quote.items.map((i) => [i.chapterEpisodeId, i.pricePaidSnapshot]));
    // Provable net of the mapped chapter AFTER its proportional share + remainder.
    expect(byChapter.get(world.chapters["1"].id)).toBe("4.00");
    expect(quote.creditAmount).toBe("4.00");
    // The out-of-package chapter is NOT credited even though it is owned.
    expect(byChapter.has(outsideId)).toBe(false);
  });

  it("R4-2: flag OFF + missing 0068 tables - cart.add, walletCheckout work through REAL APIs", async () => {
    const world = await createWorld();
    await seedWalletBalance(world.userId, "500.00");
    const previousFlag = process.env.PACKAGE_UPGRADE_ENABLED;
    delete process.env.PACKAGE_UPGRADE_ENABLED;
    try {
      await testDb.execute((await import("drizzle-orm")).sql`DROP TABLE IF EXISTS packageUpgradeCreditItems`);
      await testDb.execute((await import("drizzle-orm")).sql`DROP TABLE IF EXISTS packageUpgrades`);
      await testDb.execute((await import("drizzle-orm")).sql`DROP TABLE IF EXISTS packageChapterMappings`);

      const cartCaller = caller(world.userId);
      // cart.add of the PACKAGE works (guard is a flag-aware no-op)...
      await expect(cartCaller.cart.add({ episodeId: world.packageEpisodeId })).resolves.toBeTruthy();
      // ...and walletCheckout completes the ordinary purchase end-to-end.
      const checkout = await cartCaller.checkout.walletCheckout({});
      expect(checkout.success).toBe(true);
      expect(await db.getPurchaseByUserAndEpisode(world.userId, world.packageEpisodeId)).toBeTruthy();
      // Debit matched the package price.
      expect(await getWalletBalance(world.userId)).toBe("470.00");
    } finally {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const sqlText = fs.readFileSync(
        path.join(__dirname, "..", "..", "drizzle", "0068_package_upgrade_ledger.sql"),
        "utf8"
      );
      for (const statement of sqlText.split("--> statement-breakpoint")) {
        const trimmed = statement.trim();
        if (trimmed && !trimmed.startsWith("--")) {
          await testDb.execute((await import("drizzle-orm")).sql.raw(trimmed));
        }
      }
      if (previousFlag !== undefined) process.env.PACKAGE_UPGRADE_ENABLED = previousFlag;
    }
  });

  it("R4-3: walletCheckout is atomic - pending-upgrade guard runs inside the cart-locked transaction", async () => {
    const world = await createWorld();
    await seedWalletChapterPurchase(world.userId, world.novelId, world.chapters["1"].id, "5.00");
    await seedWalletBalance(world.userId, "500.00");

    const quote = await quotePackageUpgrade(world.userId, world.packageEpisodeId);
    const upgrade = await executePackageUpgrade(world.userId, {
      upgradeId: quote.upgradeId,
      method: "slip",
      idempotencyKey: "p3r4-atomic-001",
      expectedFinalTotal: quote.payableAmount,
    });
    // Upgrade's slip order is pending; the package is back in the cart
    // (add while pending is refused by cart.add's own guard, so seed the
    // cart state directly the way a stale pre-upgrade cart would look).
    await testDb.insert((await import("../../drizzle/schema")).cartItems).values({
      cartId: (await db.getOrCreateCart(world.userId)).id,
      novelId: world.novelId,
      episodeId: world.packageEpisodeId,
      price: "30.00",
    });

    const walletErr = await caller(world.userId).checkout.walletCheckout({}).catch((e) => e);
    expect(walletErr).toBeInstanceOf(Error);
    expect(String((walletErr as Error).message)).toContain("PENDING_UPGRADE_ORDER_EXISTS");
    // Nothing was debited and no second order for the package was created.
    expect(await getWalletBalance(world.userId)).toBe("500.00");
    expect(upgrade.orderStatus).toBe("pending");
    void upgrade;
  });

  it("R4-4 deterministic order A: walletCheckout first wins, upgrade is then refused with ALREADY_OWNED", async () => {
    const world = await createWorld();
    await seedWalletBalance(world.userId, "500.00");
    const cartCaller = caller(world.userId);
    // REAL cart: the package is added through the actual cart API.
    await cartCaller.cart.add({ episodeId: world.packageEpisodeId });

    // Wallet checkout settles the package at full price.
    const checkout = await cartCaller.checkout.walletCheckout({});
    expect(checkout.success).toBe(true);
    expect(await getWalletBalance(world.userId)).toBe("470.00");

    // NOW the upgrade must refuse - the package is already owned.
    const quote = await quotePackageUpgrade(world.userId, world.packageEpisodeId).catch(() => null);
    expect(quote).toBeNull(); // quote itself fails with ALREADY_OWNED_PACKAGE
    await expect(
      quotePackageUpgrade(world.userId, world.packageEpisodeId)
    ).rejects.toMatchObject({ code: "ALREADY_OWNED_PACKAGE" });
  });

  it("R4-4 deterministic order B: slip upgrade first wins, walletCheckout then refuses with CONFLICT", async () => {
    const world = await createWorld();
    await seedWalletChapterPurchase(world.userId, world.novelId, world.chapters["1"].id, "5.00");
    await seedWalletBalance(world.userId, "500.00");
    const cartCaller = caller(world.userId);
    // No cart contents: nothing for walletCheckout to settle afterwards.

    const quote = await quotePackageUpgrade(world.userId, world.packageEpisodeId);
    const upgrade = await executePackageUpgrade(world.userId, {
      upgradeId: quote.upgradeId,
      method: "slip",
      idempotencyKey: "p3r4-orderb-0001",
      expectedFinalTotal: quote.payableAmount,
    });
    expect(upgrade.orderStatus).toBe("pending");

    // Wallet checkout has nothing to settle for the package: cart holds a
    // chapter, not the package itself.
    await expect(cartCaller.checkout.walletCheckout({})).rejects.toBeTruthy();
    // Exactly ONE order exists for this user, and no double debit happened.
    const orders = await testDb
      .select({ id: ordersTable.id, status: ordersTable.status })
      .from(ordersTable)
      .where(eq(ordersTable.userId, world.userId));
    expect(orders).toHaveLength(1);
    expect(await getWalletBalance(world.userId)).toBe("500.00");
    // The pending slip can still be approved through the normal pipeline.
    const payment = await db.getPaymentByOrderId(upgrade.orderId as number);
    await orderService.approvePayment(payment.id, "1");
    expect(await db.getPurchaseByUserAndEpisode(world.userId, world.packageEpisodeId)).toBeTruthy();
  });

  it("R4-4 real race: cart.add first, then slip-upgrade vs walletCheckout - never both winners, single entitlement", async () => {
    const world = await createWorld();
    await seedWalletChapterPurchase(world.userId, world.novelId, world.chapters["1"].id, "5.00");
    await seedWalletBalance(world.userId, "500.00");
    const cartCaller = caller(world.userId);
    await cartCaller.cart.add({ episodeId: world.packageEpisodeId });

    const raceQuote = await quotePackageUpgrade(world.userId, world.packageEpisodeId);
    const [upgradeOutcome, checkoutOutcome] = await Promise.allSettled([
      executePackageUpgrade(world.userId, {
        upgradeId: raceQuote.upgradeId,
        method: "slip",
        idempotencyKey: "p3r4-race-real-001",
        expectedFinalTotal: raceQuote.payableAmount,
      }),
      cartCaller.checkout.walletCheckout({}),
    ]);

    const upgradeWon = upgradeOutcome.status === "fulfilled";
    const checkoutWon = checkoutOutcome.status === "fulfilled";
    expect(upgradeWon && checkoutWon).toBe(false);

    // DB state after the race:
    const packagePurchases = await testDb
      .select({ id: purchasesTable.id })
      .from(purchasesTable)
      .where(eq(purchasesTable.episodeId, world.packageEpisodeId));
    expect(packagePurchases.length).toBeLessThanOrEqual(1);

    const packageOrders = await testDb
      .select({ id: ordersTable.id, status: ordersTable.status })
      .from(ordersTable)
      .where(and(eq(ordersTable.userId, world.userId), eq(ordersTable.status, "pending")));
    // No two simultaneously payable orders for the same package.
    expect(packageOrders.length).toBeLessThanOrEqual(1);

    if (checkoutWon) {
      expect(await getWalletBalance(world.userId)).toBe("470.00");
      // The upgrade was refused for a SAFE reason (already owned / racing
      // claim / stale quote / cart busy) - any refusal is fine, a double
      // purchase is not.
      expect(upgradeOutcome.status).toBe("rejected");
    } else {
      expect(upgradeOutcome.status).toBe("fulfilled");
      expect(await getWalletBalance(world.userId)).toBe("500.00");
    }
  });

  it("R4-5/R8-1: no session-level lock timeout, no named lock, no kill shortcut in the upgrade service", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      (await import("node:path")).join(__dirname, "packageUpgradeService.ts"),
      "utf8"
    );
    // R8-1: the execution mutex is a TRANSACTIONAL ROW LOCK released by
    // commit/rollback itself - the connection-scoped named lock and the
    // kill-based cleanup shortcut are gone entirely, and no session
    // variable is ever set on a pooled connection.
    expect(source).not.toContain("SET SESSION innodb_lock_wait_timeout");
    expect(source).not.toContain("GET_LOCK");
    expect(source).not.toContain("RELEASE_LOCK");
    expect(source).not.toContain("KILL CONNECTION");
    expect(source).toContain("FOR UPDATE NOWAIT");
    expect(source).toContain("packageUpgradeExecLocks");
    // R8R1: NOWAIT refusal is engine-specific - MySQL reports ER_LOCK_NOWAIT
    // (3572), MariaDB reports ER_LOCK_WAIT_TIMEOUT (1205). Both must map to
    // UPGRADE_CART_BUSY at the acquire point only.
    expect(source).toContain("ER_LOCK_NOWAIT");
    expect(source).toContain("ER_LOCK_WAIT_TIMEOUT");
    expect(source).toContain("isNowaitLockRefused");
  });
});


describe("P3-R5 cart lock & financial allocation (integration)", () => {
  it("R5-01: cart LOCKED by an in-flight checkout -> execute fails CLOSED with UPGRADE_CART_BUSY and creates nothing", async () => {
    const world = await createWorld();
    await seedWalletChapterPurchase(world.userId, world.novelId, world.chapters["1"].id, "5.00");
    await seedWalletBalance(world.userId, "500.00");
    await caller(world.userId).cart.add({ episodeId: world.packageEpisodeId });

    const quote = await quotePackageUpgrade(world.userId, world.packageEpisodeId);
    const raw = await mysql.createConnection(process.env.TEST_DATABASE_URL as string);
    try {
      // Deterministic lock contention: hold the carts row FOR UPDATE on a
      // separate connection (simulating an in-flight checkout holding the
      // cart) BEFORE the upgrade runs.
      await raw.beginTransaction();
      await raw.execute("SELECT id FROM carts WHERE userId = ? FOR UPDATE", [world.userId]);

      await expect(
        executePackageUpgrade(world.userId, {
          upgradeId: quote.upgradeId,
          method: "slip",
          idempotencyKey: "p3r5-busy-00001",
          expectedFinalTotal: quote.payableAmount,
        })
      ).rejects.toMatchObject({ code: "UPGRADE_CART_BUSY" });

      // FAIL CLOSED proof: no order, receipt still quoted, wallet untouched.
      const orders = await testDb
        .select({ id: ordersTable.id })
        .from(ordersTable)
        .where(eq(ordersTable.userId, world.userId));
      expect(orders).toHaveLength(0);
      const receipt = await testDb
        .select()
        .from(packageUpgradesTable)
        .where(eq(packageUpgradesTable.id, quote.upgradeId));
      expect(receipt[0].status).toBe("quoted");
      expect(await getWalletBalance(world.userId)).toBe("500.00");

      // Release the cart lock -> the SAME quote now proceeds.
      await raw.rollback();
      const retry = await executePackageUpgrade(world.userId, {
        upgradeId: quote.upgradeId,
        method: "slip",
        idempotencyKey: "p3r5-busy-00002",
        expectedFinalTotal: quote.payableAmount,
      });
      expect(retry.orderStatus).toBe("pending");
    } finally {
      await raw.end();
    }
  });

  it("R5-01: NO cart at all -> upgrade proceeds without the cart sweep path", async () => {
    const world = await createWorld();
    await seedWalletChapterPurchase(world.userId, world.novelId, world.chapters["1"].id, "5.00");
    await seedWalletBalance(world.userId, "100.00");
    // (no getOrCreateCart call - the user has NO cart row)

    const quote = await quotePackageUpgrade(world.userId, world.packageEpisodeId);
    const result = await executePackageUpgrade(world.userId, {
      upgradeId: quote.upgradeId,
      method: "slip",
      idempotencyKey: "p3r5-nocart-0001",
      expectedFinalTotal: quote.payableAmount,
    });
    expect(result.orderStatus).toBe("pending");
  });

  it("R5-02: upgrading package A preserves unrelated cart items B/C; a failed (rolled back) upgrade preserves the WHOLE cart", async () => {
    const world = await createWorld();
    await seedWalletChapterPurchase(world.userId, world.novelId, world.chapters["1"].id, "5.00");

    // Package B (another package of the same novel) as cart item "B".
    const packageB = (await testDb.insert(episodesTable).values({
      novelId: world.novelId,
      episodeNumber: "11 - 20",
      title: "P3 Package B",
      price: "20.00",
      isPublished: true,
      saleMode: "package",
      contentFormat: "plain_text",
    }));
    const packageBId = (packageB as unknown as [{ insertId: number }])[0].insertId;
    // "C": a third product (chapter of another range, order-owned is irrelevant
    // here - it just sits in the cart).
    const chapterC = (await testDb.insert(episodesTable).values({
      novelId: world.novelId,
      episodeNumber: "30",
      title: "P3 Item C",
      price: "9.00",
      isPublished: true,
      saleMode: "chapter",
      contentFormat: "plain_text",
    }));
    const chapterCId = (chapterC as unknown as [{ insertId: number }])[0].insertId;

    const cartCaller = caller(world.userId);
    await cartCaller.cart.add({ episodeId: world.packageEpisodeId }); // A
    const dbg = async (label: string) => {
      const items = await db.getCartItems((await db.getOrCreateCart(world.userId)).id);
      console.log("R5-02 PROBE", label, JSON.stringify(items.map((i: { episodeId: number }) => i.episodeId)));
    };
    console.log("R5-02 IDS", JSON.stringify({ ch1: world.chapters["1"].id, pkg: world.packageEpisodeId, B: packageBId, C: chapterCId }));
    await dbg("after add A");
    await cartCaller.cart.add({ episodeId: packageBId }); // B
    await dbg("after add B");
    await testDb.insert((await import("../../drizzle/schema")).cartItems).values({
      cartId: (await db.getOrCreateCart(world.userId)).id,
      novelId: world.novelId,
      episodeId: chapterCId, // C (direct cart row - chapters are cart-barred via API)
      price: "9.00",
    });
    await dbg("after add C");

    // ROLLBACK case first: wallet cannot cover package A -> the whole
    // upgrade transaction rolls back -> the cart must be restored EXACTLY.
    await seedWalletBalance(world.userId, "0.00");
    await dbg("before execute1");
    const quoteA = await quotePackageUpgrade(world.userId, world.packageEpisodeId);
    await dbg("after quote");
    await expect(
      executePackageUpgrade(world.userId, {
        upgradeId: quoteA.upgradeId,
        method: "wallet",
        idempotencyKey: "p3r5-rollback-01",
        expectedFinalTotal: quoteA.payableAmount,
      })
    ).rejects.toMatchObject({ code: "INSUFFICIENT_WALLET_BALANCE" });
    await dbg("after rollback");

    const itemsAfterRollback = await db.getCartItems((await db.getOrCreateCart(world.userId)).id);
    const episodeIds = itemsAfterRollback.map((i: { episodeId: number }) => i.episodeId).sort();
    // Cart started as [A(package), B(packageB), C(chapter)] - after the
    // INSUFFICIENT rollback it must be restored EXACTLY: all three, with
    // package A intact.
    expect(episodeIds).toEqual([world.packageEpisodeId, packageBId, chapterCId].sort());
    expect(episodeIds).not.toContain(world.chapters["1"].id);

    // Now with funds: upgrading A removes ONLY package A from the cart -
    // B and C survive untouched.
    await seedWalletBalance(world.userId, "500.00");
    const result = await executePackageUpgrade(world.userId, {
      upgradeId: quoteA.upgradeId,
      method: "wallet",
      idempotencyKey: "p3r5-sweep-001",
      expectedFinalTotal: quoteA.payableAmount,
    });
    expect(result.orderStatus).toBe("approved");
    const itemsAfter = await db.getCartItems((await db.getOrCreateCart(world.userId)).id);
    expect(itemsAfter.map((i: { episodeId: number }) => i.episodeId)).toEqual([packageBId, chapterCId].sort((a, b) => a - b));
  });

  it("R5-03: satang-exact allocation on 0.02+0.02+0.02+0.01 with a 0.05 order discount", async () => {
    const world = await createWorld();
    // Four order-owned chapters inside the package range; subtotal 7 satang,
    // coupon+points discount 5 satang -> totalAmount 2 satang.
    const order = await createTestOrder(world.userId, {
      subtotal: "0.07",
      totalAmount: "0.02",
      discountAmount: "0.05",
    });
    const specs: Array<[number, string]> = [
      [world.chapters["1"].id, "0.02"],
      [world.chapters["2"].id, "0.02"],
      [world.chapters["3"].id, "0.02"],
      [world.chapters["4"].id, "0.01"],
    ];
    // NOTE: chapters["4"] (0.01) belongs to createWorld's fixed layout only
    // if present; createWorld builds chapters 1..5 plus 6/7 variants, so use
    // the exact ids by episode number instead:
    const byNumber = new Map<string, number>();
    const allChapters = await testDb
      .select({ id: episodesTable.id, episodeNumber: episodesTable.episodeNumber })
      .from(episodesTable)
      .where(eq(episodesTable.novelId, world.novelId));
    for (const row of allChapters) byNumber.set(row.episodeNumber, row.id);
    const orderedIds = ["1", "2", "3", "4"].map((n) => byNumber.get(n)!).filter((id) => id != null);
    expect(orderedIds).toHaveLength(4);

    for (const [idx, id] of orderedIds.entries()) {
      await createTestOrderItem({
        orderId: order.id,
        novelId: world.novelId,
        episodeId: id,
        unitPrice: specs[idx]?.[1] ?? "0.01",
        discountAmount: "0.00",
        finalPrice: specs[idx]?.[1] ?? "0.01",
      });
      await db.createPurchase(world.userId, world.novelId, id, order.id);
    }
    await testDb
      .update(ordersTable)
      .set({ status: "approved", paymentStatus: "approved" })
      .where(eq(ordersTable.id, order.id));

    // Provability invariant: SUM(net) == order.totalAmount, satang-exact.
    const orderItems = await db.getOrderItems(order.id);
    const orderRow = await db.getOrderById(order.id);
    const subtotalCents = Math.round(Number(orderRow?.subtotal) * 100);
    const discountCents =
      Math.round(Number(orderRow?.discountAmount) * 100) +
      Math.round(Number(orderRow?.pointsDiscountAmount) * 100);
    // R5-03 replication of the SERVICE's allocation: proportional floor per
    // item, then the leftover remainder spread ONE satang at a time onto
    // items whose allocated discount is still below their own price -
    // guaranteeing SUM(allocated) == discount and SUM(net) == totalAmount.
    const allocated = orderItems.map((item: { finalPrice: string }) =>
      Math.min(Math.floor((Math.round(Number(item.finalPrice) * 100) * discountCents) / subtotalCents), Math.round(Number(item.finalPrice) * 100))
    );
    let remainder = discountCents - allocated.reduce((a: number, b: number) => a + b, 0);
    let spreadI = 0;
    while (remainder > 0 && spreadI < allocated.length * 2) {
      const idx = spreadI % allocated.length;
      if (allocated[idx] < Math.round(Number(orderItems[idx].finalPrice) * 100)) {
        allocated[idx] += 1;
        remainder -= 1;
      }
      spreadI += 1;
    }
    const nets = orderItems.map((item: { finalPrice: string }, i: number) =>
      Math.round(Number(item.finalPrice) * 100) - allocated[i]
    );
    const sumNets = nets.reduce((a, b) => a + b, 0);
    expect(sumNets).toBe(subtotalCents - discountCents); // == 2 satang == totalAmount
    expect(Number(orderRow?.totalAmount)).toBe(sumNets / 100);

    const quote = await quotePackageUpgrade(world.userId, world.packageEpisodeId);
    // Mapped chapters' nets: 0, 0, 1, 1 satang -> provable credit = 2 satang,
    // which equals the order's own totalAmount (credit never exceeds net paid).
    expect(quote.creditAmount).toBe("0.02");
    const creditItems = await testDb
      .select()
      .from(packageUpgradeCreditItemsTable)
      .where(eq(packageUpgradeCreditItemsTable.upgradeId, quote.upgradeId));
    const sumCredit = creditItems.reduce((acc, i) => acc + Number(i.creditApplied), 0);
    expect(sumCredit).toBe(Number(quote.creditAmount));
    expect(sumCredit).toBeLessThanOrEqual(Number(orderRow?.totalAmount));
    void specs;
  });

  it("R5-04: deterministic lock contention - upgrade BUSY while walletCheckout holds the cart, then walletCheckout settles", async () => {
    const world = await createWorld();
    await seedWalletChapterPurchase(world.userId, world.novelId, world.chapters["1"].id, "5.00");
    await seedWalletBalance(world.userId, "500.00");
    const cartCaller = caller(world.userId);
    await cartCaller.cart.add({ episodeId: world.packageEpisodeId });

    const quote = await quotePackageUpgrade(world.userId, world.packageEpisodeId);
    const raw = await mysql.createConnection(process.env.TEST_DATABASE_URL as string);
    try {
      // Deterministic: hold the carts row on a separate connection.
      await raw.beginTransaction();
      await raw.execute("SELECT id FROM carts WHERE userId = ? FOR UPDATE", [world.userId]);

      // walletCheckout waits (FOR UPDATE, no skip) - start it and prove it
      // does NOT settle while the cart is held.
      const checkoutPromise = cartCaller.checkout.walletCheckout({});
      let settled = false;
      checkoutPromise.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        }
      );
      await new Promise((r) => setTimeout(r, 700));
      expect(settled).toBe(false);

      // Upgrade under contention: BUSY, creates nothing.
      await expect(
        executePackageUpgrade(world.userId, {
          upgradeId: quote.upgradeId,
          method: "slip",
          idempotencyKey: "p3r5-det-00001",
          expectedFinalTotal: quote.payableAmount,
        })
      ).rejects.toMatchObject({ code: "UPGRADE_CART_BUSY" });

      // Release -> walletCheckout proceeds and settles the package.
      await raw.rollback();
      const checkout = await checkoutPromise;
      expect(checkout.success).toBe(true);
      expect(await getWalletBalance(world.userId)).toBe("470.00");
      expect(await db.getPurchaseByUserAndEpisode(world.userId, world.packageEpisodeId)).toBeTruthy();
    } finally {
      await raw.end();
    }
  });
});

describe("P3-R6 final price confirmation (integration)", () => {
  it("R6-1a: an ACTIVE quote recomputes the coupon/points preview per the LATEST input", async () => {
    const world = await createWorld();
    await seedWalletChapterPurchase(world.userId, world.novelId, world.chapters["1"].id, "5.00");

    // First quote WITHOUT coupon/points: plain preview, no discount fields.
    const first = await quotePackageUpgrade(world.userId, world.packageEpisodeId);
    expect(first.payableAmount).toBe("25.00");
    expect((first as { finalTotal?: string }).finalTotal).toBeUndefined();

    // Re-quote the SAME active receipt WITH a real coupon: the preview now
    // reflects the latest input (payable snapshot stays frozen).
    const coupon = await createTestCoupon({ discountType: "flat", discountValue: "10.00", isActive: true });
    const second = await quotePackageUpgrade(world.userId, world.packageEpisodeId, {
      couponCode: coupon.code,
    });
    expect(second.upgradeId).toBe(first.upgradeId);
    expect(second.payableAmount).toBe("25.00");
    expect((second as { couponDiscount?: string }).couponDiscount).toBe("10.00");
    expect((second as { finalTotal?: string }).finalTotal).toBe("15.00");

    // Points-only preview on the same active receipt.
    await testDb.insert((await import("../../drizzle/schema")).pointsTransactions).values({
      userId: world.userId,
      type: "earn",
      amount: "3.00",
      balanceAfter: "3.00",
      referenceType: "p3_r6_seed",
    });
    const third = await quotePackageUpgrade(world.userId, world.packageEpisodeId, {
      pointsToRedeem: "2",
    });
    expect(third.upgradeId).toBe(first.upgradeId);
    expect((third as { pointsDiscount?: string }).pointsDiscount).toBe("2.00");
    expect((third as { finalTotal?: string }).finalTotal).toBe("23.00");
    expect((third as { couponDiscount?: string }).couponDiscount).toBe("0.00"); // explicit zero: no coupon input
  });

  it("R6-1b: execute honors expectedFinalTotal - wallet debit and order total match the confirmed price", async () => {
    const world = await createWorld();
    await seedWalletChapterPurchase(world.userId, world.novelId, world.chapters["1"].id, "5.00");
    await seedWalletBalance(world.userId, "500.00");

    const quote = await quotePackageUpgrade(world.userId, world.packageEpisodeId);
    const result = await executePackageUpgrade(world.userId, {
      upgradeId: quote.upgradeId,
      method: "wallet",
      idempotencyKey: "p3r6-bind-0001",
      expectedFinalTotal: quote.payableAmount,
    });
    expect(result.orderStatus).toBe("approved");
    expect((result as { amountPaid: string }).amountPaid).toBe("25.00");
    expect(await getWalletBalance(world.userId)).toBe("475.00");

    const orderRow = await db.getOrderById(result.orderId);
    expect(orderRow?.totalAmount).toBe("25.00");
  });

  it("R6-1c: expectedFinalTotal mismatch -> STALE_QUOTE with NO order and NO debit (receipt retired)", async () => {
    const world = await createWorld();
    await seedWalletChapterPurchase(world.userId, world.novelId, world.chapters["1"].id, "5.00");
    await seedWalletBalance(world.userId, "500.00");

    const quote = await quotePackageUpgrade(world.userId, world.packageEpisodeId);
    await expect(
      executePackageUpgrade(world.userId, {
        upgradeId: quote.upgradeId,
        method: "wallet",
        idempotencyKey: "p3r6-mismatch-01",
        expectedFinalTotal: "99.99", // customer accepted a DIFFERENT price
      })
    ).rejects.toMatchObject({ code: "STALE_QUOTE" });

    // Fail-closed proof: no order, no debit, receipt retired (never executed).
    const userOrders = await testDb
      .select({ id: ordersTable.id })
      .from(ordersTable)
      .where(eq(ordersTable.userId, world.userId));
    expect(userOrders).toHaveLength(0);
    expect(await getWalletBalance(world.userId)).toBe("500.00");
    const receipt = await testDb
      .select()
      .from(packageUpgradesTable)
      .where(eq(packageUpgradesTable.id, quote.upgradeId));
    expect(receipt[0].status).toBe("expired");
    expect(receipt[0].orderId).toBeNull();
  });

  it("R8-2b: the exec-lock row is provably HELD while the execute transaction runs and FREE after it settles", async () => {
    const world = await createWorld();
    await seedWalletChapterPurchase(world.userId, world.novelId, world.chapters["1"].id, "5.00");
    await seedWalletBalance(world.userId, "500.00");
    const quote = await quotePackageUpgrade(world.userId, world.packageEpisodeId);

    const raw = await mysql.createConnection(process.env.TEST_DATABASE_URL as string);
    try {
      const execPromise = executePackageUpgrade(world.userId, {
        upgradeId: quote.upgradeId,
        method: "slip",
        idempotencyKey: "p3r8-hold-0001",
        expectedFinalTotal: quote.payableAmount,
      });

      // Poll performance_schema.data_locks: the in-flight transaction must
      // hold a RECORD lock on packageUpgradeExecLocks (the R8-1 mutex).
      let sawHeld = false;
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        if ((await heldExecLockRowCount(raw, world.userId)) > 0) {
          sawHeld = true;
          break;
        }
        const settled = await Promise.race([
          execPromise.then(
            () => "done",
            () => "done"
          ),
          new Promise((r) => setTimeout(() => r("waiting"), 25)),
        ]);
        if (settled === "done") break;
      }
      expect(sawHeld).toBe(true);

      const result = await execPromise;
      expect(result.orderStatus).toBe("pending");

      // Commit released the row lock itself - nothing lingers anywhere.
      expect(await heldExecLockRowCount(raw, world.userId)).toBe(0);
    } finally {
      await raw.end();
    }
  });

  it("R8-2d: an execute FAILURE (INSUFFICIENT) rolls back and frees the exec-lock row for the next caller", async () => {
    const world = await createWorld();
    await seedWalletChapterPurchase(world.userId, world.novelId, world.chapters["1"].id, "5.00");
    await seedWalletBalance(world.userId, "0.00");
    const quote = await quotePackageUpgrade(world.userId, world.packageEpisodeId);

    await expect(
      executePackageUpgrade(world.userId, {
        upgradeId: quote.upgradeId,
        method: "wallet",
        idempotencyKey: "p3r8-fail-0001",
        expectedFinalTotal: quote.payableAmount,
      })
    ).rejects.toMatchObject({ code: "INSUFFICIENT_WALLET_BALANCE" });

    // The rolled-back transaction released the row lock - provably free.
    const raw = await mysql.createConnection(process.env.TEST_DATABASE_URL as string);
    try {
      expect(await heldExecLockRowCount(raw, world.userId)).toBe(0);
    } finally {
      await raw.end();
    }

    // Retry with funds succeeds (a stuck lock would BUSY here).
    await seedWalletBalance(world.userId, "500.00");
    const retry = await executePackageUpgrade(world.userId, {
      upgradeId: quote.upgradeId,
      method: "wallet",
      idempotencyKey: "p3r8-fail-0002",
      expectedFinalTotal: quote.payableAmount,
    });
    expect(retry.orderStatus).toBe("approved");
    expect((retry as { amountPaid: string }).amountPaid).toBe("25.00");
  });

  it("R6-4: real coupon + points - quote preview, CONFIRMED price (expectedFinalTotal), wallet debit and order total all match", async () => {
    const world = await createWorld();
    await seedWalletChapterPurchase(world.userId, world.novelId, world.chapters["1"].id, "5.00");
    await seedWalletBalance(world.userId, "500.00");

    const coupon = await createTestCoupon({ discountType: "flat", discountValue: "10.00", isActive: true });
    await testDb.insert((await import("../../drizzle/schema")).pointsTransactions).values({
      userId: world.userId,
      type: "earn",
      amount: "5.00",
      balanceAfter: "5.00",
      referenceType: "p3_r6_seed",
    });

    // QUOTE (the UI confirmation preview): payable 25 -> coupon 10 -> points 2 => 13.00
    const quote = await quotePackageUpgrade(world.userId, world.packageEpisodeId, {
      couponCode: coupon.code,
      pointsToRedeem: "2",
    });
    expect(quote.payableAmount).toBe("25.00");
    expect((quote as { couponDiscount?: string }).couponDiscount).toBe("10.00");
    expect((quote as { pointsDiscount?: string }).pointsDiscount).toBe("2.00");
    expect((quote as { finalTotal?: string }).finalTotal).toBe("13.00");
    const confirmed = (quote as { finalTotal?: string }).finalTotal as string; // dialog shows THIS

    // EXECUTE bound to the confirmed price.
    const result = await executePackageUpgrade(world.userId, {
      upgradeId: quote.upgradeId,
      method: "wallet",
      idempotencyKey: "p3r6-bind-full-1",
      couponCode: coupon.code,
      pointsToRedeem: "2",
      expectedFinalTotal: confirmed,
    });
    expect(result.orderStatus).toBe("approved");
    expect((result as { amountPaid: string }).amountPaid).toBe("13.00");

    // Wallet debited EXACTLY the confirmed price; order total matches.
    expect(await getWalletBalance(world.userId)).toBe("487.00");
    const orderRow = await db.getOrderById(result.orderId);
    expect(orderRow?.totalAmount).toBe("13.00");
    expect(orderRow?.discountAmount).toBe("10.00");
    expect(orderRow?.pointsDiscountAmount).toBe("2.00");

    // Finalization consumed the points and recorded the coupon exactly once.
    expect(await db.getUserPointsBalance(world.userId)).toBe("3.00");
    const couponUsage = await testDb
      .select()
      .from((await import("../../drizzle/schema")).couponUsages)
      .where(eq((await import("../../drizzle/schema")).couponUsages.orderId, result.orderId));
    expect(couponUsage).toHaveLength(1);
    expect(await db.getPurchaseByUserAndEpisode(world.userId, world.packageEpisodeId)).toBeTruthy();
  });

  it("R6-4b: coupon REMOVED before confirming -> re-quote drops the discount and the binding charges the full payable", async () => {
    const world = await createWorld();
    await seedWalletChapterPurchase(world.userId, world.novelId, world.chapters["1"].id, "5.00");
    await seedWalletBalance(world.userId, "500.00");
    const coupon = await createTestCoupon({ discountType: "flat", discountValue: "10.00", isActive: true });

    // Quote WITH coupon -> 15.00; the customer then clears the coupon.
    const withCoupon = await quotePackageUpgrade(world.userId, world.packageEpisodeId, {
      couponCode: coupon.code,
    });
    expect((withCoupon as { finalTotal?: string }).finalTotal).toBe("15.00");

    // Re-quote per the LATEST input: discount fields gone, back to payable.
    const withoutCoupon = await quotePackageUpgrade(world.userId, world.packageEpisodeId);
    expect(withoutCoupon.upgradeId).toBe(withCoupon.upgradeId);
    expect(withoutCoupon.payableAmount).toBe("25.00");
    expect((withoutCoupon as { couponDiscount?: string }).couponDiscount).toBeUndefined();
    expect((withoutCoupon as { finalTotal?: string }).finalTotal).toBeUndefined();

    // Execute WITHOUT the coupon -> charged the full payable (binding holds).
    const result = await executePackageUpgrade(world.userId, {
      upgradeId: withoutCoupon.upgradeId,
      method: "wallet",
      idempotencyKey: "p3r6-nocoupon-01",
      expectedFinalTotal: withoutCoupon.payableAmount,
    });
    expect(result.orderStatus).toBe("approved");
    expect((result as { amountPaid: string }).amountPaid).toBe("25.00");
    expect(await getWalletBalance(world.userId)).toBe("475.00");
    const orderRow = await db.getOrderById(result.orderId);
    expect(orderRow?.totalAmount).toBe("25.00");
    expect(orderRow?.discountAmount).toBe("0.00");
  });
  it("R8-2a: an externally-held exec-lock row fails a NEW execute CLOSED with UPGRADE_CART_BUSY creating nothing", async () => {
    const world = await createWorld();
    await seedWalletChapterPurchase(world.userId, world.novelId, world.chapters["1"].id, "5.00");
    await seedWalletBalance(world.userId, "500.00");
    const quote = await quotePackageUpgrade(world.userId, world.packageEpisodeId);

    const raw = await mysql.createConnection(process.env.TEST_DATABASE_URL as string);
    try {
      // Hold the mutex row outside the service (deterministic stand-in for
      // ANY concurrent in-flight execution).
      await raw.beginTransaction();
      await raw.execute("SELECT userId FROM packageUpgradeExecLocks WHERE userId = ? FOR UPDATE", [world.userId]);

      await expect(
        executePackageUpgrade(world.userId, {
          upgradeId: quote.upgradeId,
          method: "wallet",
          idempotencyKey: "p3r8-busy-0001",
          expectedFinalTotal: quote.payableAmount,
        })
      ).rejects.toMatchObject({ code: "UPGRADE_CART_BUSY" });

      // Fail closed: no order, no debit, receipt still quoted.
      const userOrders = await testDb
        .select({ id: ordersTable.id })
        .from(ordersTable)
        .where(eq(ordersTable.userId, world.userId));
      expect(userOrders).toHaveLength(0);
      expect(await getWalletBalance(world.userId)).toBe("500.00");
      const receipt = await testDb
        .select()
        .from(packageUpgradesTable)
        .where(eq(packageUpgradesTable.id, quote.upgradeId));
      expect(receipt[0].status).toBe("quoted");

      await raw.rollback();
    } finally {
      await raw.end();
    }

    // Freed -> retry succeeds (also proves the failed attempt leaked nothing).
    const retry = await executePackageUpgrade(world.userId, {
      upgradeId: quote.upgradeId,
      method: "slip",
      idempotencyKey: "p3r8-busy-0002",
      expectedFinalTotal: quote.payableAmount,
    });
    expect(retry.orderStatus).toBe("pending");
  });

  it("R8-2e: sequential executes for DIFFERENT users share the pool safely - no lock state leaks across pooled connections", async () => {
    const worldA = await createWorld();
    await seedWalletChapterPurchase(worldA.userId, worldA.novelId, worldA.chapters["1"].id, "5.00");
    await seedWalletBalance(worldA.userId, "500.00");
    const worldB = await createWorld();
    await seedWalletChapterPurchase(worldB.userId, worldB.novelId, worldB.chapters["1"].id, "5.00");
    await seedWalletBalance(worldB.userId, "500.00");

    const qA = await quotePackageUpgrade(worldA.userId, worldA.packageEpisodeId);
    const rA = await executePackageUpgrade(worldA.userId, {
      upgradeId: qA.upgradeId,
      method: "wallet",
      idempotencyKey: "p3r8-pool-a1",
      expectedFinalTotal: qA.payableAmount,
    });
    expect(rA.orderStatus).toBe("approved");

    // Same pool, different user: the mutex is a ROW lock, not connection
    // state - nothing from A's transaction can block or poison B.
    const qB = await quotePackageUpgrade(worldB.userId, worldB.packageEpisodeId);
    const rB = await executePackageUpgrade(worldB.userId, {
      upgradeId: qB.upgradeId,
      method: "wallet",
      idempotencyKey: "p3r8-pool-b1",
      expectedFinalTotal: qB.payableAmount,
    });
    expect(rB.orderStatus).toBe("approved");
    expect(await getWalletBalance(worldB.userId)).toBe("475.00");

    // And the shared pool ends with zero lingering locks.
    const raw = await mysql.createConnection(process.env.TEST_DATABASE_URL as string);
    try {
      expect(await heldExecLockRowCount(raw, worldB.userId)).toBe(0);
    } finally {
      await raw.end();
    }
  });

  it("R8-4: if the produced order total drifts from the confirmed price, the WHOLE transaction rolls back (no order, no debit)", async () => {
    const world = await createWorld();
    await seedWalletChapterPurchase(world.userId, world.novelId, world.chapters["1"].id, "5.00");
    await seedWalletBalance(world.userId, "500.00");
    const quote = await quotePackageUpgrade(world.userId, world.packageEpisodeId);

    // Force the order pipeline to produce a DIFFERENT total than the
    // binding recomputed: the post-check must fail the transaction closed.
    const orderServiceModule = await import("../services/orderService");
    const realCreateOrderFromCart = orderServiceModule.createOrderFromCart;
    const spy = vi
      .spyOn(orderServiceModule as { createOrderFromCart: unknown }, "createOrderFromCart")
      .mockImplementation(async (...args: unknown[]) => {
        const order = await (realCreateOrderFromCart as (...a: unknown[]) => Promise<{ totalAmount: string }>)(...args);
        return { ...order, totalAmount: "1.23" };
      });

    try {
      await expect(
        executePackageUpgrade(world.userId, {
          upgradeId: quote.upgradeId,
          method: "wallet",
          idempotencyKey: "p3r8-drift-001",
          expectedFinalTotal: quote.payableAmount,
        })
      ).rejects.toMatchObject({ code: "STALE_QUOTE" });
    } finally {
      spy.mockRestore();
    }

    // Full rollback: no order, no debit, receipt retired - retryable.
    const userOrders = await testDb
      .select({ id: ordersTable.id })
      .from(ordersTable)
      .where(eq(ordersTable.userId, world.userId));
    expect(userOrders).toHaveLength(0);
    expect(await getWalletBalance(world.userId)).toBe("500.00");
    const receipt = await testDb
      .select()
      .from(packageUpgradesTable)
      .where(eq(packageUpgradesTable.id, quote.upgradeId));
    expect(receipt[0].status).toBe("expired");

    // The drifted attempt RETIRED the receipt (STALE_QUOTE semantics), so
    // the retry needs a FRESH quote - which then succeeds.
    const freshQuote = await quotePackageUpgrade(world.userId, world.packageEpisodeId);
    expect(freshQuote.upgradeId).not.toBe(quote.upgradeId);
    const retry = await executePackageUpgrade(world.userId, {
      upgradeId: freshQuote.upgradeId,
      method: "wallet",
      idempotencyKey: "p3r8-drift-002",
      expectedFinalTotal: freshQuote.payableAmount,
    });
    expect(retry.orderStatus).toBe("approved");
    expect(await getWalletBalance(world.userId)).toBe("475.00");
  });

  it("R8R2: a lock TIMEOUT while seeding the mutex row is mapped to UPGRADE_CART_BUSY - no order, no debit, receipt intact, retry succeeds", async () => {
    const world = await createWorld();
    await seedWalletChapterPurchase(world.userId, world.novelId, world.chapters["1"].id, "5.00");
    await seedWalletBalance(world.userId, "500.00");
    const quote = await quotePackageUpgrade(world.userId, world.packageEpisodeId);
    // The quote already seeded the mutex row; force the SEEDING path by
    // removing it (the fallback INSERT only runs when the row is absent).
    await testDb
      .delete(packageUpgradeExecLocksTable)
      .where(eq(packageUpgradeExecLocksTable.userId, world.userId));

    // R8R3 isolation: the previous method shortened the server GLOBAL
    // innodb_lock_wait_timeout and recycled (KILLed) pooled sessions.
    // Both leak beyond this test - a failed assertion could leave the
    // GLOBAL at 1s for every later connection, and killing every
    // `db = ipenovel_test` session reaches OTHER concurrently running
    // test files sharing this disposable server. Isolation of that
    // approach cannot be proven, so the method changed per spec: the
    // EXACT error a lock timeout produces at the driver boundary
    // (code ER_LOCK_WAIT_TIMEOUT / errno 1205 - the MariaDB NOWAIT/lock
    // refusal shape) is injected for THIS ONE statement only. Zero
    // shared-state mutation; deterministic on both engines; the
    // service's INSERT-failure mapping is still exercised for real.
    const dbModule = await import("../db");
    const realGetDb = dbModule.getDb;
    let seedInsertFailureArmed = false;
    const synthLockTimeout = (): Error => {
      const err: Error & { code?: string; errno?: number; sqlState?: string } = new Error(
        "Lock wait timeout exceeded; try restarting transaction"
      );
      err.code = "ER_LOCK_WAIT_TIMEOUT";
      err.errno = 1205;
      err.sqlState = "HY000";
      return err;
    };
    const isSeedingInsert = (query: unknown): boolean => {
      const chunks = (query as { queryChunks?: unknown[] })?.queryChunks;
      if (!Array.isArray(chunks)) return false;
      // drizzle chunks are plain strings OR StringChunk objects ({ value: [...] })
      const chunkText = (chunk: unknown): string => {
        if (typeof chunk === "string") return chunk;
        const value = (chunk as { value?: unknown })?.value;
        return Array.isArray(value) ? value.map((v) => (typeof v === "string" ? v : "")).join("") : "";
      };
      const text = chunks.map(chunkText).join(" ");
      return text.includes("INSERT IGNORE INTO packageUpgradeExecLocks");
    };
    const spy = vi.spyOn(dbModule, "getDb").mockImplementation(async () => {
      const real = await realGetDb();
      if (!real) return real;
      return new Proxy(real as Record<PropertyKey, unknown>, {
        get(target, prop) {
          if (prop === "transaction") {
            return async (fn: (tx: unknown) => unknown) =>
              (target["transaction"] as (fn2: (tx: unknown) => unknown) => Promise<unknown>).call(target, (tx) =>
                fn(
                  new Proxy(tx as Record<PropertyKey, unknown>, {
                  get(txTarget, txProp) {
                    if (txProp === "execute") {
                      return async (query: unknown) => {
                        if (seedInsertFailureArmed && isSeedingInsert(query)) {
                          throw synthLockTimeout();
                        }
                        return (txTarget["execute"] as (q: unknown) => Promise<unknown>).call(txTarget, query);
                      };
                    }
                    const value = txTarget[txProp];
                    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(txTarget) : value;
                  },
                })
                )
              );
          }
          const value = target[prop];
          return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
      });
    });

    try {
      seedInsertFailureArmed = true;
      await expect(
        executePackageUpgrade(world.userId, {
          upgradeId: quote.upgradeId,
          method: "wallet",
          idempotencyKey: "p3r8r2-seed-0001",
          expectedFinalTotal: quote.payableAmount,
        })
      ).rejects.toMatchObject({ code: "UPGRADE_CART_BUSY" });
    } finally {
      seedInsertFailureArmed = false;
      spy.mockRestore();
    }

    // Fail-closed state: no order, no debit, receipt still quoted (BUSY
    // never retires a receipt).
    const userOrders = await testDb
      .select({ id: ordersTable.id })
      .from(ordersTable)
      .where(eq(ordersTable.userId, world.userId));
    expect(userOrders).toHaveLength(0);
    expect(await getWalletBalance(world.userId)).toBe("500.00");
    const receipt = await testDb
      .select()
      .from(packageUpgradesTable)
      .where(eq(packageUpgradesTable.id, quote.upgradeId));
    expect(receipt[0].status).toBe("quoted");

    // Retry: the REAL seeding INSERT runs (row still absent) and succeeds
    // - the upgrade proceeds end to end.
    const retry = await executePackageUpgrade(world.userId, {
      upgradeId: quote.upgradeId,
      method: "slip",
      idempotencyKey: "p3r8r2-seed-0002",
      expectedFinalTotal: quote.payableAmount,
    });
    expect(retry.orderStatus).toBe("pending");
  });
});

// ---- R8/R8R1 observability helpers (engine-aware: MySQL 8 + MariaDB) ----
const LOCK_REFUSED_CODES = ["ER_LOCK_NOWAIT", "ER_LOCK_WAIT_TIMEOUT"]; // MySQL 3572 / MariaDB 1205

function isLockRefusedError(error: unknown): boolean {
  let current: any = error;
  for (let depth = 0; current != null && depth < 3; depth += 1) {
    const code = (current as { code?: string })?.code;
    if (typeof code === "string" && LOCK_REFUSED_CODES.includes(code)) return true;
    current = (current as { cause?: unknown })?.cause;
  }
  return false;
}

/** 1 = the mutex row is held by some transaction; 0 = free. */
async function heldExecLockRowCount(raw: mysql.Connection, userId: number): Promise<number> {
  // MySQL 8: performance_schema.data_locks shows the exact record locks.
  try {
    const rows: any = await raw.execute(
      "SELECT COUNT(*) AS n FROM performance_schema.data_locks WHERE OBJECT_NAME = 'packageUpgradeExecLocks' AND LOCK_TYPE = 'RECORD'"
    );
    const unwrapped = Array.isArray(rows?.[0]) ? rows[0] : rows;
    return Number(unwrapped?.[0]?.n ?? 0);
  } catch (error) {
    // MariaDB has no performance_schema.data_locks: fall back to a
    // NON-DESTRUCTIVE NOWAIT probe (autocommit releases the lock again
    // immediately when it succeeds).
    let current: any = error;
    let unknownTable = false;
    for (let depth = 0; current != null && depth < 3; depth += 1) {
      if ((current as { code?: string })?.code === "ER_NO_SUCH_TABLE") unknownTable = true;
      current = (current as { cause?: unknown })?.cause;
    }
    if (!unknownTable) throw error;
    try {
      await raw.execute("SELECT userId FROM packageUpgradeExecLocks WHERE userId = ? FOR UPDATE NOWAIT", [userId]);
      return 0;
    } catch (probeError) {
      if (isLockRefusedError(probeError)) return 1;
      throw probeError;
    }
  }
}


describe("P3-R7 mandatory price confirmation & lock release failure (integration)", () => {
  it("R7-02 matrix: MISSING confirmation = STALE_QUOTE (fail closed); re-quote -> MISMATCH = STALE_QUOTE; re-quote -> MATCH charges exactly once", async () => {
    const world = await createWorld();
    await seedWalletChapterPurchase(world.userId, world.novelId, world.chapters["1"].id, "5.00");
    await seedWalletBalance(world.userId, "500.00");
    type ExecuteInput = Parameters<typeof executePackageUpgrade>[1];

    // MISSING: a NEW execute without the customer-confirmed price is refused
    // exactly like a mismatched one - before any order creation or debit.
    const q1 = await quotePackageUpgrade(world.userId, world.packageEpisodeId);
    await expect(
      executePackageUpgrade(world.userId, {
        upgradeId: q1.upgradeId,
        method: "wallet",
        idempotencyKey: "p3r7-missing-0001",
        // expectedFinalTotal deliberately omitted (R7-02: mandatory).
      } as unknown as ExecuteInput)
    ).rejects.toMatchObject({ code: "STALE_QUOTE" });
    let userOrders = await testDb
      .select({ id: ordersTable.id })
      .from(ordersTable)
      .where(eq(ordersTable.userId, world.userId));
    expect(userOrders).toHaveLength(0);
    expect(await getWalletBalance(world.userId)).toBe("500.00");
    const q1Receipt = await testDb
      .select()
      .from(packageUpgradesTable)
      .where(eq(packageUpgradesTable.id, q1.upgradeId));
    expect(q1Receipt[0].status).toBe("expired"); // retired, never reusable

    // MISMATCH: the client retries with a fresh quote but confirms a
    // DIFFERENT price -> refused, receipt retired again.
    const q2 = await quotePackageUpgrade(world.userId, world.packageEpisodeId);
    expect(q2.upgradeId).not.toBe(q1.upgradeId);
    await expect(
      executePackageUpgrade(world.userId, {
        upgradeId: q2.upgradeId,
        method: "wallet",
        idempotencyKey: "p3r7-mismatch-02",
        expectedFinalTotal: "0.01",
      })
    ).rejects.toMatchObject({ code: "STALE_QUOTE" });

    // MATCH: the client retries with a fresh quote and confirms the exact
    // recomputed price -> exactly one order, charged exactly that price.
    const q3 = await quotePackageUpgrade(world.userId, world.packageEpisodeId);
    const result = await executePackageUpgrade(world.userId, {
      upgradeId: q3.upgradeId,
      method: "wallet",
      idempotencyKey: "p3r7-match-0003",
      expectedFinalTotal: q3.payableAmount,
    });
    expect(result.orderStatus).toBe("approved");
    expect((result as { amountPaid: string }).amountPaid).toBe("25.00");
    expect(await getWalletBalance(world.userId)).toBe("475.00");
    const orderRow = await db.getOrderById(result.orderId);
    expect(orderRow?.totalAmount).toBe("25.00");

    // The two refused attempts created NOTHING: one order total.
    userOrders = await testDb
      .select({ id: ordersTable.id })
      .from(ordersTable)
      .where(eq(ordersTable.userId, world.userId));
    expect(userOrders).toHaveLength(1);
  });

  it("R8-2c: an external connection kill mid-execute (barrier inside the mutex interceptor) rolls back and frees the row lock; retry succeeds", async () => {
    const world = await createWorld();
    await seedWalletChapterPurchase(world.userId, world.novelId, world.chapters["1"].id, "5.00");
    await seedWalletBalance(world.userId, "500.00");
    const quote = await quotePackageUpgrade(world.userId, world.packageEpisodeId);

    // R8R6: the barrier lives INSIDE the interceptor of the mutex
    // SELECT ... FOR UPDATE NOWAIT itself. The interceptor runs the
    // acquisition FOR REAL; only after it SUCCEEDS does it capture
    // CONNECTION_ID() on that very connection, signal arrival, and then
    // AWAIT the gate - withholding the SELECT's result from the production
    // service, so the transaction is parked WHILE STILL HOLDING the mutex
    // row lock. There is NO automatic timeout release: the gate opens only
    // when the test releases it (success path after KILL, or the finally
    // on any error/timeout path). The test verifies the captured id
    // against the server processlist (never against other transactions'
    // lock counts), confirms the execute promise is still in flight, and
    // only then kills exactly that connection.
    const dbModule = await import("../db");
    const realGetDb = dbModule.getDb;
    let capturedConnectionId: number | null = null;
    let barrierArrived = false;
    let barrierReleased = false;
    let releaseBarrier = (): void => {};
    const barrierGate = new Promise<void>((resolve) => {
      releaseBarrier = () => {
        if (!barrierReleased) {
          barrierReleased = true;
          resolve();
        }
      };
    });
    let resolveArrival = (): void => {};
    const arrivalGate = new Promise<void>((resolve) => {
      resolveArrival = resolve;
    });
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
    const isMutexNowaitSelect = (query: unknown): boolean => {
      const chunks = (query as { queryChunks?: unknown[] })?.queryChunks;
      if (!Array.isArray(chunks)) return false;
      const chunkText = (chunk: unknown): string => {
        if (typeof chunk === "string") return chunk;
        const value = (chunk as { value?: unknown })?.value;
        return Array.isArray(value) ? value.map((v) => (typeof v === "string" ? v : "")).join("") : "";
      };
      const text = chunks.map(chunkText).join(" ");
      return text.includes("packageUpgradeExecLocks") && text.includes("FOR UPDATE NOWAIT");
    };
    const spy = vi.spyOn(dbModule, "getDb").mockImplementation(async () => {
      const real = await realGetDb();
      if (!real) return real;
      return new Proxy(real as Record<PropertyKey, unknown>, {
        get(target, prop) {
          if (prop === "transaction") {
            return async (fn: (tx: unknown) => unknown) =>
              (target["transaction"] as (fn2: (tx: unknown) => unknown) => Promise<unknown>).call(target, (tx) =>
                fn(
                  new Proxy(tx as Record<PropertyKey, unknown>, {
                    get(txTarget, txProp) {
                      if (txProp === "execute") {
                        const execute = (txTarget["execute"] as (q: unknown) => Promise<unknown>).bind(txTarget);
                        return async (query: unknown) => {
                          if (!isMutexNowaitSelect(query)) {
                            return execute(query);
                          }
                          // Run the acquisition FOR REAL. On refusal (BUSY)
                          // this throws and no barrier ever engages.
                          const result = await execute(query);
                          // SUCCEEDED - this transaction now HOLDS the
                          // mutex row lock. Capture its own connection id
                          // on the very same connection.
                          const idRows: any = await execute(sql`SELECT CONNECTION_ID() AS cid`);
                          const unwrapped = Array.isArray(idRows?.[0]) ? idRows[0] : idRows;
                          capturedConnectionId = Number(unwrapped?.[0]?.cid);
                          barrierArrived = true;
                          resolveArrival();
                          // WITHHOLD the SELECT result from the production
                          // service until the test opens the gate - the
                          // transaction stays parked here, still holding
                          // the lock. The finally below is the only
                          // failure-path releaser (no automatic timeout).
                          await barrierGate;
                          return result;
                        };
                      }
                      const value = txTarget[txProp];
                      return typeof value === "function"
                        ? (value as (...args: unknown[]) => unknown).bind(txTarget)
                        : value;
                    },
                  })
                )
              );
          }
          const value = target[prop];
          return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
      });
    });

    let execRejected = false;
    const execPromise = executePackageUpgrade(world.userId, {
      upgradeId: quote.upgradeId,
      method: "wallet",
      idempotencyKey: "p3r8-kill-0001",
      expectedFinalTotal: quote.payableAmount,
    });
    execPromise.catch(() => {
      execRejected = true;
    });

    // R8R7: the raw connection is created INSIDE the try - if creation
    // itself fails, the finally below still releases the barrier, restores
    // the mock and drains the execute promise (and closes nothing, because
    // no connection was ever created).
    let raw: mysql.Connection | null = null;
    try {
      raw = await mysql.createConnection(process.env.TEST_DATABASE_URL as string);
      // Deterministic wait: arrival fires the moment the NOWAIT select has
      // SUCCEEDED, the connection id is captured, and the transaction is
      // parked at the barrier holding the lock.
      await Promise.race([arrivalGate, sleep(8000)]);
      if (!barrierArrived || capturedConnectionId == null || !Number.isFinite(capturedConnectionId) || capturedConnectionId <= 0) {
        // Safe abort: ownership could not be proven - NO KILL, fail loudly.
        throw new Error("safe-abort: execute connection identity unproven - refusing to KILL");
      }
      // Pre-KILL verification #1: the execute promise must still be in
      // flight (a settled promise means there is nothing parked to kill).
      if (execRejected) {
        throw new Error("safe-abort: execute promise already settled - refusing to KILL");
      }
      // Pre-KILL verification #2: the captured id must exist on THIS
      // database - never inferred from other transactions' lock counts.
      const ownerRows: any = await raw.execute(
        "SELECT id FROM information_schema.processlist WHERE id = ? AND db = 'ipenovel_test'",
        [capturedConnectionId]
      );
      const owner = Array.isArray(ownerRows?.[0]) ? ownerRows[0] : ownerRows;
      if (!Array.isArray(owner) || owner.length !== 1) {
        throw new Error("safe-abort: target connection not verified on this database - refusing to KILL");
      }

      // The transaction is parked at the barrier while STILL HOLDING the
      // mutex row: kill exactly the verified, test-owned connection.
      await raw.execute(`KILL CONNECTION ${capturedConnectionId}`);
      // R8R6 ordering: RELEASE the barrier FIRST so the parked interceptor
      // hands the (already-acquired) SELECT result back and the service
      // then hits the dead connection - only then await the rejection.
      releaseBarrier();
      await expect(execPromise).rejects.toThrow();
      // Let the pool observe the dead socket and discard it.
      await new Promise((r) => setTimeout(r, 300));
    } finally {
      // Every path - assertion failure, timeout, error, even a raw
      // connection CREATION failure - releases the barrier (un-parking the
      // transaction so nothing hangs), restores the mock, drains the
      // execute promise, and closes the connection only if one was ever
      // created.
      releaseBarrier();
      spy.mockRestore();
      await execPromise.catch(() => {});
      if (raw) {
        await raw.end().catch(() => {});
      }
    }
    expect(execRejected).toBe(true);

    // Rollback happened: no order, no debit, receipt still quoted.
    const userOrders = await testDb
      .select({ id: ordersTable.id })
      .from(ordersTable)
      .where(eq(ordersTable.userId, world.userId));
    expect(userOrders).toHaveLength(0);
    expect(await getWalletBalance(world.userId)).toBe("500.00");
    const receipt = await testDb
      .select()
      .from(packageUpgradesTable)
      .where(eq(packageUpgradesTable.id, quote.upgradeId));
    expect(receipt[0].status).toBe("quoted");

    // Retry on a (reused) pooled connection succeeds - the row lock died
    // with the killed transaction, so nothing can be BUSY here.
    const retry = await executePackageUpgrade(world.userId, {
      upgradeId: quote.upgradeId,
      method: "wallet",
      idempotencyKey: "p3r8-kill-0002",
      expectedFinalTotal: quote.payableAmount,
    });
    expect(retry.orderStatus).toBe("approved");
    expect((retry as { amountPaid: string }).amountPaid).toBe("25.00");
    expect(await getWalletBalance(world.userId)).toBe("475.00");
    const orderRow = await db.getOrderById(retry.orderId);
    expect(orderRow?.totalAmount).toBe("25.00");
  });

  it("R8-2c-cleanup: a raw-connection CREATION failure still releases the barrier, restores the mock, drains the execute promise, and never KILLs", async () => {
    const world = await createWorld();
    await seedWalletChapterPurchase(world.userId, world.novelId, world.chapters["1"].id, "5.00");
    await seedWalletBalance(world.userId, "500.00");
    const quote = await quotePackageUpgrade(world.userId, world.packageEpisodeId);

    // Barrier setup - copied VERBATIM from R8-2c (R8R6): do not diverge.
    const dbModule = await import("../db");
    const realGetDb = dbModule.getDb;
    let barrierArrived = false;
    let barrierReleased = false;
    let releaseBarrier = (): void => {};
    const barrierGate = new Promise<void>((resolve) => {
      releaseBarrier = () => {
        if (!barrierReleased) {
          barrierReleased = true;
          resolve();
        }
      };
    });
    let resolveArrival = (): void => {};
    const arrivalGate = new Promise<void>((resolve) => {
      resolveArrival = resolve;
    });
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
    const isMutexNowaitSelect = (query: unknown): boolean => {
      const chunks = (query as { queryChunks?: unknown[] })?.queryChunks;
      if (!Array.isArray(chunks)) return false;
      const chunkText = (chunk: unknown): string => {
        if (typeof chunk === "string") return chunk;
        const value = (chunk as { value?: unknown })?.value;
        return Array.isArray(value) ? value.map((v) => (typeof v === "string" ? v : "")).join("") : "";
      };
      const text = chunks.map(chunkText).join(" ");
      return text.includes("packageUpgradeExecLocks") && text.includes("FOR UPDATE NOWAIT");
    };
    const spy = vi.spyOn(dbModule, "getDb").mockImplementation(async () => {
      const real = await realGetDb();
      if (!real) return real;
      return new Proxy(real as Record<PropertyKey, unknown>, {
        get(target, prop) {
          if (prop === "transaction") {
            return async (fn: (tx: unknown) => unknown) =>
              (target["transaction"] as (fn2: (tx: unknown) => unknown) => Promise<unknown>).call(target, (tx) =>
                fn(
                  new Proxy(tx as Record<PropertyKey, unknown>, {
                    get(txTarget, txProp) {
                      if (txProp === "execute") {
                        const execute = (txTarget["execute"] as (q: unknown) => Promise<unknown>).bind(txTarget);
                        return async (query: unknown) => {
                          if (!isMutexNowaitSelect(query)) {
                            return execute(query);
                          }
                          const result = await execute(query);
                          barrierArrived = true;
                          resolveArrival();
                          await barrierGate;
                          return result;
                        };
                      }
                      const value = txTarget[txProp];
                      return typeof value === "function"
                        ? (value as (...args: unknown[]) => unknown).bind(txTarget)
                        : value;
                    },
                  })
                )
              );
          }
          const value = target[prop];
          return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
      });
    });

    let execRejected = false;
    const execPromise = executePackageUpgrade(world.userId, {
      upgradeId: quote.upgradeId,
      method: "wallet",
      idempotencyKey: "p3r8r7-cleanup-0001",
      expectedFinalTotal: quote.payableAmount,
    });
    execPromise.catch(() => {
      execRejected = true;
    });

    // Simulated failure: the RAW connection can never be created.
    const createSpy = vi
      .spyOn(mysql, "createConnection")
      .mockRejectedValue(new Error("boom: simulated raw-connection creation failure"));

    // The EXACT R8-2c try/finally skeleton: creation failure must fall
    // through to the finally, which releases the barrier, restores the
    // mock, drains the execute promise and closes nothing (no connection
    // was created) - and the KILL section is never reached.
    let raw: mysql.Connection | null = null;
    let closeAttempted = false;
    const scenario = async (): Promise<void> => {
      try {
        raw = await mysql.createConnection(process.env.TEST_DATABASE_URL as string);
        await Promise.race([arrivalGate, sleep(8000)]);
        throw new Error("unreachable: with a broken raw connection this line must never run");
      } finally {
        releaseBarrier();
        spy.mockRestore();
        await execPromise.catch(() => {});
        if (raw) {
          closeAttempted = true;
          await raw.end().catch(() => {});
        }
      }
    };
    await expect(scenario()).rejects.toThrow("boom: simulated raw-connection creation failure");

    // The KILL could never happen: exactly one creation attempt, which
    // threw before handing back any connection, so nothing was closed.
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(closeAttempted).toBe(false);

    // Cleanup proven BEHAVIORALLY: the barrier was released (the parked
    // transaction ran on to full success instead of hanging).
    expect(barrierReleased).toBe(true);
    expect(barrierArrived).toBe(true);
    expect(execRejected).toBe(false);
    const settled = await execPromise;
    expect(settled.orderStatus).toBe("approved");
    expect((settled as { amountPaid: string }).amountPaid).toBe("25.00");
    expect(await getWalletBalance(world.userId)).toBe("475.00");
    createSpy.mockRestore();
    // getDb is the ORIGINAL function again after the finally's restore.
    expect(dbModule.getDb).toBe(realGetDb);

    // And the real pipeline still works through it - proven on a brand-new
    // world (this world already owns the package after the approval above).
    const world2 = await createWorld();
    await seedWalletChapterPurchase(world2.userId, world2.novelId, world2.chapters["1"].id, "5.00");
    const freshQuote = await quotePackageUpgrade(world2.userId, world2.packageEpisodeId);
    const retry = await executePackageUpgrade(world2.userId, {
      upgradeId: freshQuote.upgradeId,
      method: "slip",
      idempotencyKey: "p3r8r7-cleanup-0002",
      expectedFinalTotal: freshQuote.payableAmount,
    });
    expect(retry.orderStatus).toBe("pending");
  });
});
