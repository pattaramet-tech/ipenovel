import * as db from "../db";
import { computeContentFlags, resolveSaleMode, normalizeEpisodeRange, type EpisodeSaleMode } from "./readerService";
import {
  queryHybridHealthCandidateNovelIds,
  queryHybridHealthCandidateNovelCount,
  queryHybridHealthAggregatesForNovelIds,
  queryHybridHealthSummaryBatch,
  queryHybridHealthTotalNovelCount,
  queryEpisodeHealthRowsForNovel,
  HYBRID_HEALTH_SUMMARY_DEFAULT_BATCH_SIZE,
  type EpisodeHealthRow,
  type HealthStatusFilter,
  type PublicationStatusFilter,
  type SaleModeFilter,
  type OverviewSortBy,
  type SortOrder,
  type HybridHealthOverviewQueryParams,
} from "./hybridHealthQueries";

/**
 * Hybrid Content Health Dashboard (read-only).
 *
 * Surfaces exactly which novels/episodes are missing plaintext content for
 * the web reader, split from which ones only have a legacy file. See
 * server/services/hybridHealthQueries.ts for the data-access layer this
 * builds on - it never loads `episodes.content`/`episodes.fileUrl` as a raw
 * value, only the derived booleans/lengths this module classifies.
 *
 * hasPlaintext/hasLegacyFile here come straight from that lightweight SQL
 * layer (TRIM(COALESCE(x, '')) <> ''), which is the exact same semantics as
 * readerService.computeContentFlags() - the single source of truth used by
 * novels.episodes/reader.getEpisode - just evaluated in the database instead
 * of after loading content into JS (computeContentFlags() itself is still
 * used below, purely to document/pin that equivalence via a shared type; the
 * dashboard's own booleans always come from SQL).
 *
 * normalizeEpisodeRange()/resolveSaleMode() stay JS-side (imported from
 * readerService, the single source of truth for range/sale-mode logic) -
 * re-implementing range normalization in SQL would risk exactly the class of
 * "two different implementations disagree" bug this dashboard exists to
 * catch. Range/duplicate detection only needs episodeNumber/saleMode
 * (small varchar columns), never content/fileUrl, so this stays cheap.
 *
 * Overview and Summary are two independent tRPC procedures/queries with
 * separate failure boundaries by construction - Overview never calls
 * getHybridHealthSummary() (or vice versa), so a Summary failure can never
 * take Overview down with it, and each is retried/cached independently by
 * the client. See getHybridHealthOverview()/getHybridHealthSummary() below.
 */

export type EpisodeContentStatus = "PLAINTEXT_ONLY" | "HYBRID" | "LEGACY_ONLY" | "MISSING_BOTH";
export type EpisodePriority = "CRITICAL" | "HIGH" | "MEDIUM" | "HEALTHY";

export interface EpisodeHealthWarning {
  code:
    | "MISSING_BOTH"
    | "UNPARSEABLE_RANGE"
    | "DUPLICATE_RANGE"
    | "PURCHASED_BUT_UNREADABLE"
    | "MISSING_PLAINTEXT"
    | "LEGACY_ONLY"
    | "PUBLISHED_WITHOUT_PLAINTEXT"
    | "PURCHASED_WITHOUT_PLAINTEXT"
    | "NON_PLAIN_TEXT_FORMAT";
  message: string;
  /** "info" warnings (currently only NON_PLAIN_TEXT_FORMAT) are never counted as missing plaintext - purely informational. */
  severity: "warning" | "info";
}

export interface EpisodeHealthDetail {
  episodeId: number;
  novelId: number;
  episodeNumber: string;
  normalizedRange: string;
  episodeTitle: string;
  saleMode: EpisodeSaleMode;
  isPublished: boolean;
  hasPlaintext: boolean;
  hasLegacyFile: boolean;
  contentStatus: EpisodeContentStatus;
  contentFormat: string | null;
  trimmedContentLength: number;
  isPurchased: boolean;
  price: string;
  sortOrder: number | null;
  priority: EpisodePriority;
  warnings: EpisodeHealthWarning[];
}

