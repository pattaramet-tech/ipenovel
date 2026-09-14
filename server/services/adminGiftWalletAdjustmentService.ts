import { and, desc, eq, inArray, or } from "drizzle-orm";
import {
  accountRecoveryRequests,
  adminGiftEntitlements,
  adminGiftWalletAdjustments,
  episodePurchases,
  episodes,
  purchases,
  walletAccounts,
  walletTransactions,
} from "../../drizzle/schema";
import * as db from "../db";
import { decimalToMinorUnits, minorUnitsToDecimal } from "./accountMergeFinancialMath";
import { adminWalletLedgerAdjustment } from "./walletService";
import { isDuplicateKeyError } from "../helpers/databaseErrorClassifier";

const WALLET_SPEC = { precision: 12, scale: 2 } as const;
export type AdminAdjustmentAction = "NOVEL_GIFT" | "WALLET_CREDIT" | "WALLET_CLAWBACK";

export class AdminGiftWalletAdjustmentError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "AdminGiftWalletAdjustmentError";
  }
}

function requireReason(reason: string) {
  const value = String(reason ?? "").trim();
  if (value.length < 3) throw new AdminGiftWalletAdjustmentError("REASON_REQUIRED", "Reason must be at least 3 characters");
  return value;
}

function requireIdempotencyKey(key: string) {
  const value = String(key ?? "").trim();
  if (value.length < 8 || value.length > 128) {
    throw new AdminGiftWalletAdjustmentError("IDEMPOTENCY_KEY_INVALID", "Idempotency key must be 8-128 characters");
  }
  return value;
}

function parsePositiveAmount(amount: string | undefined) {
  if (amount === undefined) throw new AdminGiftWalletAdjustmentError("AMOUNT_REQUIRED", "Amount is required");
  try {
    const minor = decimalToMinorUnits(amount, "amount", WALLET_SPEC);
    if (minor <= 0) throw new Error("positive");
    return { minor, decimal: minorUnitsToDecimal(minor, WALLET_SPEC.scale) };
  } catch {
    throw new AdminGiftWalletAdjustmentError("AMOUNT_INVALID", "Amount must be a positive wallet amount with at most 2 decimals");
  }
}

async function assertNoRecoveryConflict(userId: number, database: any) {
  const conflicts = await database.select({ id: accountRecoveryRequests.id })
    .from(accountRecoveryRequests)
    .where(and(
      inArray(accountRecoveryRequests.status, ["pending", "blocked"]),
      or(eq(accountRecoveryRequests.requesterUserId, userId), eq(accountRecoveryRequests.sourceUserId, userId), eq(accountRecoveryRequests.targetUserId, userId))
    )).limit(1);
  if (conflicts.length) throw new AdminGiftWalletAdjustmentError("ACCOUNT_RECOVERY_CONFLICT", "Account has an active recovery workflow");
}

async function getGiftEpisodes(database: any, novelId: number) {
  const rows = await database.select({ id: episodes.id, novelId: episodes.novelId, title: episodes.title, episodeNumber: episodes.episodeNumber })
    .from(episodes)
    .where(and(eq(episodes.novelId, novelId), eq(episodes.isPublished, true)))
    .orderBy(episodes.id);
  if (!rows.length) throw new AdminGiftWalletAdjustmentError("NO_GIFTABLE_EPISODES", "Novel has no published episodes to gift");
  return rows;
}

async function getGiftGrantability(database: any, targetUserId: number, novelId: number) {
  const giftEpisodes = await getGiftEpisodes(database, novelId);
  const episodeIds = giftEpisodes.map((episode: any) => episode.id);
  const [paidOrders, paidWallet, existingGift] = await Promise.all([
    database.select({ episodeId: purchases.episodeId }).from(purchases)
      .where(and(eq(purchases.userId, targetUserId), inArray(purchases.episodeId, episodeIds))),
    database.select({ episodeId: episodePurchases.episodeId }).from(episodePurchases)
      .where(and(eq(episodePurchases.userId, targetUserId), inArray(episodePurchases.episodeId, episodeIds))),
    database.select({ episodeId: adminGiftEntitlements.episodeId }).from(adminGiftEntitlements)
      .where(and(eq(adminGiftEntitlements.userId, targetUserId), inArray(adminGiftEntitlements.episodeId, episodeIds))),
  ]);
  return classifyGiftScope(giftEpisodes, paidOrders, paidWallet, existingGift);
}

