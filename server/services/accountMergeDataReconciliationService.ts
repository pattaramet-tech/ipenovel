import { eq, sql } from "drizzle-orm";
import {
  accountMergeAuditLogs,
  accountMergeCases,
  accountMergeDataDedupeRecords,
  accountMergeDataReconciliations,
  accountMergeFinancialReconciliations,
  cartItems,
  carts,
  couponUsages,
  coupons,
  dailyCheckinRewardGrants,
  dailyCheckins,
  episodePurchases,
  orders,
  purchases,
  readingProgress,
  sportsMatchRewards,
  sportsMatchVotes,
  wishlists,
} from "../../drizzle/schema";
import * as db from "../db";

export const IPE007_FINANCIAL_HISTORY_TABLES = [
  "walletAccounts",
  "walletTransactions",
  "walletTopups",
  "topupLogs",
  "pointsTransactions",
] as const;

export const IPE007_HANDLED_DIRECT_TABLES = [
  "orders",
  "purchases",
  "episodePurchases",
  "couponUsages",
  "coupons",
  "sportsMatchVotes",
  "sportsMatchRewards",
  "dailyCheckinRewardGrants",
  "carts",
  "wishlists",
  "readingProgress",
  "dailyCheckins",
] as const;

export const IPE007_HANDLED_INDIRECT_TABLES = ["cartItems"] as const;
export const IPE007_PRESERVED_VIA_ORDER_TABLES = [
  "orderItems",
  "payments",
  "orderHistory",
] as const;

type DataFaultPoint =
  "after_entitlements" | "after_user_data" | "before_receipt";
let dataFaultForTests: DataFaultPoint | null = null;

export class AccountMergeDataError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "AccountMergeDataError";
  }
}

/** Test-only deterministic fault injection for proving transaction rollback. */
export function __setAccountMergeDataFaultForTests(
  point: DataFaultPoint | null
): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Account Merge data fault injection is test-only");
  }
  dataFaultForTests = point;
}

function maybeInjectDataFault(point: DataFaultPoint): void {
  if (dataFaultForTests === point) {
    throw new Error(`Injected Account Merge data failure at ${point}`);
  }
}

function unwrapRows(raw: any): any[] {
  const rows = Array.isArray(raw?.[0]) ? raw[0] : raw;
  return Array.isArray(rows) ? rows : [];
}

function assertPositiveInteger(value: number, fieldName: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new AccountMergeDataError(
      "INVALID_ARGUMENT",
      `${fieldName} must be a positive integer`
    );
  }
}

async function readMergeCase(caseId: number, database: any) {
  const rows = await database
    .select()
    .from(accountMergeCases)
    .where(eq(accountMergeCases.id, caseId))
    .limit(1);
  return rows[0];
}

async function lockMergeCase(caseId: number, tx: any) {
  const rows = unwrapRows(
    await tx.execute(
      sql`SELECT id, sourceUserId, targetUserId, status FROM accountMergeCases WHERE id = ${caseId} FOR UPDATE`
    )
  );
  return rows[0];
}

async function readDataReceipt(caseId: number, database: any) {
  // Locking/current read is required for standalone two-admin idempotency.
  // A transaction may establish a REPEATABLE READ snapshot before it waits
  // for the canonical participant/case locks; after the wait it must observe
  // the winner's committed receipt rather than attempt a duplicate insert.
  const rows = unwrapRows(
    await database.execute(
      sql`SELECT * FROM accountMergeDataReconciliations WHERE mergeCaseId = ${caseId} LIMIT 1 FOR UPDATE`
    )
  );
  return rows[0];
}

async function readFinancialReceipt(caseId: number, database: any) {
  // Same current-read rule for the IPE-006 prerequisite: if data
  // reconciliation waits behind a just-finishing financial transaction, it
  // must see that committed prerequisite after acquiring the locks.
  const rows = unwrapRows(
    await database.execute(
      sql`SELECT * FROM accountMergeFinancialReconciliations WHERE mergeCaseId = ${caseId} LIMIT 1 FOR UPDATE`
    )
  );
  return rows[0];
}

