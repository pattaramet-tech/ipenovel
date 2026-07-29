import { and, asc, desc, eq, gt, inArray, like, or, sql, count, type SQL } from "drizzle-orm";
import { getDb } from "../db";
import { novels, episodes, purchases, episodePurchases } from "../../drizzle/schema";

/**
 * Hybrid Content Health lightweight query layer.
 *
 * Every query in this file is aggregate-only: it computes hasPlaintext /
 * hasLegacyFile / content length as SQL booleans and numbers, and NEVER
 * selects `episodes.content` (MEDIUMTEXT, up to ~16MB/row for package
 * episodes) or `episodes.fileUrl` as a raw column value.
 *
 * hasPlaintext is defined as TRIM(COALESCE(content, '')) <> '' - the exact
 * same semantics as readerService.computeContentFlags()'s
 * `Boolean(content && String(content).trim().length > 0)`, just evaluated
 * in SQL instead of after loading content into JS. NULL, '' and
 * whitespace-only all count as "no plaintext".
 *
 * Hotfix (TiDB errno=8176 "query cancelled because the TiDB server memory
 * limit was exceeded" on /admin/hybrid-health): the original Overview query
 * ran a single GROUP BY across every novel/episode in the system to compute
 * 13 SUM(CASE...) expressions - each one re-evaluating
 * TRIM(COALESCE(content,'')) and a correlated purchase EXISTS over the
 * *entire* episodes table - and did that twice more in parallel
 * (queryHybridHealthGlobalSummary's own two full-table aggregates,
 * concurrent with the Overview query via Promise.all). Four full-table
 * scans at once, repeated on every client retry, is what exceeded TiDB's
 * memory limit. This file now does the aggregate work "page-first": find
 * which <=100 novel ids belong on the current page via a cheap EXISTS
 * semi-join (no GROUP BY at all), then GROUP BY only those ids. The
 * system-wide summary (still needed for the dashboard's KPI cards) is
 * computed by a separate, explicitly bounded, sequential batch scan - see
 * queryHybridHealthSummaryBatch and hybridHealthService.ts's caching/
 * single-flight wrapper around it.
 */

export type PublicationStatusFilter = "all" | "published" | "archived";
export type SaleModeFilter = "all" | "chapter" | "package";
export type HealthStatusFilter = "all" | "missing_plaintext" | "legacy_only" | "missing_both" | "has_plaintext";
/**
 * Sort by aggregate counts (missingPlaintextCount, coverage, ...) is
 * temporarily suspended by this hotfix - ranking by those requires knowing
 * every novel's count *before* picking a page, i.e. exactly the full-table
 * aggregate this hotfix removes from the initial request. Only columns
 * available directly on `novels` (no episode aggregation needed) are sortable
 * for now.
 */
export type OverviewSortBy = "title" | "novelId";
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

/**
 * Tags a DB error with which Hybrid Health operation failed, without ever
 * including SQL text, bound parameters, or credentials - just a short,
 * fixed operation name. The original error (with the driver's
 * errno/sqlState, e.g. TiDB 8176) is preserved via `cause` so the global
 * tRPC error formatter's safeErrorSummary() can still walk to it; only the
 * operation name is new here. See server/_core/trpc.ts's
 * sanitizeTrpcErrorShape, which already strips SQL/credentials from every
 * unexpected error before it reaches a client or a log line.
 */
async function tagDbError<T>(operation: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw new Error(`hybridHealth query failed: ${operation}`, { cause: error });
  }
}

/**
 * Combines status/saleMode/purchasedOnly into ONE per-episode boolean
 * predicate, or null if none of the three filters is active.
 *
 * This must stay a single AND'd predicate evaluated against one episode
 * row - NOT three independently-true aggregate counts ANDed together.
 * Independent counts let a novel pass a filter combination no single
 * episode actually satisfies: e.g. a novel with a LEGACY_ONLY chapter and
 * an unrelated MISSING_BOTH package would satisfy "has a legacy-only
 * episode AND has a missing-plaintext package episode" for
 * status=legacy_only + saleMode=package even though no episode is both
 * LEGACY_ONLY and a package - a cross-row false positive. Used both to
 * build the candidate-novel EXISTS semi-join below and (unchanged) exported
 * for static SQL-shape testing.
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
 * novels-level WHERE clause shared by the candidate-id and candidate-count
 * queries: search/publicationStatus filter `novels` columns directly, and
 * status/saleMode/purchasedOnly become a correlated EXISTS semi-join against
 * `episodes` (a single episode row satisfying every active filter at once -
 * see buildEpisodeLevelPredicate) rather than a GROUP BY/aggregate. EXISTS
 * short-circuits on the first matching episode and can use the existing
 * episodes_novelId_idx index, so this never has to scan or aggregate a
 * novel's full episode set just to decide whether it belongs on the page.
 */