export function classifyGiftScope(
  giftEpisodes: Array<{ id: number }>,
  paidOrders: Array<{ episodeId: number }>,
  paidWallet: Array<{ episodeId: number }>,
  existingGift: Array<{ episodeId: number }>
) {
  const already = new Set<number>([...paidOrders, ...paidWallet, ...existingGift].map(row => Number(row.episodeId)));
  return {
    giftEpisodes,
    grantable: giftEpisodes.filter(episode => !already.has(episode.id)),
    skipped: giftEpisodes.filter(episode => already.has(episode.id)),
  };
}

export function assertIdempotentReplayMatches(prior: any, input: {
  action: AdminAdjustmentAction;
  targetUserId: number;
  amount?: string;
  novelId?: number;
  linkedOriginalAdjustmentId?: number;
}) {
  const normalizedAmount = input.action === "NOVEL_GIFT" ? null : parsePositiveAmount(input.amount).decimal;
  const priorAmount = prior.amount == null ? null : minorUnitsToDecimal(
    decimalToMinorUnits(String(prior.amount), "priorAmount", WALLET_SPEC),
    WALLET_SPEC.scale
  );
  const matches = prior.action === input.action
    && Number(prior.targetUserId) === input.targetUserId
    && priorAmount === normalizedAmount
    && (prior.novelId == null ? null : Number(prior.novelId)) === (input.novelId ?? null)
    && (prior.linkedOriginalAdjustmentId == null ? null : Number(prior.linkedOriginalAdjustmentId)) === (input.linkedOriginalAdjustmentId ?? null);
  if (!matches) {
    throw new AdminGiftWalletAdjustmentError("IDEMPOTENCY_KEY_REUSE_MISMATCH", "Idempotency key was already used for a different adjustment request");
  }
  return prior;
}

export async function previewAdminGiftWalletAdjustment(input: {
  action: AdminAdjustmentAction;
  targetUserId: number;
  amount?: string;
  novelId?: number;
  linkedOriginalAdjustmentId?: number;
}) {
  const database = await db.getDb();
  if (!database) throw new AdminGiftWalletAdjustmentError("DATABASE_UNAVAILABLE", "Database unavailable");
  const user = await db.getUserById(input.targetUserId);
  if (!user) throw new AdminGiftWalletAdjustmentError("USER_NOT_FOUND", "Target user not found");
  await assertNoRecoveryConflict(input.targetUserId, database);

  if (input.action === "NOVEL_GIFT") {
    if (!input.novelId) throw new AdminGiftWalletAdjustmentError("NOVEL_REQUIRED", "Novel is required");
    const scope = await getGiftGrantability(database, input.targetUserId, input.novelId);
    return {
      action: input.action,
      targetUserId: input.targetUserId,
      novelId: input.novelId,
      episodeCount: scope.giftEpisodes.length,
      grantableCount: scope.grantable.length,
      skippedCount: scope.skipped.length,
      grantableEpisodes: scope.grantable,
      skippedEpisodes: scope.skipped,
    };
  }

  const amount = parsePositiveAmount(input.amount);
  const currentBalance = await db.getWalletBalance(input.targetUserId);
  const currentMinor = decimalToMinorUnits(currentBalance, "currentBalance", WALLET_SPEC);
  let original: any = null;
  if (input.linkedOriginalAdjustmentId) {
    original = (await database.select().from(adminGiftWalletAdjustments)
      .where(eq(adminGiftWalletAdjustments.id, input.linkedOriginalAdjustmentId)).limit(1))[0] ?? null;
    if (!original || Number(original.targetUserId) !== input.targetUserId) {
      throw new AdminGiftWalletAdjustmentError("ORIGINAL_ADJUSTMENT_INVALID", "Linked original adjustment does not belong to the target user");
    }
  }
  const recoverableMinor = input.action === "WALLET_CLAWBACK" ? Math.min(currentMinor, amount.minor) : amount.minor;
  const resultingMinor = input.action === "WALLET_CREDIT" ? currentMinor + amount.minor : currentMinor - recoverableMinor;
  const shortfallMinor = input.action === "WALLET_CLAWBACK" ? amount.minor - recoverableMinor : 0;
  return {
    action: input.action,
    targetUserId: input.targetUserId,
    amount: amount.decimal,
    currentBalance: minorUnitsToDecimal(currentMinor, 2),
    maximumRecoverable: minorUnitsToDecimal(recoverableMinor, 2),
    resultingBalance: minorUnitsToDecimal(resultingMinor, 2),
    unrecoverableAmount: minorUnitsToDecimal(shortfallMinor, 2),
    executable: shortfallMinor === 0,
    linkedOriginalAdjustment: original ? { id: original.id, action: original.action, amount: original.amount, createdAt: original.createdAt } : null,
  };
}

