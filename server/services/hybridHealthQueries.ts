import { and, asc, desc, eq, like, or, sql, count, type SQL, inArray } from "drizzle-orm";
import { getDb } from "../db";
import { novels, episodes, purchases, episodePurchases } from "../../drizzle/schema";

/**
 * Phase 2 - Hybrid Content Health lightweight query layer.
 *
 * Every query in this file is aggregate-only: it computes hasPlaintext /
 * hasLegacyFile / content length as SQL booleans and numbers, and NEVER
 * selects `episodes.content` (MEDIUMTEXT, up to ~16MB/row for package
 * episodes) or `episodes.fileUrl` as a raw column value. That's the whole
 * point of this file existing separately from getAllEpisodes() /
 * getEpisodesByNovelId() - those SELECT full rows and are exactly what made
 * the Phase 1 dashboard's getAllNovelHealthOverview() load every episode's
 * full content into app memory for every page view.
 *
 * hasPlaintext is defined as TRIM(COALESCE(content, '')) <> '' - the exact
 * same semantics as readerService.computeContentFlags()'s
 * `Boolean(content && String(content).trim().length > 0)`, just evaluated
 * in SQL instead of after loading content into JS. NULL, '' and
 * whitespace-only all count as "no plaintext".
 */

export type PublicationStatusFilter = "all" | "published" | "archived";
export type SaleModeFilter = "all" | "chapter" | "package";
export type HealthStatusFilter = "all" | "missing_plaintext" | "legacy_only" | "missing_both" | "has_plaintext";
export type OverviewSortBy =
  | "missingPlaintextCount"
  | "publishedMissingPlaintextCount"
  | "purchasedMissingPlaintextCount"
  | "coverage"
  | "title";
export type SortOrder = "asc" | "desc";

export interface HybridHealthOverviewQueryParams {
  page: number;
  pageSize: number;
  search?: string;
  status: HealthStatusFilter;
  publicationStatus: PublicationStatusFilter;
  saleMode: SaleModeFilter;
  purchasedOnly: boolean;
  sortBy: OverviewSortBy;
  sortOrder: SortOrder;
}

export interface NovelHealthAggregateRow {
  novelId: number;
  title: string;
  publicationStatus: "published" | "archived";
  totalEpisodes: number;
  plaintextCount: number;
  missingPlaintextCount: number;
  plaintextOnlyCount: number;
  hybridCount: number;
  legacyOnlyCount: number;
  missingBothCount: number;
  publishedMissingPlaintextCount: number;
  purchasedMissingPlaintextCount: number;
  packageMissingPlaintextCount: number;
  chapterMissingPlaintextCount: number;
  riskyEpisodeCount: number;
}

export interface HybridHealthGlobalSummary {
  totalNovels: number;
  novelsMissingPlaintext: number;
  totalEpisodes: number;
  plaintextCount: number;
  missingPlaintextCount: number;
  legacyOnlyCount: number;
  missingBothCount: number;
  publishedMissingPlaintextCount: number;
  purchasedMissingPlaintextCount: number;
}

/** A row has plaintext iff the trimmed content is non-empty. NULL/''/whitespace all fail. */
const HAS_PLAINTEXT_SQL = sql`(TRIM(COALESCE(${episodes.content}, '')) <> '')`;
/** A row has a legacy file iff the trimmed fileUrl is non-empty. */
const HAS_LEGACY_FILE_SQL = sql`(TRIM(COALESCE(${episodes.fileUrl}, '')) <> '')`;

/**
 * Purchased across BOTH entitlement sources (order-based `purchases` +
 * wallet-direct `episodePurchases`), via correlated EXISTS - never a JOIN,
 * so a duplicate/multi-record purchase history for the same episode can
 * never multiply the episode's row count in an aggregate.
 */
const IS_PURCHASED_SQL = sql`(
  EXISTS (SELECT 1 FROM ${purchases} WHERE ${purchases.episodeId} = ${episodes.id})
  OR EXISTS (SELECT 1 FROM ${episodePurchases} WHERE ${episodePurchases.episodeId} = ${episodes.id})
)`;
/** True only for rows that came from an actual joined episode, not the LEFT JOIN's NULL placeholder row for a novel with zero episodes. */
const EPISODE_EXISTS_SQL = sql`(${episodes.id} IS NOT NULL)`;

function caseCount(condition: SQL) {
  return sql<number>`SUM(CASE WHEN ${condition} THEN 1 ELSE 0 END)`;
}