function isValidNormalizedRange(normalized: string): boolean {
  return normalized.length > 0 && /\d/.test(normalized);
}

function computeNormalizedRangeCounts(rows: EpisodeHealthRow[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = normalizeEpisodeRange(row.episodeNumber);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

export function classifyContentStatus(hasPlaintext: boolean, hasLegacyFile: boolean): EpisodeContentStatus {
  if (hasPlaintext && !hasLegacyFile) return "PLAINTEXT_ONLY";
  if (hasPlaintext && hasLegacyFile) return "HYBRID";
  if (!hasPlaintext && hasLegacyFile) return "LEGACY_ONLY";
  return "MISSING_BOTH";
}

/**
 * CRITICAL > HIGH > MEDIUM > HEALTHY, first match wins. HEALTHY iff
 * hasPlaintext - everything without plaintext gets at least MEDIUM, and
 * escalates once it's actually exposed to a reader (published) or a paying
 * customer (purchased).
 */
export function classifyPriority(
  hasPlaintext: boolean,
  hasLegacyFile: boolean,
  isPublished: boolean,
  isPurchased: boolean
): EpisodePriority {
  if (hasPlaintext) return "HEALTHY";
  const missingBoth = !hasLegacyFile;
  if (missingBoth && isPurchased) return "CRITICAL";
  if (isPublished) return "HIGH";
  return "MEDIUM";
}

function buildEpisodeWarnings(p: {
  saleMode: EpisodeSaleMode;
  normalizedRange: string;
  isDuplicateRange: boolean;
  isPublished: boolean;
  isPurchased: boolean;
  hasPlaintext: boolean;
  hasLegacyFile: boolean;
  contentFormat: string | null;
}): EpisodeHealthWarning[] {
  const warnings: EpisodeHealthWarning[] = [];
  const missingBoth = !p.hasPlaintext && !p.hasLegacyFile;

  if (missingBoth) {
    warnings.push({
      code: "MISSING_BOTH",
      message: "ไม่มีทั้ง content และ fileUrl - เปิดอ่านไม่ได้แม้ลูกค้าซื้อแล้ว",
      severity: "warning",
    });
  }
  if (!p.hasPlaintext) {
    warnings.push({
      code: "MISSING_PLAINTEXT",
      message: "ตอนนี้ยังไม่มี Plaintext สำหรับ Web Reader",
      severity: "warning",
    });
  }
  if (!p.hasPlaintext && p.hasLegacyFile) {
    warnings.push({
      code: "LEGACY_ONLY",
      message: "มีเฉพาะไฟล์ Legacy เท่านั้น ยังไม่ได้ import เป็น Plaintext",
      severity: "warning",
    });
  }
  if (p.isPublished && !p.hasPlaintext) {
    warnings.push({
      code: "PUBLISHED_WITHOUT_PLAINTEXT",
      message: "ตอนนี้ Published แล้วแต่ยังไม่มี Plaintext ให้อ่านบนเว็บ",
      severity: "warning",
    });
  }
  if (p.isPurchased && !p.hasPlaintext) {
    warnings.push({
      code: "PURCHASED_WITHOUT_PLAINTEXT",
      message: "มีลูกค้าซื้อตอนนี้ไปแล้ว แต่ยังไม่มี Plaintext ให้อ่านบนเว็บ",
      severity: "warning",
    });
  }
  if (p.isPurchased && missingBoth) {
    warnings.push({
      code: "PURCHASED_BUT_UNREADABLE",
      message: "มีลูกค้าซื้อตอนนี้ไปแล้ว แต่ตอนนี้ไม่มี content หรือ fileUrl ให้อ่านเลย",
      severity: "warning",
    });
  }
  if (p.saleMode === "package" && !isValidNormalizedRange(p.normalizedRange)) {
    warnings.push({
      code: "UNPARSEABLE_RANGE",
      message: "saleMode เป็น package แต่ episodeNumber/range normalize เป็นเลขไม่ได้ - ZIP import จะหาตอนนี้ไม่เจอ",
      severity: "warning",
    });
  }
  if (p.isDuplicateRange) {
    warnings.push({
      code: "DUPLICATE_RANGE",
      message: `normalizedRange "${p.normalizedRange}" ซ้ำกับตอนอื่นในนิยายเดียวกัน - ZIP import จะ block และรายงาน error แทนการเดา`,
      severity: "warning",
    });
  }
  if (p.hasPlaintext && p.contentFormat && p.contentFormat !== "plain_text") {
    warnings.push({
      code: "NON_PLAIN_TEXT_FORMAT",
      message: `contentFormat เป็น "${p.contentFormat}" ไม่ใช่ plain_text - เนื้อหาอาจมี markup ปนอยู่ (ไม่นับเป็น Missing Plaintext)`,
      severity: "info",
    });
  }

  return warnings;
}

function toEpisodeHealthDetail(row: EpisodeHealthRow, rangeCounts: Map<string, number>): EpisodeHealthDetail {
  // resolveSaleMode()'s legacy fallback only checks fileUrl truthiness/length,
  // never its content - a placeholder non-empty string preserves that
  // fallback without needing the real (private) fileUrl value here.
  const saleMode = resolveSaleMode({
    saleMode: row.saleMode,
    fileUrl: row.hasLegacyFile ? "legacy-file-present" : undefined,
    episodeNumber: row.episodeNumber,
  });
  const normalizedRange = normalizeEpisodeRange(row.episodeNumber);
  const isDuplicateRange = (rangeCounts.get(normalizedRange) ?? 0) > 1;
  const contentStatus = classifyContentStatus(row.hasPlaintext, row.hasLegacyFile);
  const priority = classifyPriority(row.hasPlaintext, row.hasLegacyFile, row.isPublished, row.isPurchased);

  return {
    episodeId: row.episodeId,
    novelId: row.novelId,
    episodeNumber: row.episodeNumber,
    normalizedRange,
    episodeTitle: row.episodeTitle,
    saleMode,
    isPublished: row.isPublished,
    hasPlaintext: row.hasPlaintext,
    hasLegacyFile: row.hasLegacyFile,
    contentStatus,
    contentFormat: row.contentFormat,
    trimmedContentLength: row.trimmedContentLength,
    isPurchased: row.isPurchased,
    price: row.price,
    sortOrder: row.sortOrder,
    priority,
    warnings: buildEpisodeWarnings({
      saleMode,
      normalizedRange,
      isDuplicateRange,
      isPublished: row.isPublished,
      isPurchased: row.isPurchased,
      hasPlaintext: row.hasPlaintext,
      hasLegacyFile: row.hasLegacyFile,
      contentFormat: row.contentFormat,
    }),
  };
}

function matchesStatusFilter(status: EpisodeContentStatus, filter: HealthStatusFilter): boolean {
  switch (filter) {
    case "missing_plaintext":
      return status === "LEGACY_ONLY" || status === "MISSING_BOTH";
    case "legacy_only":
      return status === "LEGACY_ONLY";
    case "missing_both":
      return status === "MISSING_BOTH";
    case "has_plaintext":
      return status === "PLAINTEXT_ONLY" || status === "HYBRID";
    default:
      return true;
  }
}

function coveragePercent(plaintextCount: number, totalEpisodes: number): number {
  if (totalEpisodes <= 0) return 0;
  return Math.round((plaintextCount / totalEpisodes) * 1000) / 10;
}

// ============ OVERVIEW ============

export interface HybridHealthOverviewInput {
  page?: number;
  pageSize?: number;
  search?: string;
  status?: HealthStatusFilter;
  publicationStatus?: PublicationStatusFilter;
  saleMode?: SaleModeFilter;
  purchasedOnly?: boolean;
  sortBy?: OverviewSortBy;
  sortOrder?: SortOrder;
}

export interface NovelHealthOverviewRow {
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
  plaintextCoveragePercent: number;
  riskyEpisodeCount: number;
}

export interface HybridHealthOverviewResponse {
  novels: NovelHealthOverviewRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/**
 * Overview - read-only, page-first (never full-table) aggregation,
 * paginated. No mutation anywhere in this module.
 *
 * Deliberately sequential (A: candidate ids -> B: candidate count -> C:
 * page aggregates), never Promise.all - see hybridHealthQueries.ts's module
 * docstring for the TiDB errno=8176 incident this replaced. Also
 * deliberately does NOT call getHybridHealthSummary(): the summary card
 * scan is a separate, independently-loaded/cached/retried request so a slow
 * or failed summary can never block or fail the novel table.
 */
export async function getHybridHealthOverview(input: HybridHealthOverviewInput = {}): Promise<HybridHealthOverviewResponse> {
  const page = Math.max(1, input.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, input.pageSize ?? 50));
  const params: HybridHealthOverviewQueryParams = {
    page,
    pageSize,
    search: input.search,
    status: input.status ?? "missing_plaintext",
    publicationStatus: input.publicationStatus ?? "all",
    saleMode: input.saleMode ?? "all",
    purchasedOnly: input.purchasedOnly ?? false,
    sortBy: input.sortBy ?? "novelId",
    sortOrder: input.sortOrder ?? "desc",
  };

  const candidateIds = await queryHybridHealthCandidateNovelIds(params);
  const total = await queryHybridHealthCandidateNovelCount(params);
  const aggregates =
    candidateIds.length > 0 ? await queryHybridHealthAggregatesForNovelIds(candidateIds.map((c) => c.novelId)) : [];

  return {
    novels: aggregates.map((n) => ({
      ...n,
      plaintextCoveragePercent: coveragePercent(n.plaintextCount, n.totalEpisodes),
    })),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

// ============ SUMMARY (bounded, cached, single-flight) ============

export interface HybridHealthSummaryResponse {
  totalNovels: number;
  novelsMissingPlaintext: number;
  totalEpisodes: number;
  plaintextCount: number;
  missingPlaintextCount: number;
  legacyOnlyCount: number;
  missingBothCount: number;
  publishedMissingPlaintextCount: number;
  purchasedMissingPlaintextCount: number;
  /** ISO timestamp of when this result was actually computed (not when this particular response was served). */
  generatedAt: string;
  /** True when served from the 5-minute in-process cache rather than a fresh scan. */
  cached: boolean;
  /** False when the bounded batch scan hit a safety limit before reaching the end of `episodes` - counts are a lower bound, not exact. */
  isComplete: boolean;
}

/** ~100,000 episodes at the default batch size - generous for this catalog's realistic scale, but still bounded. */
const SUMMARY_MAX_BATCHES = 400;
/** Independent of batch count: also bail out if a scan is simply taking too long, well under typical gateway/tRPC request timeouts. */
const SUMMARY_MAX_DURATION_MS = 10_000;
const SUMMARY_CACHE_TTL_MS = 5 * 60 * 1000;

async function computeHybridHealthSummaryUncached(): Promise<HybridHealthSummaryResponse> {
  const startedAt = Date.now();

  // Sequential, deliberately not Promise.all'd with the batch loop below.
  const totalNovels = await queryHybridHealthTotalNovelCount();

  let cursor = 0;
  let totalEpisodes = 0;
  let plaintextCount = 0;
  let missingPlaintextCount = 0;
  let legacyOnlyCount = 0;
  let missingBothCount = 0;
  let publishedMissingPlaintextCount = 0;
  let purchasedMissingPlaintextCount = 0;
  const novelsMissingPlaintext = new Set<number>();

  let batches = 0;
  let isComplete = true;

  // Sequential batch loop by design - each batch awaits the previous one's
  // result before starting the next, so at most one Hybrid Health summary
  // query is ever in flight against the database at a time.
  while (true) {
    const rows = await queryHybridHealthSummaryBatch(cursor, HYBRID_HEALTH_SUMMARY_DEFAULT_BATCH_SIZE);
    if (rows.length === 0) break;
    batches += 1;

    for (const row of rows) {
      totalEpisodes += 1;
      if (row.hasPlaintext) {
        plaintextCount += 1;
      } else {
        missingPlaintextCount += 1;
        if (row.hasLegacyFile) legacyOnlyCount += 1;
        else missingBothCount += 1;
        if (row.isPublished) publishedMissingPlaintextCount += 1;
        if (row.isPurchased) purchasedMissingPlaintextCount += 1;
        novelsMissingPlaintext.add(row.novelId);
      }
    }

    cursor = rows[rows.length - 1].episodeId;

    if (rows.length < HYBRID_HEALTH_SUMMARY_DEFAULT_BATCH_SIZE) break; // reached the end naturally

    if (batches >= SUMMARY_MAX_BATCHES || Date.now() - startedAt > SUMMARY_MAX_DURATION_MS) {
      isComplete = false;
      break;
    }
  }

  return {
    totalNovels,
    novelsMissingPlaintext: novelsMissingPlaintext.size,
    totalEpisodes,
    plaintextCount,
    missingPlaintextCount,
    legacyOnlyCount,
    missingBothCount,
    publishedMissingPlaintextCount,
    purchasedMissingPlaintextCount,
    generatedAt: new Date().toISOString(),
    cached: false,
    isComplete,
  };
}

let summaryCache: { result: HybridHealthSummaryResponse; expiresAt: number } | null = null;
let summaryInFlight: Promise<HybridHealthSummaryResponse> | null = null;

/**
 * Global KPI totals for the Overview page's summary cards - loaded as its
 * own request, independent of (and never blocking) the novel table above.
 *
 * Cached in process memory for 5 minutes, and single-flight: if a scan is
 * already running when another request comes in, that request awaits the
 * SAME in-flight promise rather than starting a second full scan - the
 * synchronous check-then-set below (no `await` between checking
 * `summaryInFlight` and assigning it) makes this race-safe without a lock.
 */
export async function getHybridHealthSummary(): Promise<HybridHealthSummaryResponse> {
  const now = Date.now();
  if (summaryCache && summaryCache.expiresAt > now) {
    return { ...summaryCache.result, cached: true };
  }
  if (summaryInFlight) {
    return summaryInFlight;
  }

  summaryInFlight = computeHybridHealthSummaryUncached()
    .then((result) => {
      summaryCache = { result, expiresAt: Date.now() + SUMMARY_CACHE_TTL_MS };
      return result;
    })
    .finally(() => {
      summaryInFlight = null;
    });

  return summaryInFlight;
}

/** Test-only: clears cached/in-flight summary state so each test starts from a clean slate. Mirrors server/db.ts's __setDbForTests. */
export function __resetHybridHealthSummaryStateForTests(): void {
  summaryCache = null;
  summaryInFlight = null;
}

// ============ DETAIL ============

export interface HybridHealthDetailInput {
  novelId: number;
  page?: number;
  pageSize?: number;
  search?: string;
  status?: HealthStatusFilter;
  isPublished?: boolean;
  saleMode?: "chapter" | "package";
  purchasedOnly?: boolean;
}

export interface HybridHealthDetailNovelSummary {
  novelId: number;
  title: string;
  publicationStatus: "published" | "archived";
  totalEpisodes: number;
  plaintextCount: number;
  missingPlaintextCount: number;
  legacyOnlyCount: number;
  missingBothCount: number;
  publishedMissingPlaintextCount: number;
  purchasedMissingPlaintextCount: number;
  plaintextCoveragePercent: number;
}

export interface HybridHealthDetailResponse {
  novel: HybridHealthDetailNovelSummary;
  episodes: EpisodeHealthDetail[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export class NovelNotFoundError extends Error {
  constructor(novelId: number) {
    super(`Novel ${novelId} not found`);
    this.name = "NovelNotFoundError";
  }
}

/** Detail page size cap is tighter than Overview's (50, not 100) - see review requirement. */
const DETAIL_MAX_PAGE_SIZE = 50;

/**
 * Episode-level detail for one novel - read-only, DB-aggregated at the
 * query layer for the flags, filtered/paginated here in JS since a single
 * novel's episode set (lightweight columns only) is always small - no
 * content/fileUrl ever loaded either way. queryEpisodeHealthRowsForNovel is
 * scoped by novelId in its WHERE clause before any flag is evaluated -
 * never a full-system scan.
 */
export async function getHybridHealthDetail(input: HybridHealthDetailInput): Promise<HybridHealthDetailResponse> {
  const novel: any = await db.getNovelById(input.novelId, false);
  if (!novel) throw new NovelNotFoundError(input.novelId);

  const rows = await queryEpisodeHealthRowsForNovel(input.novelId);
  const rangeCounts = computeNormalizedRangeCounts(rows);
  const allDetails = rows.map((row) => toEpisodeHealthDetail(row, rangeCounts));

  let plaintextCount = 0;
  let legacyOnlyCount = 0;
  let missingBothCount = 0;
  let publishedMissingPlaintextCount = 0;
  let purchasedMissingPlaintextCount = 0;
  for (const d of allDetails) {
    if (d.hasPlaintext) plaintextCount++;
    if (d.contentStatus === "LEGACY_ONLY") legacyOnlyCount++;
    if (d.contentStatus === "MISSING_BOTH") missingBothCount++;
    if (!d.hasPlaintext && d.isPublished) publishedMissingPlaintextCount++;
    if (!d.hasPlaintext && d.isPurchased) purchasedMissingPlaintextCount++;
  }
  const totalEpisodes = allDetails.length;
  const novelSummary: HybridHealthDetailNovelSummary = {
    novelId: novel.id,
    title: novel.title,
    publicationStatus: novel.publicationStatus,
    totalEpisodes,
    plaintextCount,
    missingPlaintextCount: legacyOnlyCount + missingBothCount,
    legacyOnlyCount,
    missingBothCount,
    publishedMissingPlaintextCount,
    purchasedMissingPlaintextCount,
    plaintextCoveragePercent: coveragePercent(plaintextCount, totalEpisodes),
  };

  const status = input.status ?? "missing_plaintext";
  let filtered = allDetails.filter((d) => matchesStatusFilter(d.contentStatus, status));
  if (input.isPublished !== undefined) {
    filtered = filtered.filter((d) => d.isPublished === input.isPublished);
  }
  if (input.saleMode) {
    filtered = filtered.filter((d) => d.saleMode === input.saleMode);
  }
  if (input.purchasedOnly) {
    filtered = filtered.filter((d) => d.isPurchased);
  }
  const search = input.search?.trim().toLowerCase();
  if (search) {
    filtered = filtered.filter(
      (d) => d.episodeNumber.toLowerCase().includes(search) || d.episodeTitle.toLowerCase().includes(search)
    );
  }

  const page = Math.max(1, input.page ?? 1);
  const pageSize = Math.min(DETAIL_MAX_PAGE_SIZE, Math.max(1, input.pageSize ?? DETAIL_MAX_PAGE_SIZE));
  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const offset = (page - 1) * pageSize;

  return {
    novel: novelSummary,
    episodes: filtered.slice(offset, offset + pageSize),
    total,
    page,
    pageSize,
    totalPages,
  };
}

// Re-exported purely so a unit test can assert this dashboard's SQL-computed
// hasPlaintext/hasLegacyFile booleans agree with the single source of truth
// (readerService.computeContentFlags) on every edge case (null/empty/
// whitespace/markup), without this module needing to call it at request time.
export { computeContentFlags };