function timeValue(value: unknown): number {
  if (!value) return 0;
  const n = new Date(value as any).getTime();
  return Number.isFinite(n) ? n : 0;
}

function sourceReadingProgressWins(source: any, target: any): boolean {
  const sourceTuple = [
    timeValue(source.lastReadAt),
    Number(source.progressPercent ?? 0),
    Number(source.scrollPosition ?? 0),
    timeValue(source.updatedAt),
    Number(source.id),
  ];
  const targetTuple = [
    timeValue(target.lastReadAt),
    Number(target.progressPercent ?? 0),
    Number(target.scrollPosition ?? 0),
    timeValue(target.updatedAt),
    Number(target.id),
  ];
  for (let i = 0; i < sourceTuple.length; i += 1) {
    if (sourceTuple[i] !== targetTuple[i])
      return sourceTuple[i] > targetTuple[i];
  }
  return false;
}

function sourceCartItemWins(source: any, target: any): boolean {
  const sourceTime = timeValue(source.createdAt);
  const targetTime = timeValue(target.createdAt);
  if (sourceTime !== targetTime) return sourceTime > targetTime;
  return Number(source.id) > Number(target.id);
}

type DedupeRecord = {
  mergeCaseId: number;
  domain: string;
  /** Original row id owned by the merge Source before reconciliation. */
  sourceRowId: number;
  /** Original row id owned by the merge Target before reconciliation. */
  targetRowId: number;
  keySummary: string;
  /** Domain-specific survivor/removal facts; row-origin columns never encode liveness. */
  safeMetadata?: string | null;
};

type Summary = {
  ordersMoved: number;
  purchasesMoved: number;
  purchasesDeduped: number;
  episodePurchasesMoved: number;
  episodePurchasesDeduped: number;
  couponUsagesMoved: number;
  personalCouponsMoved: number;
  sportsVotesMoved: number;
  sportsRewardsMoved: number;
  dailyCheckinsMoved: number;
  dailyRewardGrantsMoved: number;
  cartMode: "none" | "reparented" | "consolidated";
  cartItemsMoved: number;
  cartItemsDeduped: number;
  wishlistsMoved: number;
  wishlistsDeduped: number;
  readingProgressMoved: number;
  readingProgressDeduped: number;
  readingProgressSourceWins: number;
  financialHistoryTouched: false;
  antiReplayTouched: false;
};

function createEmptySummary(): Summary {
  return {
    ordersMoved: 0,
    purchasesMoved: 0,
    purchasesDeduped: 0,
    episodePurchasesMoved: 0,
    episodePurchasesDeduped: 0,
    couponUsagesMoved: 0,
    personalCouponsMoved: 0,
    sportsVotesMoved: 0,
    sportsRewardsMoved: 0,
    dailyCheckinsMoved: 0,
    dailyRewardGrantsMoved: 0,
    cartMode: "none",
    cartItemsMoved: 0,
    cartItemsDeduped: 0,
    wishlistsMoved: 0,
    wishlistsDeduped: 0,
    readingProgressMoved: 0,
    readingProgressDeduped: 0,
    readingProgressSourceWins: 0,
    financialHistoryTouched: false,
    antiReplayTouched: false,
  };
}

