import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACCOUNT_RECOVERY_INDIRECT_TABLES,
  ACCOUNT_RECOVERY_USER_DATA_CLASSIFICATION,
} from "./services/accountRecoveryDataClassification";

const root = path.resolve(import.meta.dirname);
const dbSource = fs.readFileSync(path.join(root, "db.ts"), "utf8");
const orderServiceSource = fs.readFileSync(path.join(root, "services", "orderService.ts"), "utf8");
const episodePurchaseSource = fs.readFileSync(path.join(root, "services", "episodePurchaseService.ts"), "utf8");
const approvalSource = fs.readFileSync(path.join(root, "services", "approvalService.ts"), "utf8");
const routersSource = fs.readFileSync(path.join(root, "routers.ts"), "utf8");
const ocrV1Source = fs.readFileSync(path.join(root, "ocr-slip-integration.ts"), "utf8");
const ocrV2Source = fs.readFileSync(path.join(root, "ocr-slip-integration-v2.ts"), "utf8");

/**
 * IPE-005 reflection coverage.
 *
 * The Account Recovery classification is itself reflection-checked against
 * drizzle/schema.ts by accountRecoveryDataClassification.test.ts. This test
 * consumes that authoritative classification instead of maintaining a second
 * hand-written list of "important" user tables. If a new economic/user-owned
 * user reference is added to the schema, the classification test forces it
 * into that inventory and THIS test then forces the Account Merge guard layer
 * to assign it a concrete production mutation boundary.
 */
const productionGuardEvidence: Record<string, string[]> = {
  orders: [
    "createOrder(data, guardedTx)",
    "withAccountMergeOrderMutationGuard(orderId",
    "assertAccountMergeClassifiedMutationAllowed(ctx.user.id, tx)",
  ],
  purchases: ["withAccountMergeClassifiedMutationGuard(userId, tx"],
  episodePurchases: ["assertAccountMergeClassifiedMutationAllowed(userId, tx)"],
  walletAccounts: [
    "getOrCreateWalletAccount(userId, guardedTx)",
    "assertAccountMergeClassifiedMutationAllowed(userId, tx)",
  ],
  walletTransactions: ["withAccountMergeClassifiedMutationGuard(userId, tx"],
  walletTopups: ["withAccountMergeWalletTopupMutationGuard(topupId"],
  topupLogs: ["withAccountMergeClassifiedMutationGuard(userId, undefined"],
  pointsTransactions: [
    "await writePointsTransactionUnderLock(data, tx)",
    "withUserPointsLock(data.userId, undefined",
  ],
  couponUsages: ["recordCouponUsage(couponId, userId, orderId, guardedTx)"],
  coupons: [
    "withAccountMergeClassifiedMutationGuard(ownerUserId, undefined",
    "assertAccountMergeClassifiedMutationsAllowed(ownerIds, tx)",
  ],
  sportsMatchVotes: [
    "lockSportsMatchForAccountMutation(matchId, tx)",
    "assertAccountMergeClassifiedMutationsAllowed(pendingUserIds, tx)",
  ],
  sportsMatchRewards: [
    "assertAccountMergeClassifiedMutationsAllowed(pendingUserIds, tx)",
    "markSportsRewardCouponUsed(couponId, userId, guardedTx)",
  ],
  dailyCheckinRewardGrants: ["assertAccountMergeClassifiedMutationAllowed(userId, tx)"],
  carts: ["withAccountMergeClassifiedMutationGuard(userId, undefined"],
  wishlists: ["withAccountMergeClassifiedMutationGuard(userId, undefined"],
  readingProgress: ["withAccountMergeClassifiedMutationGuard(data.userId, undefined"],
  dailyCheckins: ["assertAccountMergeClassifiedMutationAllowed(userId, tx)"],
  cartItems: ["withAccountMergeClassifiedMutationGuard(userId, undefined"],
  orderItems: ["withAccountMergeOrderMutationGuard(orderId, tx"],
  payments: ["withAccountMergePaymentMutationGuard(paymentId"],
  orderHistory: ["withAccountMergeOrderMutationGuard(data.orderId, tx"],
};

const allProductionSources = [
  dbSource,
  orderServiceSource,
  episodePurchaseSource,
  approvalSource,
  routersSource,
  ocrV1Source,
  ocrV2Source,
].join("\n");

function classifiedTableSet(): Set<string> {
  const direct = ACCOUNT_RECOVERY_USER_DATA_CLASSIFICATION
    .filter((entry) => entry.category === "economic_hard_block" || entry.category === "user_owned_hard_block")
    .map((entry) => entry.table);
  const indirect = ACCOUNT_RECOVERY_INDIRECT_TABLES.map((entry) => entry.table);
  return new Set([...direct, ...indirect]);
}

describe("IPE-005 classified mutation reflection coverage", () => {
  it("every reflected economic/user-owned direct or indirect table has a declared guard boundary, with no stale extras", () => {
    const classified = [...classifiedTableSet()].sort();
    const guarded = Object.keys(productionGuardEvidence).sort();
    expect(guarded).toEqual(classified);
  });

  it("every declared family has concrete guard evidence in production source", () => {
    for (const [table, anchors] of Object.entries(productionGuardEvidence)) {
      expect(anchors.length, `${table} must have at least one guard anchor`).toBeGreaterThan(0);
      for (const anchor of anchors) {
        expect(allProductionSources, `${table} is missing production guard anchor: ${anchor}`).toContain(anchor);
      }
    }
  });

  it("legacy/background OCR payment writers participate in the same payment-owner guard", () => {
    expect(approvalSource).toContain("withAccountMergePaymentMutationGuard(paymentId, tx");
    expect(ocrV1Source).toContain("ApprovalService.approvePaymentWithSource(");
    expect(ocrV1Source).toContain("updatePayment(");
    expect(ocrV2Source).toContain("withAccountMergePaymentMutationGuard(payment.id, undefined");
  });

  it("the sports cross-resource hierarchy is match first, then account guard", () => {
    const cast = dbSource.indexOf("export async function castSportsVote");
    const settle = dbSource.indexOf("export async function settleSportsMatch");
    const cancel = dbSource.indexOf("export async function cancelSportsMatch");
    for (const start of [cast, settle, cancel]) {
      expect(start).toBeGreaterThanOrEqual(0);
      const body = dbSource.slice(start, start + 6000);
      const matchLock = body.indexOf("lockSportsMatchForAccountMutation(matchId, tx)");
      const userLockCandidates = [
        body.indexOf("lockUserForPoints(userId, tx)"),
        body.indexOf("assertAccountMergeClassifiedMutationsAllowed("),
      ].filter((value) => value >= 0);
      expect(matchLock).toBeGreaterThanOrEqual(0);
      expect(userLockCandidates.length).toBeGreaterThan(0);
      const userLock = Math.min(...userLockCandidates);
      expect(userLock).toBeGreaterThan(matchLock);
    }
  });
});