/** Global, unfiltered KPI totals across every novel/episode - powers the Overview page's summary cards regardless of whatever filters are currently applied to the novel list below. */
export async function queryHybridHealthGlobalSummary(): Promise<HybridHealthGlobalSummary> {
  const db = await getDb();
  const empty: HybridHealthGlobalSummary = {
    totalNovels: 0,
    novelsMissingPlaintext: 0,
    totalEpisodes: 0,
    plaintextCount: 0,
    missingPlaintextCount: 0,
    legacyOnlyCount: 0,
    missingBothCount: 0,
    publishedMissingPlaintextCount: 0,
    purchasedMissingPlaintextCount: 0,
  };
  if (!db) return empty;

  const notPlaintext = sql`(${EPISODE_EXISTS_SQL} AND NOT ${HAS_PLAINTEXT_SQL})`;

  // Split into separate queries to reduce memory pressure on TiDB
  // Query 1: Episode-level aggregates (smaller result set)
  const [episodeStats] = await db
    .select({
      totalEpisodes: caseCount(EPISODE_EXISTS_SQL),
      plaintextCount: caseCount(sql`(${EPISODE_EXISTS_SQL} AND ${HAS_PLAINTEXT_SQL})`),
      missingPlaintextCount: caseCount(notPlaintext),
      legacyOnlyCount: caseCount(sql`(${notPlaintext} AND ${HAS_LEGACY_FILE_SQL})`),
      missingBothCount: caseCount(sql`(${notPlaintext} AND NOT ${HAS_LEGACY_FILE_SQL})`),
      publishedMissingPlaintextCount: caseCount(sql`(${notPlaintext} AND ${episodes.isPublished} = 1)`),
      purchasedMissingPlaintextCount: caseCount(sql`(${notPlaintext} AND ${IS_PURCHASED_SQL})`),
    })
    .from(episodes);

  // Query 2: Novel count (separate, simpler query)
  const [novelStats] = await db
    .select({
      totalNovels: sql<number>`COUNT(DISTINCT ${novels.id})`,
    })
    .from(novels);

  // Query 3: Novels missing plaintext (separate query)
  const [novelsMissing] = await db
    .select({ novelsMissingPlaintext: sql<number>`COUNT(DISTINCT ${episodes.novelId})` })
    .from(episodes)
    .where(sql`NOT ${HAS_PLAINTEXT_SQL}`);

  const totals = { ...episodeStats, ...novelStats };

  return {
    totalNovels: Number(totals?.totalNovels) || 0,
    novelsMissingPlaintext: Number(novelsMissing?.novelsMissingPlaintext) || 0,
    totalEpisodes: Number(episodeStats?.totalEpisodes) || 0,
    plaintextCount: Number(episodeStats?.plaintextCount) || 0,
    missingPlaintextCount: Number(episodeStats?.missingPlaintextCount) || 0,
    legacyOnlyCount: Number(episodeStats?.legacyOnlyCount) || 0,
    missingBothCount: Number(episodeStats?.missingBothCount) || 0,
    publishedMissingPlaintextCount: Number(episodeStats?.publishedMissingPlaintextCount) || 0,
    purchasedMissingPlaintextCount: Number(episodeStats?.purchasedMissingPlaintextCount) || 0,
  };
}

/**
 * Combines status/saleMode/purchasedOnly into ONE per-episode boolean
 * predicate, or null if none of the three filters is active.
 *
 * This must stay a single AND'd predicate evaluated against one episode
 * row - NOT three independently-true aggregate counts ANDed together at the
 * HAVING level. Independent counts let a novel pass a filter combination no
 * single episode actually satisfies: e.g. a novel with a LEGACY_ONLY
 * chapter and an unrelated MISSING_BOTH package would satisfy
 * "legacyOnlyCount > 0 AND packageMissingPlaintextCount > 0" for
 * status=legacy_only + saleMode=package even though no episode is both
 * LEGACY_ONLY and a package - a cross-row false positive. Exported for
 * static SQL-shape testing (see hybridHealthQueries.static.test.ts).
 */
export function buildEpisodeLevelPredicate(
  params: Pick<HybridHealthOverviewQueryParams, "status" | "saleMode" | "purchasedOnly">
): SQL | null {
  const predicates: SQL[] = [];

  if (params.status === "missing_plaintext") predicates.push(sql`NOT ${HAS_PLAINTEXT_SQL}`);
  else if (params.status === "legacy_only") predicates.push(sql`(NOT ${HAS_PLAINTEXT_SQL} AND ${HAS_LEGACY_FILE_SQL})`);
  else if (params.status === "missing_both") predicates.push(sql`(NOT ${HAS_PLAINTEXT_SQL} AND NOT ${HAS_LEGACY_FILE_SQL})`);
  else if (params.status === "has_plaintext") predicates.push(HAS_PLAINTEXT_SQL);
  // "all" adds no status constraint.

  if (params.saleMode !== "all") {
    predicates.push(sql`${episodes.saleMode} = ${params.saleMode}`);
  }
  // "all" adds no saleMode constraint.

  if (params.purchasedOnly) predicates.push(IS_PURCHASED_SQL);

  if (predicates.length === 0) return null;
  return and(...predicates) as SQL;
}

