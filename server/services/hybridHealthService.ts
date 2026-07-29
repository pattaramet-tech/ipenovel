import * as db from "../db";
import { computeContentFlags, resolveSaleMode, normalizeEpisodeRange, type EpisodeSaleMode } from "./readerService";
import {
  queryHybridHealthGlobalSummary,
  queryHybridHealthNovelOverview,
  queryEpisodeHealthRowsForNovel,
  type EpisodeHealthRow,
  type HealthStatusFilter,
  type PublicationStatusFilter,
  type SaleModeFilter,
  type OverviewSortBy,
  type SortOrder,
} from "./hybridHealthQueries";

/**
 * Phase 2 - Hybrid Content Health Dashboard (read-only).
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

export interface HybridHealthOverviewSummary {
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
  summary: HybridHealthOverviewSummary;
  novels: NovelHealthOverviewRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/** Overview - read-only, DB-aggregated, paginated. No mutation anywhere in this module. */
export async function getHybridHealthOverview(input: HybridHealthOverviewInput = {}): Promise<HybridHealthOverviewResponse> {
  const page = Math.max(1, input.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, input.pageSize ?? 50));

  const [{ novels, total }, summary] = await Promise.all([
    queryHybridHealthNovelOverview({
      page,
      pageSize,
      search: input.search,
      status: input.status ?? "missing_plaintext",
      publicationStatus: input.publicationStatus ?? "all",
      saleMode: input.saleMode ?? "all",
      purchasedOnly: input.purchasedOnly ?? false,
      sortBy: input.sortBy ?? "missingPlaintextCount",
      sortOrder: input.sortOrder ?? "desc",
    }),
    queryHybridHealthGlobalSummary(),
  ]);

  return {
    summary,
    novels: novels.map((n) => ({
      ...n,
      plaintextCoveragePercent: coveragePercent(n.plaintextCount, n.totalEpisodes),
    })),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
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

/**
 * Episode-level detail for one novel - read-only, DB-aggregated at the
 * query layer for the flags, filtered/paginated here in JS since a single
 * novel's episode set (lightweight columns only) is always small - no
 * content/fileUrl ever loaded either way.
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
  const pageSize = Math.min(100, Math.max(1, input.pageSize ?? 50));
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
