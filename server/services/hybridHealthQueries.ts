import { and, asc, desc, eq, like, or, sql, count, type SQL } from "drizzle-orm";
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

  const [[totals], [novelsMissing]] = await Promise.all([
    db
      .select({
        totalNovels: sql<number>`COUNT(DISTINCT ${novels.id})`,
        totalEpisodes: caseCount(EPISODE_EXISTS_SQL),
        plaintextCount: caseCount(sql`(${EPISODE_EXISTS_SQL} AND ${HAS_PLAINTEXT_SQL})`),
        missingPlaintextCount: caseCount(notPlaintext),
        legacyOnlyCount: caseCount(sql`(${notPlaintext} AND ${HAS_LEGACY_FILE_SQL})`),
        missingBothCount: caseCount(sql`(${notPlaintext} AND NOT ${HAS_LEGACY_FILE_SQL})`),
        publishedMissingPlaintextCount: caseCount(sql`(${notPlaintext} AND ${episodes.isPublished} = 1)`),
        purchasedMissingPlaintextCount: caseCount(sql`(${notPlaintext} AND ${IS_PURCHASED_SQL})`),
      })
      .from(novels)
      .leftJoin(episodes, eq(episodes.novelId, novels.id)),
    db
      .select({ novelsMissingPlaintext: sql<number>`COUNT(DISTINCT ${episodes.novelId})` })
      .from(episodes)
      .where(sql`NOT ${HAS_PLAINTEXT_SQL}`),
  ]);

  return {
    totalNovels: Number(totals?.totalNovels) || 0,
    novelsMissingPlaintext: Number(novelsMissing?.novelsMissingPlaintext) || 0,
    totalEpisodes: Number(totals?.totalEpisodes) || 0,
    plaintextCount: Number(totals?.plaintextCount) || 0,
    missingPlaintextCount: Number(totals?.missingPlaintextCount) || 0,
    legacyOnlyCount: Number(totals?.legacyOnlyCount) || 0,
    missingBothCount: Number(totals?.missingBothCount) || 0,
    publishedMissingPlaintextCount: Number(totals?.publishedMissingPlaintextCount) || 0,
    purchasedMissingPlaintextCount: Number(totals?.purchasedMissingPlaintextCount) || 0,
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

  const notPlaintext = sql`(${EPISODE_EXISTS_SQL} AND NOT ${HAS_PLAINTEXT_SQL})`;
  const isPlaintext = sql`(${EPISODE_EXISTS_SQL} AND ${HAS_PLAINTEXT_SQL})`;

  const totalEpisodesExpr = caseCount(EPISODE_EXISTS_SQL);
  const plaintextCountExpr = caseCount(isPlaintext);
  const missingPlaintextCountExpr = caseCount(notPlaintext);
  const plaintextOnlyCountExpr = caseCount(sql`(${isPlaintext} AND NOT ${HAS_LEGACY_FILE_SQL})`);
  const hybridCountExpr = caseCount(sql`(${isPlaintext} AND ${HAS_LEGACY_FILE_SQL})`);
  const legacyOnlyCountExpr = caseCount(sql`(${notPlaintext} AND ${HAS_LEGACY_FILE_SQL})`);
  const missingBothCountExpr = caseCount(sql`(${notPlaintext} AND NOT ${HAS_LEGACY_FILE_SQL})`);
  const publishedMissingPlaintextCountExpr = caseCount(sql`(${notPlaintext} AND ${episodes.isPublished} = 1)`);
  const purchasedMissingPlaintextCountExpr = caseCount(sql`(${notPlaintext} AND ${IS_PURCHASED_SQL})`);
  const packageMissingPlaintextCountExpr = caseCount(sql`(${notPlaintext} AND ${episodes.saleMode} = 'package')`);
  const chapterMissingPlaintextCountExpr = caseCount(sql`(${notPlaintext} AND ${episodes.saleMode} = 'chapter')`);
  // "Risky" = missing plaintext AND already exposed to a reader (published)
  // or a paying customer (purchased) - a missing-plaintext draft that no
  // one can see yet is not yet operationally risky.
  const riskyEpisodeCountExpr = caseCount(sql`(${notPlaintext} AND (${episodes.isPublished} = 1 OR ${IS_PURCHASED_SQL}))`);

  let aggQuery: any = db
    .select({
      novelId: novels.id,
      title: novels.title,
      publicationStatus: novels.publicationStatus,
      totalEpisodes: totalEpisodesExpr.as("totalEpisodes"),
      plaintextCount: plaintextCountExpr.as("plaintextCount"),
      missingPlaintextCount: missingPlaintextCountExpr.as("missingPlaintextCount"),
      plaintextOnlyCount: plaintextOnlyCountExpr.as("plaintextOnlyCount"),
      hybridCount: hybridCountExpr.as("hybridCount"),
      legacyOnlyCount: legacyOnlyCountExpr.as("legacyOnlyCount"),
      missingBothCount: missingBothCountExpr.as("missingBothCount"),
      publishedMissingPlaintextCount: publishedMissingPlaintextCountExpr.as("publishedMissingPlaintextCount"),
      purchasedMissingPlaintextCount: purchasedMissingPlaintextCountExpr.as("purchasedMissingPlaintextCount"),
      packageMissingPlaintextCount: packageMissingPlaintextCountExpr.as("packageMissingPlaintextCount"),
      chapterMissingPlaintextCount: chapterMissingPlaintextCountExpr.as("chapterMissingPlaintextCount"),
      riskyEpisodeCount: riskyEpisodeCountExpr.as("riskyEpisodeCount"),
    })
    .from(novels)
    .leftJoin(episodes, eq(episodes.novelId, novels.id));
  if (whereClause) aggQuery = aggQuery.where(whereClause);
  aggQuery = aggQuery.groupBy(novels.id, novels.title, novels.publicationStatus);

  const combinedPredicate = buildEpisodeLevelPredicate(params);
  if (combinedPredicate) {
    const matchedEpisodeCountExpr = caseCount(sql`(${EPISODE_EXISTS_SQL} AND ${combinedPredicate})`);
    aggQuery = aggQuery.having(sql`${matchedEpisodeCountExpr} > 0`);
  }

  const filtered = aggQuery.as("filtered");

  const sortColumns: Record<OverviewSortBy, any> = {
    missingPlaintextCount: filtered.missingPlaintextCount,
    publishedMissingPlaintextCount: filtered.publishedMissingPlaintextCount,
    purchasedMissingPlaintextCount: filtered.purchasedMissingPlaintextCount,
    coverage: sql`(${filtered.plaintextCount} / NULLIF(${filtered.totalEpisodes}, 0))`,
    title: filtered.title,
  };
  const sortColumn = sortColumns[params.sortBy] ?? filtered.missingPlaintextCount;
  const orderFn = params.sortOrder === "asc" ? asc : desc;

  const [rows, countRows] = await Promise.all([
    db
      .select()
      .from(filtered)
      .orderBy(orderFn(sortColumn), desc(filtered.novelId))
      .limit(pageSize)
      .offset(offset),
    db.select({ total: count() }).from(filtered),
  ]);

  const total = Number(countRows[0]?.total) || 0;

  return {
    novels: (rows as any[]).map((r) => ({
      novelId: Number(r.novelId),
      title: r.title,
      publicationStatus: r.publicationStatus,
      totalEpisodes: Number(r.totalEpisodes) || 0,
      plaintextCount: Number(r.plaintextCount) || 0,
      missingPlaintextCount: Number(r.missingPlaintextCount) || 0,
      plaintextOnlyCount: Number(r.plaintextOnlyCount) || 0,
      hybridCount: Number(r.hybridCount) || 0,
      legacyOnlyCount: Number(r.legacyOnlyCount) || 0,
      missingBothCount: Number(r.missingBothCount) || 0,
      publishedMissingPlaintextCount: Number(r.publishedMissingPlaintextCount) || 0,
      purchasedMissingPlaintextCount: Number(r.purchasedMissingPlaintextCount) || 0,
      packageMissingPlaintextCount: Number(r.packageMissingPlaintextCount) || 0,
      chapterMissingPlaintextCount: Number(r.chapterMissingPlaintextCount) || 0,
      riskyEpisodeCount: Number(r.riskyEpisodeCount) || 0,
    })),
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

/**
 * Every episode row for one novel, lightweight columns only - never
 * `content`/`fileUrl` raw. Used by the Detail view, which needs the whole
 * novel's episode set (not just the current filtered/paginated page) to
 * correctly detect duplicate normalized ranges across the novel.
 */
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
      hasPlaintext: sql<number>`(CASE WHEN ${HAS_PLAINTEXT_SQL} THEN 1 ELSE 0 END)`,
      hasLegacyFile: sql<number>`(CASE WHEN ${HAS_LEGACY_FILE_SQL} THEN 1 ELSE 0 END)`,
      trimmedContentLength: sql<number>`CHAR_LENGTH(TRIM(COALESCE(${episodes.content}, '')))`,
      isPurchased: sql<number>`(CASE WHEN ${IS_PURCHASED_SQL} THEN 1 ELSE 0 END)`,
    })
    .from(episodes)
    .where(eq(episodes.novelId, novelId))
    .orderBy(asc(episodes.sortOrder), asc(episodes.episodeNumber));

  return (rows as any[]).map((r) => ({
    episodeId: Number(r.episodeId),
    novelId: Number(r.novelId),
    episodeNumber: String(r.episodeNumber ?? ""),
    episodeTitle: r.episodeTitle,
    saleMode: r.saleMode,
    isPublished: Boolean(r.isPublished),
    price: r.price,
    sortOrder: r.sortOrder ?? null,
    contentFormat: r.contentFormat ?? null,
    hasPlaintext: Boolean(Number(r.hasPlaintext)),
    hasLegacyFile: Boolean(Number(r.hasLegacyFile)),
    trimmedContentLength: Number(r.trimmedContentLength) || 0,
    isPurchased: Boolean(Number(r.isPurchased)),
  }));
}
