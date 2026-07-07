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
  walletBalance?: string;
  requiredAmount?: string;
}

/**
 * Carries a structured error code (and optional balance/price context) across
 * the db.transaction() boundary, so the outer catch block can map it precisely
 * instead of relying on substring matching against a plain Error message.
 */
class PurchaseError extends Error {
  code: string;
  walletBalance?: string;
  requiredAmount?: string;

  constructor(code: string, details?: { walletBalance?: string; requiredAmount?: string }) {
    super(code);
    this.code = code;
    this.walletBalance = details?.walletBalance;
    this.requiredAmount = details?.requiredAmount;
  }
}

/**
 * Robustly extract affectedRows from a Drizzle mysql2 update/insert result.
 *
 * For queries without `.returning()`, drizzle-orm's mysql2 execute() returns
 * the raw mysql2 driver shape untouched: `[ResultSetHeader, FieldPacket[]]`
 * (an array, index 0 holds affectedRows) - NOT a flat object. Reading
 * `result.affectedRows` directly on that array is always undefined, which
 * previously fell back to `|| 0` and was misreported as an overdraft/
 * insufficient-balance failure even when the UPDATE actually succeeded.
 *
 * Returns null (not 0) when the shape is unrecognized, so callers can fall
 * back to verifying the actual balance instead of assuming failure.
 */
function extractAffectedRows(result: any): number | null {
  const candidates = [
    result,
    Array.isArray(result) ? result[0] : undefined,
    Array.isArray(result?.rows) ? result.rows[0] : result?.rows,
    result?.result,
    result?.raw,
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const affected =
      candidate.affectedRows ?? candidate.affected_rows ?? candidate.rowsAffected ?? candidate.rowCount;
    if (typeof affected === "number") return affected;
    if (typeof affected === "bigint") return Number(affected);
    if (typeof affected === "string" && affected.trim() !== "" && !Number.isNaN(Number(affected))) {
      return Number(affected);
    }
  }

  return null;
}

/**
 * Check if user already purchased an episode
 */