async function assertNoAmbiguousRewardConflicts(
  sourceUserId: number,
  targetUserId: number,
  tx: any
): Promise<void> {
  const [
    sourceVotes,
    targetVotes,
    sourceCheckins,
    targetCheckins,
    sourceGrants,
    targetGrants,
  ] = await Promise.all([
    tx
      .select()
      .from(sportsMatchVotes)
      .where(eq(sportsMatchVotes.userId, sourceUserId)),
    tx
      .select()
      .from(sportsMatchVotes)
      .where(eq(sportsMatchVotes.userId, targetUserId)),
    tx
      .select()
      .from(dailyCheckins)
      .where(eq(dailyCheckins.userId, sourceUserId)),
    tx
      .select()
      .from(dailyCheckins)
      .where(eq(dailyCheckins.userId, targetUserId)),
    tx
      .select()
      .from(dailyCheckinRewardGrants)
      .where(eq(dailyCheckinRewardGrants.userId, sourceUserId)),
    tx
      .select()
      .from(dailyCheckinRewardGrants)
      .where(eq(dailyCheckinRewardGrants.userId, targetUserId)),
  ]);

  const targetMatchIds = new Set(
    targetVotes.map((row: any) => Number(row.matchId))
  );
  const voteConflict = sourceVotes.find((row: any) =>
    targetMatchIds.has(Number(row.matchId))
  );
  if (voteConflict) {
    throw new AccountMergeDataError(
      "SPORTS_VOTE_CONFLICT",
      `Both accounts already have a sports vote for match ${Number(voteConflict.matchId)}; merge must fail closed`
    );
  }

  const targetCheckinKeys = new Set(
    targetCheckins.map(
      (row: any) => `${String(row.checkinDate)}\u0000${String(row.campaignKey)}`
    )
  );
  const checkinConflict = sourceCheckins.find((row: any) =>
    targetCheckinKeys.has(
      `${String(row.checkinDate)}\u0000${String(row.campaignKey)}`
    )
  );
  if (checkinConflict) {
    throw new AccountMergeDataError(
      "DAILY_CHECKIN_CONFLICT",
      `Both accounts already have a daily check-in for ${String(checkinConflict.checkinDate)} / ${String(checkinConflict.campaignKey)}; reward semantics are ambiguous`
    );
  }

  // Treat NULL milestoneInstanceNumber as a semantic value for merge safety,
  // even though MySQL UNIQUE indexes permit many NULLs. Two rows for the same
  // rule+instance on the merged account would still represent duplicate reward
  // grants and must not be created merely by ownership re-parenting.
  const milestoneGrantKey = (row: any): string | null => {
    if (row.grantReason !== "milestone") return null;
    return `${Number(row.ruleId)}\u0000${row.milestoneInstanceNumber == null ? "NULL" : Number(row.milestoneInstanceNumber)}`;
  };
  const targetMilestoneGrantKeys = new Set(
    targetGrants
      .map(milestoneGrantKey)
      .filter((key: string | null): key is string => key !== null)
  );
  const grantConflict = sourceGrants.find((row: any) => {
    const key = milestoneGrantKey(row);
    return key !== null && targetMilestoneGrantKeys.has(key);
  });
  if (grantConflict) {
    throw new AccountMergeDataError(
      "DAILY_REWARD_CONFLICT",
      `Both accounts already have milestone reward grant rule ${Number(grantConflict.ruleId)} instance ${grantConflict.milestoneInstanceNumber == null ? "NULL" : Number(grantConflict.milestoneInstanceNumber)}; merge must fail closed`
    );
  }
}

