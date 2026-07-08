import { eq, and, asc } from "drizzle-orm";
import { getDb } from "../db";
import { episodes, episodePurchases, purchases, walletAccounts, novels } from "../../drizzle/schema";

export interface ReaderEpisodeData {
  episode: any;
  novel: any;
  canRead: boolean;
  isLocked: boolean;
  alreadyPurchased: boolean;
  saleMode: EpisodeSaleMode;
  content?: string;
  preview?: string;
  previousEpisode?: any;
  nextEpisode?: any;
  accessReason?: string;
}

export type EpisodeSaleMode = "chapter" | "package";

const RANGE_EPISODE_NUMBER_PATTERN = /^\s*\d+(?:\.\d+)?\s*-\s*\d+(?:\.\d+)?\s*$/;

/**
 * Normalize an episode number string into a canonical range identity for
 * matching purposes (e.g. import upsert lookups). Strips common prefixes
 * ("#", "บทที่"), collapses leading zeros and surrounding whitespace, so
 * "51-100", "51 - 100", "051 - 100", "#051 - 100", "บทที่ 51 - 100" all
 * normalize to the same value. Single numbers ("001") normalize to "1".
 *
 * This is the single source of truth for "is this the same package" during
 * ZIP import sync - matching on the raw string previously caused re-imports
 * with a differently formatted range to create a duplicate episode instead
 * of updating the existing one, breaking legacy purchase entitlements.
 */