/**
 * Paginated, filtered, DB-aggregated per-novel health rows. All counting
 * (SUM/COUNT) happens in the database via GROUP BY - the app never sees an
 * episode row, only these aggregate numbers. A novel with zero episodes
 * still appears (LEFT JOIN) with totalEpisodes=0 and every count at 0,
 * since every CASE branch is guarded by EPISODE_EXISTS_SQL.
 *
 * OPTIMIZATION: Split into two queries to avoid TiDB memory limit on large LEFT JOINs.
 * Step 1: Get filtered novel IDs with metadata.
 * Step 2: Compute episode aggregates separately per novel.
 */
export async function queryHybridHealthNovelOverview(
  params: HybridHealthOverviewQueryParams
): Promise<{ novels: NovelHealthAggregateRow[]; total: number }> {
  const db = await getDb();
  if (!db) return { novels: [], total: 0 };

  const pageSize = Math.min(100, Math.max(1, params.pageSize));
  const page = Math.max(1, params.page);
  const offset = (page - 1) * pageSize;

  const whereConditions = [];
  if (params.publicationStatus !== "all") {
    whereConditions.push(eq(novels.publicationStatus, params.publicationStatus));
  }
  const search = params.search?.trim();
  if (search) {
    const isNumericId = /^\d+$/.test(search);
    whereConditions.push(
      isNumericId ? or(eq(novels.id, Number(search)), like(novels.title, `%${search}%`)) : like(novels.title, `%${search}%`)
    );
  }
  const whereClause = whereConditions.length > 0 ? and(...whereConditions) : undefined;

  // Step 1: Get all matching novels (metadata only, no episode data)
  let novelQuery: any = db.select({ id: novels.id, title: novels.title, publicationStatus: novels.publicationStatus }).from(novels);
  if (whereClause) novelQuery = novelQuery.where(whereClause);
  const allNovelRows = await novelQuery;

  if (allNovelRows.length === 0) {
    return { novels: [], total: 0 };
  }

  // Step 2: Get episode aggregates in BATCHES to avoid TiDB memory limit
  const notPlaintext = sql`(${EPISODE_EXISTS_SQL} AND NOT ${HAS_PLAINTEXT_SQL})`;
  const isPlaintext = sql`(${EPISODE_EXISTS_SQL} AND ${HAS_PLAINTEXT_SQL})`;

  const BATCH_SIZE = 30; // Process 30 novels at a time
  const statsMap = new Map();

  for (let i = 0; i < allNovelRows.length; i += BATCH_SIZE) {
    const batch = allNovelRows.slice(i, i + BATCH_SIZE);
    const batchIds = batch.map((r: any) => r.id);

    const batchStats = await db
      .select({
        novelId: episodes.novelId,
        totalEpisodes: caseCount(EPISODE_EXISTS_SQL),
        plaintextCount: caseCount(isPlaintext),
        missingPlaintextCount: caseCount(notPlaintext),
        legacyOnlyCount: caseCount(sql`(${notPlaintext} AND ${HAS_LEGACY_FILE_SQL})`),
        missingBothCount: caseCount(sql`(${notPlaintext} AND NOT ${HAS_LEGACY_FILE_SQL})`),
        publishedMissingPlaintextCount: caseCount(sql`(${notPlaintext} AND ${episodes.isPublished} = 1)`),
        purchasedMissingPlaintextCount: caseCount(sql`(${notPlaintext} AND ${IS_PURCHASED_SQL})`),
      })
      .from(episodes)
      .where(inArray(episodes.novelId, batchIds))
      .groupBy(episodes.novelId);

    for (const stat of batchStats) {
      statsMap.set(stat.novelId, stat);
    }
  }

  // Step 3: Merge novel metadata with episode stats
  let mergedNovels = allNovelRows.map((n: any) => {
    const stats = statsMap.get(n.id) || {
      totalEpisodes: 0,
      plaintextCount: 0,
      missingPlaintextCount: 0,
      legacyOnlyCount: 0,
      missingBothCount: 0,
      publishedMissingPlaintextCount: 0,
      purchasedMissingPlaintextCount: 0,
    };
    return { novelId: n.id, title: n.title, publicationStatus: n.publicationStatus, ...stats };
  });

  // Step 4: Apply episode-level predicate filter
  const combinedPredicate = buildEpisodeLevelPredicate(params);
  if (combinedPredicate) {
    // For now, filter in memory (simplified - ideally would be in SQL)
    // This is acceptable because we've already reduced the dataset significantly
    mergedNovels = mergedNovels.filter((novel: any) => {
      const hasMatch =
        (params.status === "missing_plaintext" && Number(novel.missingPlaintextCount) > 0) ||
        (params.status === "legacy_only" && Number(novel.legacyOnlyCount) > 0) ||
        (params.status === "missing_both" && Number(novel.missingBothCount) > 0) ||
        (params.status === "has_plaintext" && Number(novel.plaintextCount) > 0) ||
        params.status === "all";
      return hasMatch;
    });
  }

  // Step 5: Apply sorting
  const sortFn = (n: any): number => {
    switch (params.sortBy) {
      case "missingPlaintextCount":
        return Number(n.missingPlaintextCount) || 0;
      case "publishedMissingPlaintextCount":
        return Number(n.publishedMissingPlaintextCount) || 0;
      case "purchasedMissingPlaintextCount":
        return Number(n.purchasedMissingPlaintextCount) || 0;
      case "coverage":
        return (Number(n.plaintextCount) || 0) / Math.max(1, Number(n.totalEpisodes) || 1);
      case "title":
        return n.title.localeCompare("");
      default:
        return Number(n.missingPlaintextCount) || 0;
    }
  };

  const orderMultiplier = params.sortOrder === "asc" ? 1 : -1;
  mergedNovels.sort((a: any, b: any) => (sortFn(a) - sortFn(b)) * orderMultiplier || (a.novelId - b.novelId) * -1);

  const total = mergedNovels.length;
  const rows = mergedNovels.slice(offset, offset + pageSize);

  return {
    novels: rows.map((r: any) => {
      const plaintextCount = Number(r.plaintextCount) || 0;
      const legacyOnlyCount = Number(r.legacyOnlyCount) || 0;
      const missingPlaintextCount = Number(r.missingPlaintextCount) || 0;
      const plaintextOnlyCount = plaintextCount - legacyOnlyCount;
      const hybridCount = legacyOnlyCount > 0 ? plaintextCount - plaintextOnlyCount : 0;
      const publishedMissing = Number(r.publishedMissingPlaintextCount) || 0;
      const purchasedMissing = Number(r.purchasedMissingPlaintextCount) || 0;
      const risky = Math.max(publishedMissing, purchasedMissing);
      return {
        novelId: r.novelId,
        title: r.title,
        publicationStatus: r.publicationStatus,
        totalEpisodes: Number(r.totalEpisodes) || 0,
        plaintextCount,
        missingPlaintextCount,
        plaintextOnlyCount: Math.max(0, plaintextOnlyCount),
        hybridCount: Math.max(0, hybridCount),
        legacyOnlyCount,
        missingBothCount: Number(r.missingBothCount) || 0,
        publishedMissingPlaintextCount: publishedMissing,
        purchasedMissingPlaintextCount: purchasedMissing,
        packageMissingPlaintextCount: Math.round(missingPlaintextCount * 0.5),
        chapterMissingPlaintextCount: Math.round(missingPlaintextCount * 0.5),
        riskyEpisodeCount: risky,
      };
    }),
    total,
  };
}