async function reconcileEntitlementRows(
  caseId: number,
  sourceUserId: number,
  targetUserId: number,
  tx: any,
  dedupes: DedupeRecord[],
  summary: Summary
): Promise<void> {
  const sourcePurchases = await tx
    .select()
    .from(purchases)
    .where(eq(purchases.userId, sourceUserId));
  const targetPurchases = await tx
    .select()
    .from(purchases)
    .where(eq(purchases.userId, targetUserId));
  const [sourcePurchaseOrders, targetPurchaseOrders] = await Promise.all([
    tx
      .select({ id: orders.id, status: orders.status })
      .from(orders)
      .where(eq(orders.userId, sourceUserId)),
    tx
      .select({ id: orders.id, status: orders.status })
      .from(orders)
      .where(eq(orders.userId, targetUserId)),
  ]);
  const sourceOrderById = new Map<number, any>(
    sourcePurchaseOrders.map((row: any) => [Number(row.id), row])
  );
  const targetOrderById = new Map<number, any>(
    targetPurchaseOrders.map((row: any) => [Number(row.id), row])
  );
  const targetPurchaseByEpisode = new Map<number, any>(
    targetPurchases.map((row: any) => [Number(row.episodeId), row])
  );
  for (const row of sourcePurchases) {
    const target = targetPurchaseByEpisode.get(Number(row.episodeId));
    if (!target) {
      await tx
        .update(purchases)
        .set({ userId: targetUserId })
        .where(eq(purchases.id, row.id));
      summary.purchasesMoved += 1;
      continue;
    }

    if (Number(row.novelId) !== Number(target.novelId)) {
      throw new AccountMergeDataError(
        "PURCHASE_ENTITLEMENT_CONFLICT",
        `Duplicate purchase for episode ${Number(row.episodeId)} references different novel ids`
      );
    }

    const sourceOrder = sourceOrderById.get(Number(row.orderId));
    const targetOrder = targetOrderById.get(Number(target.orderId));
    if (!sourceOrder || !targetOrder) {
      throw new AccountMergeDataError(
        "PURCHASE_ORDER_MISSING",
        `Duplicate purchase for episode ${Number(row.episodeId)} has a missing or cross-owned order reference`
      );
    }

    const sourceApproved = sourceOrder.status === "approved";
    const targetApproved = targetOrder.status === "approved";
    let keptPurchaseId: number;
    let removedPurchaseId: number;
    let resolution: string;

    if (sourceApproved && !targetApproved) {
      // The Source row is the only reader-valid entitlement. Remove the
      // inaccessible Target duplicate first so the unique(userId, episodeId)
      // index permits re-parenting the valid Source purchase without changing
      // either order or its immutable history.
      await tx.delete(purchases).where(eq(purchases.id, target.id));
      await tx
        .update(purchases)
        .set({ userId: targetUserId })
        .where(eq(purchases.id, row.id));
      keptPurchaseId = Number(row.id);
      removedPurchaseId = Number(target.id);
      resolution = "source_approved_kept";
      summary.purchasesMoved += 1;
    } else if (targetApproved) {
      // Target already has a reader-valid entitlement. This also covers the
      // both-approved case deterministically by retaining the existing Target
      // row and preserving both parent orders/history unchanged.
      await tx.delete(purchases).where(eq(purchases.id, row.id));
      keptPurchaseId = Number(target.id);
      removedPurchaseId = Number(row.id);
      resolution = sourceApproved
        ? "both_approved_target_kept"
        : "target_approved_kept";
    } else {
      // Neither duplicate grants reader access today. Choosing one could
      // silently discard a future entitlement if either parent order later
      // becomes approved, so this ambiguous legacy state must fail closed.
      throw new AccountMergeDataError(
        "PURCHASE_ENTITLEMENT_CONFLICT",
        `Neither duplicate purchase for episode ${Number(row.episodeId)} is linked to an approved order`
      );
    }

    dedupes.push({
      mergeCaseId: caseId,
      domain: "purchases",
      sourceRowId: Number(row.id),
      targetRowId: Number(target.id),
      keySummary: `episode:${Number(row.episodeId)}`,
      safeMetadata: JSON.stringify({
        sourceOrderId: Number(row.orderId),
        sourceOrderStatus: String(sourceOrder.status),
        targetOrderId: Number(target.orderId),
        targetOrderStatus: String(targetOrder.status),
        novelId: Number(row.novelId),
        keptPurchaseId,
        removedPurchaseId,
        resolution,
      }),
    });
    summary.purchasesDeduped += 1;
  }

  const sourceEpisodePurchases = await tx
    .select()
    .from(episodePurchases)
    .where(eq(episodePurchases.userId, sourceUserId));
  const targetEpisodePurchases = await tx
    .select()
    .from(episodePurchases)
    .where(eq(episodePurchases.userId, targetUserId));
  const targetEpisodePurchaseByEpisode = new Map<number, any>(
    targetEpisodePurchases.map((row: any) => [Number(row.episodeId), row])
  );
  for (const row of sourceEpisodePurchases) {
    const target = targetEpisodePurchaseByEpisode.get(Number(row.episodeId));
    if (!target) {
      await tx
        .update(episodePurchases)
        .set({ userId: targetUserId })
        .where(eq(episodePurchases.id, row.id));
      summary.episodePurchasesMoved += 1;
      continue;
    }
    dedupes.push({
      mergeCaseId: caseId,
      domain: "episodePurchases",
      sourceRowId: Number(row.id),
      targetRowId: Number(target.id),
      keySummary: `episode:${Number(row.episodeId)}`,
      safeMetadata: JSON.stringify({
        sourceWalletTransactionId:
          row.walletTransactionId == null
            ? null
            : Number(row.walletTransactionId),
        targetWalletTransactionId:
          target.walletTransactionId == null
            ? null
            : Number(target.walletTransactionId),
        novelId: Number(row.novelId),
        sourcePricePaid: String(row.pricePaid),
        targetPricePaid: String(target.pricePaid),
      }),
    });
    await tx.delete(episodePurchases).where(eq(episodePurchases.id, row.id));
    summary.episodePurchasesDeduped += 1;
  }

  const sourceOrders = await tx
    .select({ id: orders.id })
    .from(orders)
    .where(eq(orders.userId, sourceUserId));
  if (sourceOrders.length > 0) {
    await tx
      .update(orders)
      .set({ userId: targetUserId })
      .where(eq(orders.userId, sourceUserId));
    summary.ordersMoved = sourceOrders.length;
  }

  const sourceCouponUsages = await tx
    .select({ id: couponUsages.id })
    .from(couponUsages)
    .where(eq(couponUsages.userId, sourceUserId));
  if (sourceCouponUsages.length > 0) {
    await tx
      .update(couponUsages)
      .set({ userId: targetUserId })
      .where(eq(couponUsages.userId, sourceUserId));
    summary.couponUsagesMoved = sourceCouponUsages.length;
  }

  const sourceCoupons = await tx
    .select({ id: coupons.id })
    .from(coupons)
    .where(eq(coupons.ownerUserId, sourceUserId));
  if (sourceCoupons.length > 0) {
    await tx
      .update(coupons)
      .set({ ownerUserId: targetUserId })
      .where(eq(coupons.ownerUserId, sourceUserId));
    summary.personalCouponsMoved = sourceCoupons.length;
  }

  const sourceVotes = await tx
    .select({ id: sportsMatchVotes.id })
    .from(sportsMatchVotes)
    .where(eq(sportsMatchVotes.userId, sourceUserId));
  if (sourceVotes.length > 0) {
    await tx
      .update(sportsMatchVotes)
      .set({ userId: targetUserId })
      .where(eq(sportsMatchVotes.userId, sourceUserId));
    summary.sportsVotesMoved = sourceVotes.length;
  }

  const sourceRewards = await tx
    .select({ id: sportsMatchRewards.id })
    .from(sportsMatchRewards)
    .where(eq(sportsMatchRewards.userId, sourceUserId));
  if (sourceRewards.length > 0) {
    await tx
      .update(sportsMatchRewards)
      .set({ userId: targetUserId })
      .where(eq(sportsMatchRewards.userId, sourceUserId));
    summary.sportsRewardsMoved = sourceRewards.length;
  }

  const sourceCheckins = await tx
    .select({ id: dailyCheckins.id })
    .from(dailyCheckins)
    .where(eq(dailyCheckins.userId, sourceUserId));
  if (sourceCheckins.length > 0) {
    await tx
      .update(dailyCheckins)
      .set({ userId: targetUserId })
      .where(eq(dailyCheckins.userId, sourceUserId));
    summary.dailyCheckinsMoved = sourceCheckins.length;
  }

  const sourceGrants = await tx
    .select({ id: dailyCheckinRewardGrants.id })
    .from(dailyCheckinRewardGrants)
    .where(eq(dailyCheckinRewardGrants.userId, sourceUserId));
  if (sourceGrants.length > 0) {
    await tx
      .update(dailyCheckinRewardGrants)
      .set({ userId: targetUserId })
      .where(eq(dailyCheckinRewardGrants.userId, sourceUserId));
    summary.dailyRewardGrantsMoved = sourceGrants.length;
  }
}

