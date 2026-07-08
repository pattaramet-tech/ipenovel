import { getDb } from "../db";
import * as db from "../db";
import { purchases, episodePurchases } from "../../drizzle/schema";
import { computeContentFlags, resolveSaleMode, normalizeEpisodeRange, type EpisodeSaleMode } from "./readerService";

/**
 * Phase 1 - Hybrid Content Health Dashboard (read-only).
 *
 * Surfaces the exact risk classes described in the hybrid package incident:
 * episodes with neither web content nor a legacy file (unreadable even to a
 * paying customer), packages whose episodeNumber can't be normalized into a
 * range (import matching would silently fail to find them), and duplicate
 * normalized ranges within a novel (import matching becomes ambiguous and
 * refuses to auto-update, per packageZipImportService's ambiguous-match
 * guard).
 *
 * Note on "metadata doesn't reflect hasContent/hasLegacyFile" as a warning
 * class: since Phase 1 centralized that computation into
 * readerService.computeContentFlags() (the single source of truth used by
 * novels.episodes, reader.getEpisode, and this dashboard), there is no
 * longer any code path that could compute those flags differently - the
 * class of bug is closed structurally rather than caught at runtime, so it
 * is intentionally not modeled as a warning here.
 */

export interface NovelHealthSummary {
  novelId: number;
  title: string;
  totalEpisodes: number;
  contentCount: number;
  legacyFileCount: number;
  hybridCount: number;
  missingBothCount: number;
  packageCount: number;
  chapterCount: number;
  duplicateNormalizedRangeCount: number;
  riskyEpisodeCount: number;
}

export interface EpisodeHealthWarning {
  code: "MISSING_BOTH" | "UNPARSEABLE_RANGE" | "DUPLICATE_RANGE" | "PURCHASED_BUT_UNREADABLE";
  message: string;
}

export interface EpisodeHealthDetail {
  episodeId: number;
  episodeNumber: string;
  normalizedRange: string;
  episodeTitle: string;
  saleMode: EpisodeSaleMode;
  isPublished: boolean;
  hasContent: boolean;
  hasLegacyFile: boolean;
  hasBoth: boolean;
  missingBoth: boolean;
  price: string;
  sortOrder: number | null;
  warnings: EpisodeHealthWarning[];
}

function isValidNormalizedRange(normalized: string): boolean {
  return normalized.length > 0 && /\d/.test(normalized);
}