async function checkExistingPurchase(userId: number, episodeId: number): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;

  const existing = await db
    .select({ id: episodePurchases.id })
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

    // 4a. Strictly validate episode price format before trusting it
    const priceRaw = String(episode.price ?? "").trim();
    if (!/^\d+(\.\d{1,2})?$/.test(priceRaw)) {
      console.error("[EpisodePurchase] Invalid episode price format", { userId, episodeId, priceRaw });
      return {
        success: false,
        error: "INVALID_EPISODE_PRICE",
      };
    }
    const purchasePrice = Number(priceRaw);
    if (!Number.isFinite(purchasePrice) || purchasePrice <= 0) {
      console.error("[EpisodePurchase] Invalid episode price value", { userId, episodeId, priceRaw, purchasePrice });
      return {
        success: false,
        error: "INVALID_EPISODE_PRICE",
      };
    }

    // 4b. Strictly validate wallet balance format before trusting it
    const balanceRaw = String(wallet.balance ?? "0").trim();
    const currentBalance = Number(balanceRaw);
    if (!Number.isFinite(currentBalance)) {
      console.error("[EpisodePurchase] Invalid wallet balance value", { userId, episodeId, balanceRaw });
      return {
        success: false,
        error: "INVALID_WALLET_BALANCE",
      };
    }

    console.warn("[EpisodePurchase] Balance check", {
      userId,
      episodeId,
      walletBalanceRaw: wallet.balance?.toString(),
      episodePriceRaw: episode.price?.toString(),
      walletBalanceNum: currentBalance,
      purchasePrice,
    });

    // 5. Check sufficient balance (pre-check, will be rechecked in transaction)
    // Compare in cents (integers) to avoid binary floating-point equality issues
    // at exact-balance boundaries (e.g. balance === price).
    const balanceCentsPreCheck = Math.round(currentBalance * 100);
    const priceCentsPreCheck = Math.round(purchasePrice * 100);
    if (balanceCentsPreCheck < priceCentsPreCheck) {
      return {
        success: false,
        error: "INSUFFICIENT_WALLET_BALANCE",
        walletBalance: currentBalance.toFixed(2),
        requiredAmount: purchasePrice.toFixed(2),
      };
    }

    // ATOMIC TRANSACTION: All following operations must succeed together or all fail
    return await db.transaction(async (tx) => {
      // 6. RE-CHECK if user already purchased (within transaction for safety - minimal select)
      const existingPurchase = await tx
        .select({ id: episodePurchases.id })
        .from(episodePurchases)
        .where(and(eq(episodePurchases.userId, userId), eq(episodePurchases.episodeId, episodeId)))
        .limit(1);

      if (existingPurchase.length > 0) {
        throw new PurchaseError("ALREADY_PURCHASED");
      }

      // 7. RE-FETCH wallet balance inside transaction (may have changed)
      const walletInTx = await tx.select().from(walletAccounts).where(eq(walletAccounts.userId, userId)).limit(1);
      if (walletInTx.length === 0) {
        throw new PurchaseError("WALLET_NOT_FOUND");
      }

      const balanceRawInTx = String(walletInTx[0].balance ?? "0").trim();
      const currentBalanceInTx = Number(balanceRawInTx);
      if (!Number.isFinite(currentBalanceInTx)) {
        console.error("[EpisodePurchase] Invalid wallet balance value in transaction", { userId, episodeId, balanceRawInTx });
        throw new PurchaseError("INVALID_WALLET_BALANCE");
      }

      console.warn("[EpisodePurchase] Atomic debit attempt", {
        userId,
        episodeId,
        priceStr: purchasePrice.toFixed(2),
        currentBalanceInTx,
      });

      // Compare in cents to avoid binary floating-point equality issues
      const balanceCentsInTx = Math.round(currentBalanceInTx * 100);
      const priceCentsInTx = Math.round(purchasePrice * 100);
      if (balanceCentsInTx < priceCentsInTx) {
        throw new PurchaseError("INSUFFICIENT_WALLET_BALANCE", {
          walletBalance: currentBalanceInTx.toFixed(2),
          requiredAmount: purchasePrice.toFixed(2),
        });
      }

      const priceStr = purchasePrice.toFixed(2);

      // 8. ATOMIC UPDATE: Use SQL arithmetic to prevent race condition
      // This is critical - we must use SQL arithmetic (balance = balance - price)
      // not absolute assignment (balance = newBalance) to prevent lost updates
      // when multiple requests for the same user execute concurrently.
      // Explicit CAST(... AS DECIMAL) on both sides of the WHERE comparison
      // removes any ambiguity in how the string-bound priceStr is compared
      // against the DECIMAL column.
      const updateResult = await tx
        .update(walletAccounts)
        .set({
          balance: sql`${walletAccounts.balance} - CAST(${priceStr} AS DECIMAL(12,2))`,
          totalSpent: sql`COALESCE(${walletAccounts.totalSpent}, '0') + CAST(${priceStr} AS DECIMAL(12,2))`,
          updatedAt: new Date(),
        })
        .where(and(
          eq(walletAccounts.userId, userId),
          // Critical: Only update if balance >= purchase price
          // This prevents overdraft and ensures operation only succeeds if balance sufficient
          gte(walletAccounts.balance, sql`CAST(${priceStr} AS DECIMAL(12,2))`)
        ));

      const affectedRows = extractAffectedRows(updateResult);
      console.warn("[EpisodePurchase] Atomic debit result", {
        userId,
        episodeId,
        affectedRows,
        updateResultShape: Array.isArray(updateResult) ? "array" : typeof updateResult,
        priceStr,
        currentBalanceInTx,
      });

      if (affectedRows === 0) {
        throw new PurchaseError("INSUFFICIENT_WALLET_BALANCE_ATOMIC", {
          walletBalance: currentBalanceInTx.toFixed(2),
          requiredAmount: priceStr,
        });
      }

      if (affectedRows === null) {
        console.warn(
          "[EpisodePurchase] Could not determine affectedRows from updateResult; verifying wallet balance after update",
          { userId, episodeId }
        );
      }

      // 9. RE-FETCH wallet AFTER atomic update to get exact new balance
      const walletAfterUpdate = await tx.select().from(walletAccounts).where(eq(walletAccounts.userId, userId)).limit(1);
      if (walletAfterUpdate.length === 0) {
        throw new Error("Failed to fetch wallet after update");
      }

      const balanceAfter = walletAfterUpdate[0].balance.toString();
      const balanceAfterNum = parseFloat(balanceAfter);

      // If we couldn't read affectedRows from the driver result shape, fall
      // back to verifying the debit actually happened by comparing the
      // post-update balance (in cents) against the expected post-debit
      // balance. Only treat it as a real failure if the balance is still
      // at/above its pre-update value (i.e. the UPDATE's WHERE clause did
      // not match and no debit occurred).
      if (affectedRows === null) {
        const balanceAfterCents = Math.round(balanceAfterNum * 100);
        const expectedBalanceAfterCents = balanceCentsInTx - priceCentsInTx;
        if (balanceAfterCents > expectedBalanceAfterCents) {
          throw new PurchaseError("INSUFFICIENT_WALLET_BALANCE_ATOMIC", {
            walletBalance: currentBalanceInTx.toFixed(2),
            requiredAmount: priceStr,
          });
        }
      }

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

    // Structured errors thrown inside the transaction carry a precise code
    // plus optional balance/price context - prefer these over string matching.
    if (error instanceof PurchaseError) {
      if (error.code === "ALREADY_PURCHASED") {
        return { success: false, error: "Already purchased", alreadyPurchased: true };
      }
      return {
        success: false,
        error: error.code,
        walletBalance: error.walletBalance,
        requiredAmount: error.requiredAmount,
      };
    }

    // Fallback for unexpected/driver-level errors (e.g. MySQL duplicate key
    // races on the unique_user_episode_purchase constraint)
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
    .select({ episodeId: episodePurchases.episodeId })
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
