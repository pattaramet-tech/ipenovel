import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(
  path.resolve(import.meta.dirname, "db.ts"),
  "utf8"
);
const orderServiceSource = fs.readFileSync(
  path.resolve(import.meta.dirname, "services", "orderService.ts"),
  "utf8"
);
const routersSource = fs.readFileSync(
  path.resolve(import.meta.dirname, "routers.ts"),
  "utf8"
);

function bodyBetweenIn(text: string, startAnchor: string, endAnchor: string): string {
  const start = text.indexOf(startAnchor);
  const end = text.indexOf(endAnchor, start + startAnchor.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

function bodyBetween(startAnchor: string, endAnchor: string): string {
  return bodyBetweenIn(source, startAnchor, endAnchor);
}

describe("Account Merge shared mutation barrier", () => {
  it("ordinary classified mutations take shared user and guard-state locks", () => {
    const sharedUserLock = bodyBetween(
      "async function lockAccountMergeMutationUserRows",
      "export async function getAccountMergeCasesForSourceForUpdate"
    );
    const sharedCaseLock = bodyBetween(
      "async function getAccountMergeCasesForSourceForShare",
      "function assertNoActiveAccountMergeCase"
    );
    const mutationGuard = bodyBetween(
      "export async function assertAccountMergeClassifiedMutationsAllowed",
      "async function assertAccountMergePointsMutationAllowed"
    );

    expect(sharedUserLock).toContain("LOCK IN SHARE MODE");
    expect(sharedCaseLock).toContain("LOCK IN SHARE MODE");
    expect(mutationGuard).toContain(
      "lockAccountMergeMutationUserRows(userIds, tx)"
    );
    expect(mutationGuard).toContain(
      "getAccountMergeCasesForSourceForShare(sourceUserId, tx)"
    );
  });

  it("merge lifecycle and points balance mutations retain exclusive locks without shared-to-exclusive upgrades", () => {
    const lifecycleUserLock = bodyBetween(
      "export async function lockAccountMergeUserRows",
      "async function lockAccountMergeMutationUserRows"
    );
    const pointsGuards = bodyBetween(
      "export async function assertAccountMergePointsMutationsAllowed",
      "export async function assertAccountMergeClassifiedMutationAllowed"
    );

    expect(lifecycleUserLock).toContain("FOR UPDATE");
    expect(pointsGuards).toContain("assertNoAccountMergeSharedToExclusiveUpgrade(tx, ordered)");
    expect(pointsGuards).toContain("lockAccountMergeUserRows(ordered, tx)");
    expect(pointsGuards).toContain(
      "getAccountMergeCasesForSourceForUpdate(sourceUserId, tx)"
    );
    expect(pointsGuards).toContain("assertAccountMergePointsMutationsAllowed([userId], tx)");
  });

  it("point-capable production flows take the exclusive barrier before any nested points lock", () => {
    const orderGuard = bodyBetweenIn(
      orderServiceSource,
      "export async function lockAndRequireReviewablePayment",
      "async function approvePaymentInTx"
    );
    expect(orderGuard).toContain("orderCompletionMayMutatePoints(ownerOrder)");
    expect(orderGuard).toContain("await db.lockUserForPoints(ownerOrder.userId, tx)");
    expect(orderGuard).toContain("await db.assertAccountMergeClassifiedMutationAllowed(ownerOrder.userId, tx)");
    expect(orderGuard.indexOf("await db.lockUserForPoints(ownerOrder.userId, tx)")).toBeLessThan(
      orderGuard.indexOf("await db.lockPaymentForUpdate(paymentId, tx)")
    );

    const walletCheckout = bodyBetweenIn(
      routersSource,
      "walletCheckout: protectedProcedure",
      "orders: router("
    );
    expect(walletCheckout).toContain("checkoutMutatesPoints");
    expect(walletCheckout).toContain("await db.lockUserForPoints(ctx.user.id, tx)");
    expect(walletCheckout).toContain("await db.assertAccountMergeClassifiedMutationAllowed(ctx.user.id, tx)");

    const settle = bodyBetween("export async function settleSportsMatch", "export async function cancelSportsMatch");
    expect(settle).toContain("if (rewardKind === \"points\")");
    expect(settle).toContain("assertAccountMergePointsMutationsAllowed(pendingUserIds, tx)");

    const cancel = bodyBetween("export async function cancelSportsMatch", "export async function markSportsRewardCouponUsed");
    expect(cancel).toContain("assertAccountMergePointsMutationsAllowed");
    expect(cancel.indexOf("assertAccountMergePointsMutationsAllowed")).toBeLessThan(
      cancel.indexOf("await lockUserForPoints(vote.userId, tx)")
    );
  });
});
