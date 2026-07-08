import { eq } from "drizzle-orm";
import { getDb } from "../db";
import * as db from "../db";
import { users, episodePurchases } from "../../drizzle/schema";
import { computeContentFlags, resolveSaleMode, type EpisodeSaleMode } from "./readerService";

/**
 * Phase 1 - Admin User Entitlement Lookup (read-only).
 *
 * Answers "what can this user actually read, and why" for support/debugging
 * - never mutates anything. Deliberately does not return a raw legacy
 * fileUrl string; only whether one exists and whether this user's session
 * would be granted it (`hasLegacyFile` / `fileUrlVisible`), matching the
 * "never show a full fileUrl to admins without cause" rule.
 */

export type EntitlementVisibleAction = "read_web" | "open_legacy_file" | "both" | "no_content_available" | "no_access";

export interface EntitlementEpisodeResult {
  novelId: number;
  novelTitle: string;
  episodeId: number;
  episodeNumber: string;
  episodeTitle: string;
  saleMode: EpisodeSaleMode;
  hasContent: boolean;
  hasLegacyFile: boolean;
  canRead: boolean;
  fileUrlVisible: boolean;
  visibleAction: EntitlementVisibleAction;
  purchaseSource: "order" | "wallet";
  purchasedAt: Date | null;
  progress: {
    progressPercent: number;
    lastReadAt: Date;
    currentChapterNumber: string | null;
    currentChapterTitle: string | null;
  } | null;
}

export interface EntitlementLookupOrderSummary {
  orderId: number;
  orderNumber: string;
  status: string;
  paymentStatus: string;
  totalAmount: string;
  createdAt: Date;
}

export interface EntitlementLookupResult {
  matched: true;
  userId: number;
  email: string | null;
  name: string | null;
  orders: EntitlementLookupOrderSummary[];
  purchasedEpisodes: EntitlementEpisodeResult[];
}

export interface EntitlementLookupAmbiguous {
  matched: false;
  reason: "not_found" | "ambiguous";
  candidates: Array<{ userId: number; email: string | null; name: string | null }>;
}

function computeVisibleAction(canRead: boolean, hasContent: boolean, hasLegacyFile: boolean): EntitlementVisibleAction {
  if (!canRead) return "no_access";
  if (hasContent && hasLegacyFile) return "both";
  if (hasContent) return "read_web";
  if (hasLegacyFile) return "open_legacy_file";
  return "no_content_available";
}

async function resolveUserId(input: { email?: string; userId?: number; orderId?: number }): Promise<number | EntitlementLookupAmbiguous> {
  if (input.userId) return input.userId;

  if (input.orderId) {
    const order = await db.getOrderById(input.orderId);
    if (!order || !order.userId) {
      return { matched: false, reason: "not_found", candidates: [] };
    }
    return order.userId;
  }

  if (input.email) {
    const database = await getDb();
    if (!database) return { matched: false, reason: "not_found", candidates: [] };

    const { like } = await import("drizzle-orm");
    const trimmed = input.email.trim();
    const matches = await database
      .select({ id: users.id, email: users.email, name: users.name })
      .from(users)
      .where(like(users.email, `%${trimmed}%`))
      .limit(10);

    if (matches.length === 0) return { matched: false, reason: "not_found", candidates: [] };
    if (matches.length > 1) {
      return {
        matched: false,
        reason: "ambiguous",
        candidates: matches.map((u: any) => ({ userId: u.id, email: u.email, name: u.name })),
      };
    }
    return matches[0].id;
  }

  return { matched: false, reason: "not_found", candidates: [] };
}

/** All wallet-direct purchases for a user (episodePurchases table). */
async function getWalletPurchasesByUserId(userId: number) {
  const database = await getDb();
  if (!database) return [];
  return database.select().from(episodePurchases).where(eq(episodePurchases.userId, userId));
}

export async function lookupUserEntitlements(
  input: { email?: string; userId?: number; orderId?: number }
): Promise<EntitlementLookupResult | EntitlementLookupAmbiguous> {
  const resolved = await resolveUserId(input);
  if (typeof resolved !== "number") return resolved;

  const userId = resolved;
  const user = await db.getUserById(userId);
  if (!user) return { matched: false, reason: "not_found", candidates: [] };

  const [orders, orderPurchases, walletPurchases] = await Promise.all([
    db.getOrdersByUserId(userId),
    db.getPurchasesByUserId(userId),
    getWalletPurchasesByUserId(userId),
  ]);

  // Merge both purchase sources into one { episodeId -> { source, purchasedAt } }
  // map. An episode purchased through both paths (shouldn't normally happen)
  // keeps whichever was recorded first as the source of truth for display.
  const purchaseByEpisodeId = new Map<number, { source: "order" | "wallet"; purchasedAt: Date | null }>();
  for (const p of orderPurchases as any[]) {
    if (!purchaseByEpisodeId.has(p.episodeId)) {
      purchaseByEpisodeId.set(p.episodeId, { source: "order", purchasedAt: p.grantedAt ?? null });
    }
  }
  for (const p of walletPurchases as any[]) {
    if (!purchaseByEpisodeId.has(p.episodeId)) {
      purchaseByEpisodeId.set(p.episodeId, { source: "wallet", purchasedAt: p.purchasedAt ?? null });
    }
  }

  const episodeIds = Array.from(purchaseByEpisodeId.keys());
  const progressMap = await db.getReadingProgressBatch(userId, episodeIds);

  const purchasedEpisodes: EntitlementEpisodeResult[] = [];
  for (const episodeId of episodeIds) {
    const episode: any = await db.getEpisodeById(episodeId);
    if (!episode) continue; // episode was deleted after purchase - nothing to show

    const novel = await db.getNovelById(episode.novelId, false);
    const { hasContent, hasLegacyFile } = computeContentFlags(episode);
    const saleMode = resolveSaleMode(episode);
    // A purchase record exists for this exact episode, so access is granted
    // (mirrors readerService.hasPurchasedEpisode - free/admin bypass doesn't
    // apply here since we're specifically listing paid purchase records).
    const canRead = true;
    const fileUrlVisible = canRead && hasLegacyFile;
    const purchaseInfo = purchaseByEpisodeId.get(episodeId)!;
    const progress = progressMap.get(episodeId);

    purchasedEpisodes.push({
      novelId: episode.novelId,
      novelTitle: novel?.title ?? "(ไม่พบนิยาย)",
      episodeId: episode.id,
      episodeNumber: String(episode.episodeNumber ?? ""),
      episodeTitle: episode.title,
      saleMode,
      hasContent,
      hasLegacyFile,
      canRead,
      fileUrlVisible,
      visibleAction: computeVisibleAction(canRead, hasContent, hasLegacyFile),
      purchaseSource: purchaseInfo.source,
      purchasedAt: purchaseInfo.purchasedAt,
      progress: progress
        ? {
            progressPercent: progress.progressPercent,
            lastReadAt: progress.lastReadAt,
            currentChapterNumber: progress.currentChapterNumber ?? null,
            currentChapterTitle: progress.currentChapterTitle ?? null,
          }
        : null,
    });
  }

  return {
    matched: true,
    userId: user.id,
    email: user.email ?? null,
    name: user.name ?? null,
    orders: (orders as any[]).map((o) => ({
      orderId: o.id,
      orderNumber: o.orderNumber,
      status: o.status,
      paymentStatus: o.paymentStatus,
      totalAmount: o.totalAmount,
      createdAt: o.createdAt,
    })),
    purchasedEpisodes,
  };
}