export async function executeAdminGiftWalletAdjustment(input: {
  action: AdminAdjustmentAction;
  targetUserId: number;
  actorAdminId: number;
  reason: string;
  idempotencyKey: string;
  confirmation: string;
  expectedBalance?: string;
  amount?: string;
  novelId?: number;
  linkedOriginalAdjustmentId?: number;
}) {
  const reason = requireReason(input.reason);
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
  const confirmationAmount = input.action === "NOVEL_GIFT" ? null : parsePositiveAmount(input.amount).decimal;
  const expectedConfirmation = input.action === "NOVEL_GIFT"
    ? `CONFIRM USER ${input.targetUserId} NOVEL ${input.novelId}`
    : `CONFIRM USER ${input.targetUserId} ${input.action} ${confirmationAmount}`;
  if (input.confirmation !== expectedConfirmation) {
    throw new AdminGiftWalletAdjustmentError("CONFIRMATION_INVALID", "Confirmation does not match target/action/amount");
  }
  const database = await db.getDb();
  if (!database) throw new AdminGiftWalletAdjustmentError("DATABASE_UNAVAILABLE", "Database unavailable");
  try {
    return await database.transaction(async (tx: any) => {
    await db.assertAccountMergeClassifiedMutationAllowed(input.targetUserId, tx);
    await assertNoRecoveryConflict(input.targetUserId, tx);
    const prior = (await tx.select().from(adminGiftWalletAdjustments)
      .where(eq(adminGiftWalletAdjustments.idempotencyKey, idempotencyKey)).limit(1))[0];
    if (prior) return { replayed: true, adjustment: assertIdempotentReplayMatches(prior, input) };

    if (input.action === "NOVEL_GIFT") {
      if (!input.novelId) throw new AdminGiftWalletAdjustmentError("NOVEL_REQUIRED", "Novel is required");
      const scope = await getGiftGrantability(tx, input.targetUserId, input.novelId);
      const grantable = scope.grantable;
      const inserted: any = await tx.insert(adminGiftWalletAdjustments).values({
        action: "NOVEL_GIFT", targetUserId: input.targetUserId, actorAdminId: input.actorAdminId,
        reason, idempotencyKey, novelId: input.novelId, entitlementCount: grantable.length,
        safeMetadata: JSON.stringify({ episodeIds: grantable.map((e: any) => e.id), skippedEpisodeIds: scope.skipped.map((e: any) => e.id) }),
      });
      const adjustmentId = Number((Array.isArray(inserted) ? inserted[0] : inserted)?.insertId);
      if (!Number.isInteger(adjustmentId) || adjustmentId <= 0) throw new Error("Failed to create adjustment receipt");

      if (grantable.length) {
        await tx.insert(adminGiftEntitlements).values(grantable.map((e: any) => ({
          userId: input.targetUserId,
          novelId: e.novelId,
          episodeId: e.id,
          actorAdminId: input.actorAdminId,
          reason,
          idempotencyKey,
          adjustmentId,
        })));
      }
      const adjustment = (await tx.select().from(adminGiftWalletAdjustments).where(eq(adminGiftWalletAdjustments.id, adjustmentId)).limit(1))[0];
      return { replayed: false, adjustment, grantedEpisodeIds: grantable.map((e: any) => e.id) };
    }

    const amount = parsePositiveAmount(input.amount);
    await db.getOrCreateWalletAccount(input.targetUserId, tx);
    const wallet = (await tx.select().from(walletAccounts)
      .where(eq(walletAccounts.userId, input.targetUserId)).limit(1).for("update"))[0];
    if (!wallet) throw new AdminGiftWalletAdjustmentError("WALLET_NOT_FOUND", "Wallet account unavailable");
    const beforeMinor = decimalToMinorUnits(String(wallet.balance), "walletBalance", WALLET_SPEC);
    const before = minorUnitsToDecimal(beforeMinor, 2);

    if (input.expectedBalance === undefined || input.expectedBalance !== before) {
      throw new AdminGiftWalletAdjustmentError("STALE_PREVIEW", "Wallet balance changed after preview; preview again before executing");
    }
    if (input.action === "WALLET_CLAWBACK" && amount.minor > beforeMinor) {
      throw new AdminGiftWalletAdjustmentError("INSUFFICIENT_WALLET", "Requested clawback exceeds current wallet balance; negative wallet/debt is not supported");
    }
    if (input.linkedOriginalAdjustmentId) {
      const original = (await tx.select().from(adminGiftWalletAdjustments)
        .where(eq(adminGiftWalletAdjustments.id, input.linkedOriginalAdjustmentId)).limit(1))[0];
      if (!original || Number(original.targetUserId) !== input.targetUserId) {
        throw new AdminGiftWalletAdjustmentError("ORIGINAL_ADJUSTMENT_INVALID", "Linked original adjustment does not belong to the target user");
      }
    }
    const deltaMinor = input.action === "WALLET_CREDIT" ? amount.minor : -amount.minor;
    const afterMinor = beforeMinor + deltaMinor;
    if (afterMinor < 0) throw new AdminGiftWalletAdjustmentError("NEGATIVE_WALLET_UNSUPPORTED", "Negative wallet/debt is not supported");
    const after = minorUnitsToDecimal(afterMinor, 2);
    const receiptResult: any = await tx.insert(adminGiftWalletAdjustments).values({
      action: input.action, targetUserId: input.targetUserId, actorAdminId: input.actorAdminId,
      reason, idempotencyKey, amount: amount.decimal, balanceBefore: before, balanceAfter: after,
      linkedOriginalAdjustmentId: input.linkedOriginalAdjustmentId ?? null,
      safeMetadata: JSON.stringify({ expectedBalance: input.expectedBalance }),
    });

    const adjustmentId = Number((Array.isArray(receiptResult) ? receiptResult[0] : receiptResult)?.insertId);
    if (!Number.isInteger(adjustmentId) || adjustmentId <= 0) throw new Error("Failed to create adjustment receipt");
    const ledger = await adminWalletLedgerAdjustment({
      tx,
      userId: input.targetUserId,
      delta: minorUnitsToDecimal(deltaMinor, 2),
      expectedBalance: before,
      referenceType: input.action === "WALLET_CREDIT" ? "admin_wallet_credit" : "admin_wallet_clawback",
      referenceId: adjustmentId,
      note: `${input.action} by admin ${input.actorAdminId}: ${reason}`,
    });
    const walletTransactionId = ledger.walletTransactionId;
    await tx.update(adminGiftWalletAdjustments).set({ walletTransactionId }).where(eq(adminGiftWalletAdjustments.id, adjustmentId));
    const adjustment = (await tx.select().from(adminGiftWalletAdjustments).where(eq(adminGiftWalletAdjustments.id, adjustmentId)).limit(1))[0];
    return { replayed: false, adjustment };
    });
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
    const replay = (await database.select().from(adminGiftWalletAdjustments)
      .where(eq(adminGiftWalletAdjustments.idempotencyKey, idempotencyKey)).limit(1))[0];
    if (!replay) throw error;
    return { replayed: true, adjustment: assertIdempotentReplayMatches(replay, input) };
  }
}

