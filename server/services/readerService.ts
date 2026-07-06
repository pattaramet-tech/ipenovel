import { eq, and, gt } from "drizzle-orm";
import { getDb } from "../db";
import { episodes, episodePurchases, purchases, users, walletAccounts, novels } from "../../drizzle/schema";

export interface ReaderEpisodeData {
  episode: any;
  novel: any;
  canRead: boolean;
  isLocked: boolean;
  alreadyPurchased: boolean;
  content?: string;
  preview?: string;
  previousEpisode?: any;
  nextEpisode?: any;
  accessReason?: string;
}

/**
 * Check if user can read an episode
 * Returns true if:
 * - Episode is free
 * - User purchased episode via wallet (episodePurchases)
 * - User purchased via order (purchases table)
 * - User is admin
 */
export async function canReadEpisode(userId: number | undefined, episodeId: number, isAdmin: boolean = false): Promise<boolean> {
  if (isAdmin) return true;
  if (!userId) return false;

  const db = await getDb();
  if (!db) return false;

  const episode = await db.select().from(episodes).where(eq(episodes.id, episodeId)).limit(1);
  if (episode.length === 0) return false;

  const ep = episode[0];

  // Free episodes are readable by everyone
  if (ep.isFree) return true;

  // Check wallet-based purchase
  const walletPurchase = await db
    .select()
    .from(episodePurchases)
    .where(and(eq(episodePurchases.userId, userId), eq(episodePurchases.episodeId, episodeId)))
    .limit(1);

  if (walletPurchase.length > 0) return true;

  // Check order-based purchase (legacy system)
  const orderPurchase = await db
    .select()
    .from(purchases)
    .where(and(eq(purchases.userId, userId), eq(purchases.episodeId, episodeId)))
    .limit(1);

  if (orderPurchase.length > 0) return true;

  return false;
}

/**
 * Get episode data for reader display
 * Returns full content if user has access, otherwise preview only
 */
export async function getReaderEpisode(userId: number | undefined, episodeId: number, isAdmin: boolean = false) {
  const db = await getDb();
  if (!db) return null;

  const episodeData = await db.select().from(episodes).where(eq(episodes.id, episodeId)).limit(1);
  if (episodeData.length === 0) return null;

  const ep = episodeData[0];
  const novelData = await db.select().from(novels).where(eq(novels.id, ep.novelId)).limit(1);
  const novel = novelData[0] || null;

  const canRead = await canReadEpisode(userId, episodeId, isAdmin);

  // Get previous and next episodes using numeric episodeNumber comparison
  const { lt, gt } = await import("drizzle-orm").then(m => ({ lt: m.lt, gt: m.gt }));

  const prevEpisode = await db
    .select()
    .from(episodes)
    .where(and(
      eq(episodes.novelId, ep.novelId),
      eq(episodes.isPublished, true),
      lt(episodes.id, ep.id)
    ))
    .orderBy(episodes.id)
    .limit(1);

  const nextEpisode = await db
    .select()
    .from(episodes)
    .where(and(
      eq(episodes.novelId, ep.novelId),
      eq(episodes.isPublished, true),
      gt(episodes.id, ep.id)
    ))
    .orderBy(episodes.id)
    .limit(1);

  // Check if already purchased
  let alreadyPurchased = false;
  if (userId && !ep.isFree) {
    const purchase = await db
      .select()
      .from(episodePurchases)
      .where(and(eq(episodePurchases.userId, userId), eq(episodePurchases.episodeId, episodeId)))
      .limit(1);
    alreadyPurchased = purchase.length > 0;
  }

  // Sanitize episode object to not leak content in API response
  // The content and preview are returned as top-level fields only when appropriate
  const { content: _content, ...safeEpisode } = ep;

  const result: ReaderEpisodeData = {
    episode: safeEpisode,
    novel,
    canRead,
    isLocked: !canRead && !ep.isFree,
    alreadyPurchased,
    previousEpisode: prevEpisode[0] || null,
    nextEpisode: nextEpisode[0] || null,
  };

  // Return full content only if user can read
  if (canRead && ep.content) {
    result.content = ep.content;
    result.accessReason = ep.isFree ? "free" : "purchased";
  } else if (ep.content) {
    // Return preview for locked episodes (first 500 chars)
    const preview = ep.content.substring(0, 500);
    result.preview = preview;
  }

  return result;
}

/**
 * Get wallet balance for user
 */
export async function getUserWalletBalance(userId: number): Promise<string> {
  const db = await getDb();
  if (!db) return "0.00";

  const wallet = await db.select().from(walletAccounts).where(eq(walletAccounts.userId, userId)).limit(1);
  if (wallet.length === 0) return "0.00";

  return wallet[0].balance.toString();
}