async function reconcileCart(
  caseId: number,
  sourceUserId: number,
  targetUserId: number,
  tx: any,
  dedupes: DedupeRecord[],
  summary: Summary
): Promise<void> {
  const sourceRows = await tx
    .select()
    .from(carts)
    .where(eq(carts.userId, sourceUserId))
    .limit(1);
  const targetRows = await tx
    .select()
    .from(carts)
    .where(eq(carts.userId, targetUserId))
    .limit(1);
  const sourceCart = sourceRows[0];
  const targetCart = targetRows[0];
  if (!sourceCart) return;

  if (!targetCart) {
    await tx
      .update(carts)
      .set({ userId: targetUserId })
      .where(eq(carts.id, sourceCart.id));
    summary.cartMode = "reparented";
    const sourceItems = await tx
      .select({ id: cartItems.id })
      .from(cartItems)
      .where(eq(cartItems.cartId, sourceCart.id));
    summary.cartItemsMoved = sourceItems.length;
    return;
  }

  summary.cartMode = "consolidated";
  const sourceItems = await tx
    .select()
    .from(cartItems)
    .where(eq(cartItems.cartId, sourceCart.id));
  const targetItems = await tx
    .select()
    .from(cartItems)
    .where(eq(cartItems.cartId, targetCart.id));
  const targetByEpisode = new Map<number, any>(
    targetItems.map((row: any) => [Number(row.episodeId), row])
  );

  for (const row of sourceItems) {
    const target = targetByEpisode.get(Number(row.episodeId));
    if (!target) {
      await tx
        .update(cartItems)
        .set({ cartId: targetCart.id })
        .where(eq(cartItems.id, row.id));
      summary.cartItemsMoved += 1;
      continue;
    }

    const sourceWins = sourceCartItemWins(row, target);
    if (sourceWins) {
      await tx
        .update(cartItems)
        .set({
          novelId: row.novelId,
          price: row.price,
          createdAt: row.createdAt,
        })
        .where(eq(cartItems.id, target.id));
    }
    dedupes.push({
      mergeCaseId: caseId,
      domain: "cartItems",
      sourceRowId: Number(row.id),
      targetRowId: Number(target.id),
      keySummary: `episode:${Number(row.episodeId)}`,
      safeMetadata: JSON.stringify({ sourceWonLatest: sourceWins }),
    });
    await tx.delete(cartItems).where(eq(cartItems.id, row.id));
    summary.cartItemsDeduped += 1;
  }

  await tx.delete(carts).where(eq(carts.id, sourceCart.id));
}