export function buildCandidateWhereClause(params: HybridHealthOverviewQueryParams): SQL | undefined {
  const conditions: SQL[] = [];

  if (params.publicationStatus !== "all") {
    conditions.push(eq(novels.publicationStatus, params.publicationStatus));
  }

  const search = params.search?.trim();
  if (search) {
    const isNumericId = /^\d+$/.test(search);
    conditions.push(
      (isNumericId
        ? or(eq(novels.id, Number(search)), like(novels.title, `%${search}%`))
        : like(novels.title, `%${search}%`)) as SQL
    );
  }

  const episodePredicate = buildEpisodeLevelPredicate(params);
  if (episodePredicate) {
    conditions.push(sql`EXISTS (SELECT 1 FROM ${episodes} WHERE ${episodes.novelId} = ${novels.id} AND ${episodePredicate})`);
  }

  return conditions.length > 0 ? and(...conditions) : undefined;
}

export interface CandidateNovelId {
  novelId: number;
}

/**
 * Pure query-builder for step A, taking an injected `db` so it can be
 * exercised without a real connection (`.toSQL()` never dials out) - see
 * hybridHealthQueries.static.test.ts. The exported async function below is
 * the only production caller.
 */
export function buildCandidateNovelIdsQuery(dbInstance: any, params: HybridHealthOverviewQueryParams) {
  const pageSize = Math.min(100, Math.max(1, params.pageSize));
  const page = Math.max(1, params.page);
  const offset = (page - 1) * pageSize;

  const whereClause = buildCandidateWhereClause(params);
  const sortColumn = params.sortBy === "title" ? novels.title : novels.id;
  const orderFn = params.sortOrder === "asc" ? asc : desc;

  let listQuery: any = dbInstance.select({ novelId: novels.id }).from(novels);
  if (whereClause) listQuery = listQuery.where(whereClause);
  return listQuery.orderBy(orderFn(sortColumn), asc(novels.id)).limit(pageSize).offset(offset);
}

/**
 * Step A of the page-first Overview: which novel ids belong on this page,
 * with NO episode-level GROUP BY anywhere. Sort is intentionally limited to
 * `novels` columns (title/novelId) - see OverviewSortBy's docstring.
 */
export async function queryHybridHealthCandidateNovelIds(
  params: HybridHealthOverviewQueryParams
): Promise<CandidateNovelId[]> {
  const db = await getDb();
  if (!db) return [];

  return tagDbError("candidateNovelIds", async () => {
    const rows = await buildCandidateNovelIdsQuery(db, params);
    return (rows as any[]).map((r) => ({ novelId: Number(r.novelId) }));
  });
}

/**
 * Step B: total count of novels matching the SAME filter as step A - run
 * strictly after it (never Promise.all'd with it), and itself a plain COUNT
 * with no GROUP BY/aggregate-derived table.
 */
export async function queryHybridHealthCandidateNovelCount(params: HybridHealthOverviewQueryParams): Promise<number> {
  const db = await getDb();
  if (!db) return 0;

  const whereClause = buildCandidateWhereClause(params);

  return tagDbError("candidateNovelCount", async () => {
    let countQuery: any = db.select({ total: count() }).from(novels);
    if (whereClause) countQuery = countQuery.where(whereClause);
    const rows = await countQuery;
    return Number(rows[0]?.total) || 0;
  });
}

/**
 * Step C: the same 13 count fields as before, but the GROUP BY is scoped to
 * `WHERE novels.id IN (<=100 ids from step A)` - the aggregate work is now
 * bounded to one page's worth of novels' episodes, never the whole table.
 * Returns [] immediately (no query at all) when novelIds is empty. Result
 * order matches the input `novelIds` order (step A's sort), not whatever
 * order MySQL/TiDB happens to return IN(...) rows in.
 */
export function buildAggregatesForNovelIdsQuery(dbInstance: any, novelIds: number[]) {
  const notPlaintext = sql`(${EPISODE_EXISTS_SQL} AND NOT ${HAS_PLAINTEXT_SQL})`;
  const isPlaintext = sql`(${EPISODE_EXISTS_SQL} AND ${HAS_PLAINTEXT_SQL})`;

  return dbInstance
    .select({
      novelId: novels.id,
      title: novels.title,
      publicationStatus: novels.publicationStatus,
      totalEpisodes: caseCount(EPISODE_EXISTS_SQL),
      plaintextCount: caseCount(isPlaintext),
      missingPlaintextCount: caseCount(notPlaintext),
      plaintextOnlyCount: caseCount(sql`(${isPlaintext} AND NOT ${HAS_LEGACY_FILE_SQL})`),
      hybridCount: caseCount(sql`(${isPlaintext} AND ${HAS_LEGACY_FILE_SQL})`),
      legacyOnlyCount: caseCount(sql`(${notPlaintext} AND ${HAS_LEGACY_FILE_SQL})`),
      missingBothCount: caseCount(sql`(${notPlaintext} AND NOT ${HAS_LEGACY_FILE_SQL})`),
      publishedMissingPlaintextCount: caseCount(sql`(${notPlaintext} AND ${episodes.isPublished} = 1)`),
      purchasedMissingPlaintextCount: caseCount(sql`(${notPlaintext} AND ${IS_PURCHASED_SQL})`),
      packageMissingPlaintextCount: caseCount(sql`(${notPlaintext} AND ${episodes.saleMode} = 'package')`),
      chapterMissingPlaintextCount: caseCount(sql`(${notPlaintext} AND ${episodes.saleMode} = 'chapter')`),
      // "Risky" = missing plaintext AND already exposed to a reader
      // (published) or a paying customer (purchased) - a missing-plaintext
      // draft nobody can see yet is not yet operationally risky.
      riskyEpisodeCount: caseCount(sql`(${notPlaintext} AND (${episodes.isPublished} = 1 OR ${IS_PURCHASED_SQL}))`),
    })
    .from(novels)
    .leftJoin(episodes, eq(episodes.novelId, novels.id))
    .where(inArray(novels.id, novelIds))
    .groupBy(novels.id, novels.title, novels.publicationStatus);
}

