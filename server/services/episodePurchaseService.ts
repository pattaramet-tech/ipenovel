import { eq, and, sql, gte } from "drizzle-orm";
import { getDb } from "../db";
import {
  episodes,
  episodePurchases,
  walletAccounts,
  walletTransactions,
  novels,
} from "../../drizzle/schema";

export interface PurchaseResult {
  success: boolean;
  error?: string;
  episodePurchaseId?: number;
  newBalance?: string;
  alreadyPurchased?: boolean;
}

/**
 * Check if user already purchased an episode
 */
async function checkExistingPurchase(userId: number, episodeId: number): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;

  const existing = await db
    .select()
    .from(episodePurchases)
    .where(and(eq(episodePurchases.userId, userId), eq(episodePurchases.episodeId, episodeId)))
    .limit(1);

  return existing.length > 0;
}

/**
 * Purchase episode with wallet (atomic transaction)
 *
 * Security checks:
 * 1. Episode must exist and be published
 * 2. Episode must not be free (free episodes don't need purchase)
 * 3. User must not have already purchased
 * 4. Wallet balance must be sufficient
 * 5. Coupon cannot be used (wallet-based purchases only)
 *
 * Returns: PurchaseResult with success flag and new balance
 */
export async function purchaseEpisodeWithWallet(userId: number, episodeId: number): Promise<PurchaseResult> {
  const db = await getDb();
  if (!db) {
    return {
      success: false,
      error: "Database not available",
    };
  }

  try {
    // Pre-transaction checks (fast path rejections)

    // 1. Verify episode exists and is published
    const episodeData = await db.select().from(episodes).where(eq(episodes.id, episodeId)).limit(1);
    if (episodeData.length === 0) {
      return {
        success: false,
        error: "Episode not found",
      };
    }

    const episode = episodeData[0];

    // 2. Check if episode should be purchasable (not free)
    if (episode.isFree) {
      return {
        success: false,
        error: "Free episodes do not require purchase",
      };
    }

    // 3. Verify episode is published
    if (!episode.isPublished) {
      return {
        success: false,
        error: "Episode is not published",
      };
    }

    // 4. Get user's wallet balance
    const walletData = await db.select().from(walletAccounts).where(eq(walletAccounts.userId, userId)).limit(1);
    if (walletData.length === 0) {
      return {
        success: false,
        error: "Wallet not found",
      };
    }

    const wallet = walletData[0];
    const currentBalance = parseFloat(wallet.balance.toString());
    const purchasePrice = parseFloat(episode.price.toString());

    // 5. Check sufficient balance (pre-check, will be rechecked in transaction)
    if (currentBalance < purchasePrice) {
      return {
        success: false,
        error: "Insufficient wallet balance",
      };
    }

    // ATOMIC TRANSACTION: All following operations must succeed together or all fail
    return await db.transaction(async (tx) => {
      // 6. RE-CHECK if user already purchased (within transaction for safety)
      const existingPurchase = await tx
        .select()
        .from(episodePurchases)
        .where(and(eq(episodePurchases.userId, userId), eq(episodePurchases.episodeId, episodeId)))
        .limit(1);

      if (existingPurchase.length > 0) {
        throw new Error("Already purchased");
      }

      // 7. RE-FETCH wallet balance inside transaction (may have changed)
      const walletInTx = await tx.select().from(walletAccounts).where(eq(walletAccounts.userId, userId)).limit(1);
      if (walletInTx.length === 0) {
        throw new Error("Wallet not found");
      }

      const currentBalanceInTx = parseFloat(walletInTx[0].balance.toString());
      if (currentBalanceInTx < purchasePrice) {
        throw new Error("Insufficient wallet balance");
      }

      const priceStr = purchasePrice.toFixed(2);

      // 8. ATOMIC UPDATE: Use SQL arithmetic to prevent race condition
      // This is critical - we must use SQL arithmetic (balance = balance - price)
      // not absolute assignment (balance = newBalance) to prevent lost updates
      // when multiple requests for the same user execute concurrently
      const updateResult = await tx
        .update(walletAccounts)
        .set({
          balance: sql`${walletAccounts.balance} - ${priceStr}`,
          totalSpent: sql`COALESCE(${walletAccounts.totalSpent}, '0') + ${priceStr}`,
          updatedAt: new Date(),
        })
        .where(and(
          eq(walletAccounts.userId, userId),
          // Critical: Only update if balance >= purchase price
          // This prevents overdraft and ensures operation only succeeds if balance sufficient
          gte(walletAccounts.balance, sql`${priceStr}`)
        ));

      const affectedRows = (updateResult as any)?.affectedRows || 0;
      if (affectedRows === 0) {
        throw new Error("Insufficient wallet balance");
      }

      // 9. RE-FETCH wallet AFTER atomic update to get exact new balance
      const walletAfterUpdate = await tx.select().from(walletAccounts).where(eq(walletAccounts.userId, userId)).limit(1);
      if (walletAfterUpdate.length === 0) {
        throw new Error("Failed to fetch wallet after update");
      }

      const balanceAfter = walletAfterUpdate[0].balance.toString();
      const balanceAfterNum = parseFloat(balanceAfter);

      // IMPORTANT: Calculate balanceBefore from the actual balanceAfter to ensure audit log accuracy
      // In concurrent scenarios, the pre-update balance we read initially may have changed
      // by the time this transaction logs it. By calculating from the definitive balanceAfter
      // (which is the actual state after our atomic update), we ensure:
      // balanceBefore - amount = balanceAfter (always mathematically correct)
      const balanceBeforeForLog = (balanceAfterNum + purchasePrice).toFixed(2);

      // 10. Create wallet transaction record with mathematically consistent before/after balance
      const transactionResult = await tx.insert(walletTransactions).values({
        userId,
        type: "debit" as any,
        amount: priceStr,
        balanceBefore: balanceBeforeForLog,
        balanceAfter,
        referenceType: "episode_purchase",
        referenceId: episodeId,
        note: `Episode purchase: Episode #${episode.episodeNumber}`,
      });

      const transactionId = (transactionResult as any).insertId || null;

      // 11. Create episodePurchase record with walletTransaction link
      const purchaseResult = await tx.insert(episodePurchases).values({
        userId,
        novelId: episode.novelId,
        episodeId,
        pricePaid: priceStr,
        walletTransactionId: transactionId || undefined,
        purchasedAt: new Date(),
      });

      const episodePurchaseId = (purchaseResult as any).insertId || 0;

      // 12. Return success with actual balance after update
      return {
        success: true,
        episodePurchaseId: episodePurchaseId && episodePurchaseId > 0 ? episodePurchaseId : undefined,
        newBalance: balanceAfter,
      };
    });
  } catch (error) {
    console.error("[EpisodePurchase] Error purchasing episode:", error);

    // Map errors to user-friendly messages
    const errorMsg = (error as Error).message || "";

    if (errorMsg.includes("Already purchased") || errorMsg.includes("Duplicate entry") || errorMsg.includes("unique")) {
      return {
        success: false,
        error: "Already purchased",
        alreadyPurchased: true,
      };
    }

    if (errorMsg.includes("Insufficient wallet balance")) {
      return {
        success: false,
        error: "Insufficient wallet balance",
      };
    }

    return {
      success: false,
      error: "Purchase failed. Please try again.",
    };
  }
}

/**
 * Get user's purchased episodes for a novel
 */
export async function getUserPurchasedEpisodes(userId: number, novelId: number): Promise<number[]> {
  const db = await getDb();
  if (!db) return [];

  const purchases = await db
    .select()
    .from(episodePurchases)
    .where(and(eq(episodePurchases.userId, userId), eq(episodePurchases.novelId, novelId)));

  return purchases.map((p) => p.episodeId);
}

/**
 * Get purchase details
 */
export async function getEpisodePurchase(userId: number, episodeId: number) {
  const db = await getDb();
  if (!db) return null;

  const purchase = await db
    .select()
    .from(episodePurchases)
    .where(and(eq(episodePurchases.userId, userId), eq(episodePurchases.episodeId, episodeId)))
    .limit(1);

  return purchase.length > 0 ? purchase[0] : null;
}