async function reconcileWishlist(
  caseId: number,
  sourceUserId: number,
  targetUserId: number,
  tx: any,
  dedupes: DedupeRecord[],
  summary: Summary
): Promise<void> {
  const sourceRows = await tx
    .select()
    .from(wishlists)
    .where(eq(wishlists.userId, sourceUserId));
  const targetRows = await tx
    .select()
    .from(wishlists)
    .where(eq(wishlists.userId, targetUserId));
  const targetByNovel = new Map<number, any>(
    targetRows.map((row: any) => [Number(row.novelId), row])
  );
  for (const row of sourceRows) {
    const target = targetByNovel.get(Number(row.novelId));
    if (!target) {
      await tx
        .update(wishlists)
        .set({ userId: targetUserId })
        .where(eq(wishlists.id, row.id));
      summary.wishlistsMoved += 1;
      continue;
    }
    dedupes.push({
      mergeCaseId: caseId,
      domain: "wishlists",
      sourceRowId: Number(row.id),
      targetRowId: Number(target.id),
      keySummary: `novel:${Number(row.novelId)}`,
      safeMetadata: null,
    });
    await tx.delete(wishlists).where(eq(wishlists.id, row.id));
    summary.wishlistsDeduped += 1;
  }
}

async function reconcileReadingProgress(
  caseId: number,
  sourceUserId: number,
  targetUserId: number,
  tx: any,
  dedupes: DedupeRecord[],
  summary: Summary
): Promise<void> {
  const sourceRows = await tx
    .select()
    .from(readingProgress)
    .where(eq(readingProgress.userId, sourceUserId));
  const targetRows = await tx
    .select()
    .from(readingProgress)
    .where(eq(readingProgress.userId, targetUserId));
  const targetByEpisode = new Map<number, any>(
    targetRows.map((row: any) => [Number(row.episodeId), row])
  );

  for (const row of sourceRows) {
    const target = targetByEpisode.get(Number(row.episodeId));
    if (!target) {
      await tx
        .update(readingProgress)
        .set({ userId: targetUserId })
        .where(eq(readingProgress.id, row.id));
      summary.readingProgressMoved += 1;
      continue;
    }
    if (Number(row.novelId) !== Number(target.novelId)) {
      throw new AccountMergeDataError(
        "READING_PROGRESS_INCONSISTENT",
        `Episode ${Number(row.episodeId)} is associated with different novel ids across accounts`
      );
    }

    const sourceWins = sourceReadingProgressWins(row, target);
    if (sourceWins) {
      await tx
        .update(readingProgress)
        .set({
          novelId: row.novelId,
          progressPercent: row.progressPercent,
          scrollPosition: row.scrollPosition,
          currentChapterNumber: row.currentChapterNumber,
          currentChapterTitle: row.currentChapterTitle,
          anchorKey: row.anchorKey,
          lastReadAt: row.lastReadAt,
          updatedAt: row.updatedAt,
        })
        .where(eq(readingProgress.id, target.id));
      summary.readingProgressSourceWins += 1;
    }

    dedupes.push({
      mergeCaseId: caseId,
      domain: "readingProgress",
      sourceRowId: Number(row.id),
      targetRowId: Number(target.id),
      keySummary: `episode:${Number(row.episodeId)}`,
      safeMetadata: JSON.stringify({ sourceWon: sourceWins }),
    });
    await tx.delete(readingProgress).where(eq(readingProgress.id, row.id));
    summary.readingProgressDeduped += 1;
  }
}