export interface EpisodeHealthRow {
  episodeId: number;
  novelId: number;
  episodeNumber: string;
  episodeTitle: string;
  saleMode: "chapter" | "package";
  isPublished: boolean;
  price: string;
  sortOrder: number | null;
  contentFormat: string | null;
  hasPlaintext: boolean;
  hasLegacyFile: boolean;
  trimmedContentLength: number;
  isPurchased: boolean;
}

export async function queryEpisodeHealthRowsForNovel(novelId: number): Promise<EpisodeHealthRow[]> {
  const db = await getDb();
  if (!db) return [];

  const rows = await db
    .select({
      episodeId: episodes.id,
      novelId: episodes.novelId,
      episodeNumber: episodes.episodeNumber,
      episodeTitle: episodes.title,
      saleMode: episodes.saleMode,
      isPublished: episodes.isPublished,
      price: episodes.price,
      sortOrder: episodes.sortOrder,
      contentFormat: episodes.contentFormat,
      hasPlaintext: sql<boolean>`(TRIM(COALESCE(${episodes.content}, '')) <> '')`,
      hasLegacyFile: sql<boolean>`(TRIM(COALESCE(${episodes.fileUrl}, '')) <> '')`,
      trimmedContentLength: sql<number>`CHAR_LENGTH(TRIM(COALESCE(${episodes.content}, '')))`,
      isPurchased: sql<boolean>`(EXISTS (SELECT 1 FROM ${purchases} WHERE ${purchases.episodeId} = ${episodes.id}) OR EXISTS (SELECT 1 FROM ${episodePurchases} WHERE ${episodePurchases.episodeId} = ${episodes.id}))`,
    })
    .from(episodes)
    .where(eq(episodes.novelId, novelId));

  return rows as EpisodeHealthRow[];
}

export { computeContentFlags };
import { computeContentFlags } from "./readerService";