export async function queryHybridHealthAggregatesForNovelIds(novelIds: number[]): Promise<NovelHealthAggregateRow[]> {
  if (novelIds.length === 0) return [];
  const db = await getDb();
  if (!db) return [];

  return tagDbError("pageAggregates", async () => {
    const rows = await buildAggregatesForNovelIdsQuery(db, novelIds);

    const byId = new Map<number, NovelHealthAggregateRow>();
    for (const r of rows as any[]) {
      byId.set(Number(r.novelId), {
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
      });
    }

    return novelIds.map((id) => byId.get(id)).filter((row): row is NovelHealthAggregateRow => Boolean(row));
  });
}

// ============ SUMMARY (bounded sequential batch scan) ============

export const HYBRID_HEALTH_SUMMARY_DEFAULT_BATCH_SIZE = 250;
export const HYBRID_HEALTH_SUMMARY_MAX_BATCH_SIZE = 500;

export interface SummaryBatchRow {
  episodeId: number;
  novelId: number;
  hasPlaintext: boolean;
  hasLegacyFile: boolean;
  isPublished: boolean;
  saleMode: "chapter" | "package";
  isPurchased: boolean;
}

/**
 * One bounded page of episodes, keyset-paginated by `episodes.id` (never
 * OFFSET, which gets slower - not cheaper - the further into a large table
 * it scans). No JOIN to `novels` - the summary only ever needs episode-level
 * columns, so joining novels in here would be pure overhead. Never selects
 * `content`/`fileUrl` raw. The caller (hybridHealthService's bounded batch
 * loop) is responsible for calling this repeatedly and sequentially.
 */
export function buildSummaryBatchQuery(dbInstance: any, cursor: number, batchSize: number) {
  const clampedSize = Math.min(HYBRID_HEALTH_SUMMARY_MAX_BATCH_SIZE, Math.max(1, batchSize));
  return dbInstance
    .select({
      episodeId: episodes.id,
      novelId: episodes.novelId,
      hasPlaintext: sql<number>`(CASE WHEN ${HAS_PLAINTEXT_SQL} THEN 1 ELSE 0 END)`,
      hasLegacyFile: sql<number>`(CASE WHEN ${HAS_LEGACY_FILE_SQL} THEN 1 ELSE 0 END)`,
      isPublished: episodes.isPublished,
      saleMode: episodes.saleMode,
      isPurchased: sql<number>`(CASE WHEN ${IS_PURCHASED_SQL} THEN 1 ELSE 0 END)`,
    })
    .from(episodes)
    .where(gt(episodes.id, cursor))
    .orderBy(asc(episodes.id))
    .limit(clampedSize);
}

export async function queryHybridHealthSummaryBatch(
  cursor: number,
  batchSize: number = HYBRID_HEALTH_SUMMARY_DEFAULT_BATCH_SIZE
): Promise<SummaryBatchRow[]> {
  const db = await getDb();
  if (!db) return [];

  return tagDbError("summaryBatch", async () => {
    const rows = await buildSummaryBatchQuery(db, cursor, batchSize);

    return (rows as any[]).map((r) => ({
      episodeId: Number(r.episodeId),
      novelId: Number(r.novelId),
      hasPlaintext: Boolean(Number(r.hasPlaintext)),
      hasLegacyFile: Boolean(Number(r.hasLegacyFile)),
      isPublished: Boolean(r.isPublished),
      saleMode: r.saleMode,
      isPurchased: Boolean(Number(r.isPurchased)),
    }));
  });
}

/** Total novel count for the summary's `totalNovels` field - deliberately never JOINed to episodes. */
export async function queryHybridHealthTotalNovelCount(): Promise<number> {
  const db = await getDb();
  if (!db) return 0;

  return tagDbError("totalNovelCount", async () => {
    const rows = await db.select({ total: count() }).from(novels);
    return Number(rows[0]?.total) || 0;
  });
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
 * correctly detect duplicate normalized ranges across the novel. Always
 * scoped by novelId first (WHERE, not a post-filter) - no full-system scan.
 */
export async function queryEpisodeHealthRowsForNovel(novelId: number): Promise<EpisodeHealthRow[]> {
  const db = await getDb();
  if (!db) return [];

  return tagDbError("episodeRowsForNovel", async () => {
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
  });
}