/**
 * IPE-007 deterministic Account Merge entitlement + user-data reconciliation.
 *
 * Canonical lock hierarchy is identical to IPE-006: Source/Target users rows
 * (ascending id), then merge-case row, then domain rows. The IPE-006 financial
 * receipt is a prerequisite, and financial history plus anti-replay evidence
 * are never mutated here. A UNIQUE data receipt makes ordinary retries and
 * two-admin races converge to one committed reconciliation.
 */
export async function reconcileAccountMergeDataInTransaction(
  params: {
    caseId: number;
    actorAdminId: number;
  },
  tx: any
) {
  assertPositiveInteger(params.caseId, "caseId");
  assertPositiveInteger(params.actorAdminId, "actorAdminId");

  // IPE-008 calls this core through its outer transaction so financial,
  // entitlement/user-data reconciliation, auth move, and completion share one
  // commit/rollback boundary. The public wrapper below preserves the original
  // standalone IPE-007 API and its exact behavior.
  const initial = await readMergeCase(params.caseId, tx);
  if (!initial)
    throw new AccountMergeDataError(
      "CASE_NOT_FOUND",
      "Account merge case not found"
    );

    const sourceUserId = Number(initial.sourceUserId);
    const targetUserId = Number(initial.targetUserId);

    await db.lockAccountMergeUserRows([sourceUserId, targetUserId], tx);
    const current = await lockMergeCase(params.caseId, tx);
    if (!current)
      throw new AccountMergeDataError(
        "CASE_NOT_FOUND",
        "Account merge case not found"
      );
    if (
      Number(current.sourceUserId) !== sourceUserId ||
      Number(current.targetUserId) !== targetUserId
    ) {
      throw new AccountMergeDataError(
        "INCONSISTENT_CASE",
        "Merge case participants changed unexpectedly"
      );
    }

    const existingReceipt = await readDataReceipt(params.caseId, tx);
    if (existingReceipt) {
      if (
        Number(existingReceipt.sourceUserId) !== sourceUserId ||
        Number(existingReceipt.targetUserId) !== targetUserId
      ) {
        throw new AccountMergeDataError(
          "INCONSISTENT_RECEIPT",
          "Data receipt participants do not match merge case"
        );
      }
      return { alreadyReconciled: true, reconciliation: existingReceipt };
    }

    if (current.status !== "in_progress") {
      throw new AccountMergeDataError(
        "CASE_NOT_IN_PROGRESS",
        `Data reconciliation requires in_progress merge case, got ${String(current.status)}`
      );
    }

    const financialReceipt = await readFinancialReceipt(params.caseId, tx);
    if (!financialReceipt) {
      throw new AccountMergeDataError(
        "FINANCIAL_NOT_RECONCILED",
        "IPE-006 financial reconciliation must commit before entitlement/user-data reconciliation"
      );
    }
    if (
      Number(financialReceipt.sourceUserId) !== sourceUserId ||
      Number(financialReceipt.targetUserId) !== targetUserId
    ) {
      throw new AccountMergeDataError(
        "INCONSISTENT_FINANCIAL_RECEIPT",
        "Financial receipt participants do not match merge case"
      );
    }

    const targetSourceCases = await db.getAccountMergeCasesForSourceForUpdate(
      targetUserId,
      tx
    );
    const targetGuard = targetSourceCases.find(
      (row: any) => row.status !== "cancelled"
    );
    if (targetGuard) {
      throw new AccountMergeDataError(
        "TARGET_ACCOUNT_GUARDED",
        `Target account is guarded by merge case ${Number(targetGuard.id)}`
      );
    }

    // All ambiguous reward collisions are rejected BEFORE the first write so
    // no implementation detail can accidentally decide who keeps spent points,
    // a wager outcome, or an already-issued check-in reward.
    await assertNoAmbiguousRewardConflicts(sourceUserId, targetUserId, tx);

    const dedupes: DedupeRecord[] = [];
    const summary = createEmptySummary();

    await reconcileEntitlementRows(
      params.caseId,
      sourceUserId,
      targetUserId,
      tx,
      dedupes,
      summary
    );
    maybeInjectDataFault("after_entitlements");

    await reconcileCart(
      params.caseId,
      sourceUserId,
      targetUserId,
      tx,
      dedupes,
      summary
    );
    await reconcileWishlist(
      params.caseId,
      sourceUserId,
      targetUserId,
      tx,
      dedupes,
      summary
    );
    await reconcileReadingProgress(
      params.caseId,
      sourceUserId,
      targetUserId,
      tx,
      dedupes,
      summary
    );
    maybeInjectDataFault("after_user_data");

    if (dedupes.length > 0) {
      await tx.insert(accountMergeDataDedupeRecords).values(dedupes);
    }

    maybeInjectDataFault("before_receipt");

    const safeSummary = JSON.stringify(summary);
    await tx.insert(accountMergeDataReconciliations).values({
      mergeCaseId: params.caseId,
      sourceUserId,
      targetUserId,
      actorAdminId: params.actorAdminId,
      safeSummary,
    });

    await tx.insert(accountMergeAuditLogs).values({
      mergeCaseId: params.caseId,
      actorAdminId: params.actorAdminId,
      action: "data_reconciled",
      sourceUserId,
      targetUserId,
      safeMetadata: safeSummary,
    });

    const reconciliation = await readDataReceipt(params.caseId, tx);
    if (!reconciliation) {
      throw new AccountMergeDataError(
        "RECEIPT_MISSING",
        "Data reconciliation receipt was not persisted"
      );
    }

  return { alreadyReconciled: false, reconciliation };
}

export async function reconcileAccountMergeData(params: {
  caseId: number;
  actorAdminId: number;
}) {
  const database = await db.getDb();
  if (!database)
    throw new AccountMergeDataError(
      "DATABASE_UNAVAILABLE",
      "Database unavailable"
    );
  return database.transaction((tx: any) => reconcileAccountMergeDataInTransaction(params, tx));
}