export function normalizeEpisodeRange(episodeNumber: unknown): string {
  const raw = String(episodeNumber ?? "").trim();
  if (!raw) return "";

  // Strip leading labels like "#", "บทที่", "ตอนที่", "chapter", "ep" etc,
  // keeping only the numeric range portion.
  const stripped = raw
    .replace(/^#+/, "")
    .replace(/^(บทที่|ตอนที่|chapter|episode|ep)\s*/i, "")
    .trim();

  const numbers = stripped.match(/\d+(?:\.\d+)?/g);
  if (!numbers || numbers.length === 0) return stripped.toLowerCase();

  const normalizeNum = (n: string) => {
    const num = Number(n);
    return Number.isFinite(num) ? String(num) : n;
  };

  if (numbers.length === 1) return normalizeNum(numbers[0]);

  // Range-style: use first and last numeric token found (handles "51-100"
  // and "51 - 100" identically), ignoring any extra numeric noise between.
  return `${normalizeNum(numbers[0])} - ${normalizeNum(numbers[numbers.length - 1])}`;
}

/**
 * Resolve an episode's sale mode, with a legacy fallback for rows written
 * before the `saleMode` column existed (or wherever a partial select omits
 * it). "chapter" = single episode sold individually via reader.purchaseEpisode
 * (wallet direct debit, read at /read/:episodeId). "package" = multi-chapter
 * bundle sold via cart/checkout, web-read-only (no file download).
 *
 * Priority:
 * 1. Explicit `saleMode` column value, if it's "chapter" or "package".
 * 2. Legacy fileUrl present -> "package" (old file-sale episodes).
 * 3. Legacy range-style episodeNumber (e.g. "436 - 508") -> "package".
 * 4. Otherwise -> "chapter".
 */
export function resolveSaleMode(episode: { saleMode?: string | null; fileUrl?: string | null; episodeNumber?: unknown }): EpisodeSaleMode {
  if (episode?.saleMode === "chapter" || episode?.saleMode === "package") {
    return episode.saleMode;
  }

  if (episode?.fileUrl && String(episode.fileUrl).trim().length > 0) {
    return "package";
  }

  if (RANGE_EPISODE_NUMBER_PATTERN.test(String(episode?.episodeNumber ?? ""))) {
    return "package";
  }

  return "chapter";
}

function parseEpisodeOrderNumber(episodeNumber: unknown): number | null {
  const match = String(episodeNumber ?? "").match(/\d+(?:\.\d+)?/);
  if (!match) return null;

  const value = Number(match[0]);
  return Number.isFinite(value) ? value : null;
}

function getNavigationOrderValue(episode: any): number {
  if (episode?.sortOrder !== null && episode?.sortOrder !== undefined) {
    const sortOrder = Number(episode.sortOrder);
    if (Number.isFinite(sortOrder)) return sortOrder;
  }

  const episodeNumber = parseEpisodeOrderNumber(episode?.episodeNumber);
  if (episodeNumber !== null) return episodeNumber;

  const id = Number(episode?.id);
  return Number.isFinite(id) ? id : Number.MAX_SAFE_INTEGER;
}

function compareNavigationEpisodes(a: any, b: any): number {
  const orderA = getNavigationOrderValue(a);
  const orderB = getNavigationOrderValue(b);

  if (orderA !== orderB) return orderA - orderB;

  const idA = Number(a?.id) || 0;
  const idB = Number(b?.id) || 0;
  return idA - idB;
}

function toSafeNavigationEpisode(episode: any) {
  if (!episode) return null;

  return {
    id: episode.id,
    novelId: episode.novelId,
    episodeNumber: episode.episodeNumber,
    title: episode.title,
    isFree: episode.isFree,
    isPublished: episode.isPublished,
    sortOrder: episode.sortOrder,
  };
}

/**
 * Check if user has actually purchased an episode (real purchase only).
 *
 * This is deliberately narrow: it does NOT consider admin role and does NOT
 * consider free episodes. It answers exactly one question - "does a real
 * purchase record exist for this user+episode" - by checking both purchase
 * sources:
 * - episodePurchases (wallet direct chapter purchase)
 * - purchases (legacy order-based purchase)
 *
 * Callers that need "can this user read/access the episode" (which also
 * covers free episodes and admin override) should use canReadEpisode()
 * instead. Conflating the two previously caused admin logins to make every
 * episode/file appear "purchased" in the Novel Detail UI, since canReadEpisode
 * returns true unconditionally for admins.
 */
export async function hasPurchasedEpisode(userId: number | undefined, episodeId: number): Promise<boolean> {
  if (!userId) return false;

  const db = await getDb();
  if (!db) return false;

  // Check wallet-based purchase (minimal select for existence check)
  const walletPurchase = await db
    .select({ id: episodePurchases.id })
    .from(episodePurchases)
    .where(and(eq(episodePurchases.userId, userId), eq(episodePurchases.episodeId, episodeId)))
    .limit(1);

  if (walletPurchase.length > 0) return true;

  // Check order-based purchase (legacy system)
  const orderPurchase = await db
    .select({ id: purchases.id })
    .from(purchases)
    .where(and(eq(purchases.userId, userId), eq(purchases.episodeId, episodeId)))
    .limit(1);

  return orderPurchase.length > 0;
}

/**
 * Check if user can read an episode
 * Returns true if:
 * - Episode is free
 * - User purchased episode via wallet (episodePurchases)
 * - User purchased via order (purchases table)
 * - User is admin
 *
 * NOTE: this answers "can read/access", not "did the user pay for it".
 * Do not use this to compute an `isPurchased`/"unlocked" badge - use
 * hasPurchasedEpisode() for that, otherwise admin logins and free episodes
 * will incorrectly show as purchased.
 */
export async function canReadEpisode(userId: number | undefined, episodeId: number, isAdmin: boolean = false): Promise<boolean> {
  if (isAdmin) return true;
  if (!userId) return false;

  const db = await getDb();
  if (!db) return false;

  const episode = await db.select({ id: episodes.id, isFree: episodes.isFree }).from(episodes).where(eq(episodes.id, episodeId)).limit(1);
  if (episode.length === 0) return false;

  // Free episodes are readable by everyone
  if (episode[0].isFree) return true;

  return hasPurchasedEpisode(userId, episodeId);
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
  const saleMode = resolveSaleMode(ep);

  // Package episodes bundle many chapters into one row, so a "previous/next
  // episode" concept doesn't map cleanly onto the novel's episode list -
  // suppress navigation for packages rather than show a confusing adjacent
  // chapter/package jump. Chapter navigation is unaffected.
  let previousEpisode: any = null;
  let nextEpisode: any = null;

  if (saleMode !== "package") {
    // Build previous/next metadata from the published episode list. Select
    // only safe navigation fields so adjacent locked chapters never leak
    // `content`.
    const navigationEpisodes = await db
      .select({
        id: episodes.id,
        novelId: episodes.novelId,
        episodeNumber: episodes.episodeNumber,
        title: episodes.title,
        isFree: episodes.isFree,
        isPublished: episodes.isPublished,
        sortOrder: episodes.sortOrder,
      })
      .from(episodes)
      .where(and(eq(episodes.novelId, ep.novelId), eq(episodes.isPublished, true)))
      .orderBy(asc(episodes.id));

    const sortedNavigationEpisodes = [...navigationEpisodes].sort(compareNavigationEpisodes);
    const currentIndex = sortedNavigationEpisodes.findIndex((navEpisode) => navEpisode.id === ep.id);
    previousEpisode = currentIndex > 0 ? sortedNavigationEpisodes[currentIndex - 1] : null;
    nextEpisode = currentIndex >= 0 && currentIndex < sortedNavigationEpisodes.length - 1
      ? sortedNavigationEpisodes[currentIndex + 1]
      : null;
  }

  // Check if already purchased. Must check both purchase sources (wallet
  // direct episodePurchases + legacy order-based purchases) via the shared
  // helper, otherwise a legacy purchase would incorrectly show as unpurchased
  // here even though canReadEpisode() already grants access for it.
  const alreadyPurchased = userId && !ep.isFree ? await hasPurchasedEpisode(userId, episodeId) : false;

  // Sanitize episode object to not leak content/fileUrl in the API response.
  // fileUrl must never reach a user who hasn't purchased/can't read the
  // episode - previously it was left in unconditionally (only `content` was
  // stripped), leaking legacy Docs/PDF links to any authenticated user.
  const { content: _content, fileUrl: _fileUrl, ...safeEpisode } = ep;
  const hasContent = Boolean(ep.content && String(ep.content).trim().length > 0);
  const hasLegacyFile = Boolean(ep.fileUrl && String(ep.fileUrl).trim().length > 0);

  const result: ReaderEpisodeData = {
    episode: {
      ...safeEpisode,
      hasContent,
      hasLegacyFile,
      fileUrl: canRead ? ep.fileUrl ?? null : null,
    },
    novel,
    canRead,
    isLocked: !canRead && !ep.isFree,
    alreadyPurchased,
    saleMode,
    previousEpisode: toSafeNavigationEpisode(previousEpisode),
    nextEpisode: toSafeNavigationEpisode(nextEpisode),
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
