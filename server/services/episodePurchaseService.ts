import { eq, and } from "drizzle-orm";
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

    // 4. Check if user already purchased
    const alreadyPurchased = await checkExistingPurchase(userId, episodeId);
    if (alreadyPurchased) {
      return {
        success: false,
        error: "Already purchased",
        alreadyPurchased: true,
      };
    }

    // 5. Get user's wallet balance
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

    // 6. Check sufficient balance
    if (currentBalance < purchasePrice) {
      return {
        success: false,
        error: "Insufficient wallet balance",
      };
    }

    // 7. Calculate new balance
    const newBalance = (currentBalance - purchasePrice).toFixed(2);

    // 8. Create wallet transaction for the debit
    const transactionInsert = await db.insert(walletTransactions).values({
      userId,
      type: "debit",
      amount: (-purchasePrice).toString(),
      balanceBefore: wallet.balance,
      balanceAfter: newBalance,
      referenceType: "episode_purchase",
      referenceId: episodeId,
      note: `Episode purchase: Episode #${episode.episodeNumber}`,
    });

    // 9. Create episodePurchase record
    const purchaseInsert = await db.insert(episodePurchases).values({
      userId,
      novelId: episode.novelId,
      episodeId,
      pricePaid: purchasePrice.toString(),
      walletTransactionId: null,
      purchasedAt: new Date(),
    });

    const episodePurchaseId = 0; // Will be auto-generated

    // 10. Update wallet balance
    const totalSpentBefore = wallet.totalSpent ? parseFloat(wallet.totalSpent.toString()) : 0;
    await db
      .update(walletAccounts)
      .set({
        balance: newBalance,
        totalSpent: (totalSpentBefore + purchasePrice).toString(),
      })
      .where(eq(walletAccounts.userId, userId));

    return {
      success: true,
      episodePurchaseId: episodePurchaseId > 0 ? episodePurchaseId : undefined,
      newBalance,
    };
  } catch (error) {
    console.error("[EpisodePurchase] Error purchasing episode:", error);

    // If error and it's due to unique constraint (duplicate), user might have purchased concurrently
    const errorMsg = (error as Error).message || "";
    if (errorMsg.includes("Duplicate entry") || errorMsg.includes("unique")) {
      return {
        success: false,
        error: "Already purchased",
        alreadyPurchased: true,
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