function computeNormalizedRangeCounts(episodesForNovel: any[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const ep of episodesForNovel) {
    const key = normalizeEpisodeRange(ep.episodeNumber);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function buildEpisodeWarnings(
  saleMode: EpisodeSaleMode,
  normalizedRange: string,
  isDuplicateRange: boolean,
  isPurchased: boolean,
  hasContent: boolean,
  hasLegacyFile: boolean
): EpisodeHealthWarning[] {
  const warnings: EpisodeHealthWarning[] = [];

  if (!hasContent && !hasLegacyFile) {
    warnings.push({ code: "MISSING_BOTH", message: "ไม่มีทั้ง content และ fileUrl - เปิดอ่านไม่ได้แม้ลูกค้าซื้อแล้ว" });
  }
  if (saleMode === "package" && !isValidNormalizedRange(normalizedRange)) {
    warnings.push({ code: "UNPARSEABLE_RANGE", message: "saleMode เป็น package แต่ episodeNumber/range normalize เป็นเลขไม่ได้ - ZIP import จะหาตอนนี้ไม่เจอ" });
  }
  if (isDuplicateRange) {
    warnings.push({
      code: "DUPLICATE_RANGE",
      message: `normalizedRange "${normalizedRange}" ซ้ำกับตอนอื่นในนิยายเดียวกัน - ZIP import จะ block และรายงาน error แทนการเดา`,
    });
  }
  if (isPurchased && !hasContent && !hasLegacyFile) {
    warnings.push({ code: "PURCHASED_BUT_UNREADABLE", message: "มีลูกค้าซื้อตอนนี้ไปแล้ว แต่ตอนนี้ไม่มี content หรือ fileUrl ให้อ่านเลย" });
  }

  return warnings;
}

function toEpisodeHealthDetail(
  ep: any,
  rangeCounts: Map<string, number>,
  purchasedEpisodeIds: Set<number>
): EpisodeHealthDetail {
  const { hasContent, hasLegacyFile } = computeContentFlags(ep);
  const saleMode = resolveSaleMode(ep);
  const normalizedRange = normalizeEpisodeRange(ep.episodeNumber);
  const isDuplicateRange = (rangeCounts.get(normalizedRange) ?? 0) > 1;
  const isPurchased = purchasedEpisodeIds.has(ep.id);

  return {
    episodeId: ep.id,
    episodeNumber: String(ep.episodeNumber ?? ""),
    normalizedRange,
    episodeTitle: ep.title,
    saleMode,
    isPublished: Boolean(ep.isPublished),
    hasContent,
    hasLegacyFile,
    hasBoth: hasContent && hasLegacyFile,
    missingBoth: !hasContent && !hasLegacyFile,
    price: ep.price,
    sortOrder: ep.sortOrder ?? null,
    warnings: buildEpisodeWarnings(saleMode, normalizedRange, isDuplicateRange, isPurchased, hasContent, hasLegacyFile),
  };
}

function summarizeNovel(novel: any, episodesForNovel: any[], purchasedEpisodeIds: Set<number>): NovelHealthSummary {
  const rangeCounts = computeNormalizedRangeCounts(episodesForNovel);

  let contentCount = 0;
  let legacyFileCount = 0;
  let hybridCount = 0;
  let missingBothCount = 0;
  let packageCount = 0;
  let chapterCount = 0;
  let duplicateNormalizedRangeCount = 0;
  let riskyEpisodeCount = 0;

  for (const ep of episodesForNovel) {
    const detail = toEpisodeHealthDetail(ep, rangeCounts, purchasedEpisodeIds);

    if (detail.hasContent) contentCount++;
    if (detail.hasLegacyFile) legacyFileCount++;
    if (detail.hasBoth) hybridCount++;
    if (detail.missingBoth) missingBothCount++;
    if (detail.saleMode === "package") packageCount++;
    else chapterCount++;
    if (detail.warnings.some((w) => w.code === "DUPLICATE_RANGE")) duplicateNormalizedRangeCount++;
    if (detail.warnings.length > 0) riskyEpisodeCount++;
  }

  return {
    novelId: novel.id,
    title: novel.title,
    totalEpisodes: episodesForNovel.length,
    contentCount,
    legacyFileCount,
    hybridCount,
    missingBothCount,
    packageCount,
    chapterCount,
    duplicateNormalizedRangeCount,
    riskyEpisodeCount,
  };
}

/** All distinct episodeIds with at least one purchase record, across both
 *  purchase sources (order-based `purchases` + wallet-direct
 *  `episodePurchases`). Two lightweight queries regardless of novel count. */
async function getAllPurchasedEpisodeIds(): Promise<Set<number>> {
  const database = await getDb();
  if (!database) return new Set();

  const [orderBased, walletBased] = await Promise.all([
    database.select({ episodeId: purchases.episodeId }).from(purchases),
    database.select({ episodeId: episodePurchases.episodeId }).from(episodePurchases),
  ]);

  return new Set<number>([...orderBased.map((r: any) => r.episodeId), ...walletBased.map((r: any) => r.episodeId)]);
}

async function getPurchasedEpisodeIdsForNovel(novelId: number): Promise<Set<number>> {
  const database = await getDb();
  if (!database) return new Set();

  const { eq } = await import("drizzle-orm");
  const [orderBased, walletBased] = await Promise.all([
    database.select({ episodeId: purchases.episodeId }).from(purchases).where(eq(purchases.novelId, novelId)),
    database.select({ episodeId: episodePurchases.episodeId }).from(episodePurchases).where(eq(episodePurchases.novelId, novelId)),
  ]);

  return new Set<number>([...orderBased.map((r: any) => r.episodeId), ...walletBased.map((r: any) => r.episodeId)]);
}

/** Overview row per novel - read-only, no writes anywhere in this module. */
export async function getAllNovelHealthOverview(): Promise<NovelHealthSummary[]> {
  const [novels, allEpisodes, purchasedEpisodeIds] = await Promise.all([
    db.getAllNovelsForAdmin(),
    db.getAllEpisodes(),
    getAllPurchasedEpisodeIds(),
  ]);

  const episodesByNovel = new Map<number, any[]>();
  for (const ep of allEpisodes as any[]) {
    const list = episodesByNovel.get(ep.novelId) ?? [];
    list.push(ep);
    episodesByNovel.set(ep.novelId, list);
  }

  return (novels as any[]).map((novel) => summarizeNovel(novel, episodesByNovel.get(novel.id) ?? [], purchasedEpisodeIds));
}

/** Episode-level detail for one novel - read-only. */
export async function getNovelHealthDetail(novelId: number): Promise<EpisodeHealthDetail[]> {
  const [episodesForNovel, purchasedEpisodeIds] = await Promise.all([
    db.getEpisodesByNovelId(novelId),
    getPurchasedEpisodeIdsForNovel(novelId),
  ]);

  const rangeCounts = computeNormalizedRangeCounts(episodesForNovel as any[]);
  return (episodesForNovel as any[]).map((ep) => toEpisodeHealthDetail(ep, rangeCounts, purchasedEpisodeIds));
}