export async function listAdminGiftWalletAdjustmentHistory(input: { targetUserId?: number; action?: AdminAdjustmentAction; limit?: number }) {
  const database = await db.getDb();
  if (!database) throw new AdminGiftWalletAdjustmentError("DATABASE_UNAVAILABLE", "Database unavailable");
  const conditions = [] as any[];
  if (input.targetUserId) conditions.push(eq(adminGiftWalletAdjustments.targetUserId, input.targetUserId));
  if (input.action) conditions.push(eq(adminGiftWalletAdjustments.action, input.action));
  const where = conditions.length === 0 ? undefined : conditions.length === 1 ? conditions[0] : and(...conditions);
  let query: any = database.select().from(adminGiftWalletAdjustments);
  if (where) query = query.where(where);
  return query.orderBy(desc(adminGiftWalletAdjustments.createdAt), desc(adminGiftWalletAdjustments.id)).limit(Math.min(input.limit ?? 50, 100));
}

export async function hasAdminGiftEntitlement(userId: number, episodeId: number, database?: any): Promise<boolean> {
  const conn = database ?? await db.getDb();
  if (!conn) return false;
  const rows = await conn.select({ id: adminGiftEntitlements.id }).from(adminGiftEntitlements)
    .where(and(eq(adminGiftEntitlements.userId, userId), eq(adminGiftEntitlements.episodeId, episodeId))).limit(1);
  return rows.length > 0;
}
