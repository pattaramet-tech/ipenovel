/**
 * Chapter pagination for package episodes, kept DOM-free so it can be
 * unit-tested in the node environment like the other pure client modules
 * (see readerChromePresentation.ts / readerResumePosition.ts).
 *
 * A "package" episode bundles many chapters worth of plaintext into one
 * content blob. Before P1 the reader rendered that whole blob in one long
 * scroll. P1 paginates it: one chapter per page, with previous/next chapter
 * buttons and a TOC that switches pages instead of scrolling. All decisions
 * live here; ReaderPage.tsx only wires the results to the DOM.
 *
 * Non-goals (deliberate, so single-episode behavior is bit-for-bit): plain
 * chapters, packages with no recognizable headings, and single-chapter
 * packages all keep the legacy single-page rendering.
 */

import {
  parsePackageToc,
  type PackageTocEntry,
} from "@/utils/packageTocUtils";

export interface PackageChapterSegment {
  /**
   * TOC entry of the heading that opens this segment. null only for the
   * heading-less intro segment (lines before the first recognized heading)
   * and for the single fallback segment of heading-less content.
   */
  entry: PackageTocEntry | null;
  chapterNumber: string | null;
  title: string | null;
  anchorId: string | null;
  /** Inclusive start line index into content.split("\n") (global, not per-segment). */
  startLine: number;
  /** Exclusive end line index into content.split("\n"). */
  endLine: number;
  lines: string[];
}

/**
 * Split the episode's lines into per-chapter segments driven by the parsed
 * TOC. Lines before the first heading become a leading intro segment so no
 * content is ever hidden; with no headings at all there is exactly one
 * segment covering everything (legacy single-page rendering).
 *
 * `segmentPackageChapters` is the convenience wrapper; ReaderPage already
 * holds both the split lines and the parsed TOC and uses the FromToc variant
 * to avoid parsing twice.
 */
export function segmentPackageChapters(content: string): PackageChapterSegment[] {
  const lines = content.split("\n");
  return segmentPackageChaptersFromLines(lines, parsePackageToc(content));
}

export function segmentPackageChaptersFromLines(
  lines: string[],
  toc: PackageTocEntry[]
): PackageChapterSegment[] {
  // "" splits to [""], not [] - normalize both to "no segments" (the reader
  // only renders segments behind its canRead && content gate anyway).
  if (lines.length === 0 || (lines.length === 1 && lines[0] === "")) return [];
  if (toc.length === 0) {
    return [
      {
        entry: null,
        chapterNumber: null,
        title: null,
        anchorId: null,
        startLine: 0,
        endLine: lines.length,
        lines,
      },
    ];
  }

  const segments: PackageChapterSegment[] = [];
  const firstStart = toc[0].lineIndex;
  if (firstStart > 0) {
    segments.push({
      entry: null,
      chapterNumber: null,
      title: null,
      anchorId: null,
      startLine: 0,
      endLine: firstStart,
      lines: lines.slice(0, firstStart),
    });
  }
  toc.forEach((entry, i) => {
    const end = i + 1 < toc.length ? toc[i + 1].lineIndex : lines.length;
    segments.push({
      entry,
      chapterNumber: entry.chapterNumber,
      title: entry.title,
      anchorId: entry.anchorId,
      startLine: entry.lineIndex,
      endLine: end,
      lines: lines.slice(entry.lineIndex, end),
    });
  });
  return segments;
}

/**
 * Pagination only pays off when there is more than one page to move between;
 * everything else (plain chapters, heading-less packages, single-chapter
 * packages) keeps the legacy single-page rendering untouched.
 */
export function shouldPaginatePackage(segments: PackageChapterSegment[]): boolean {
  return segments.length > 1;
}

/**
 * Which page to open first. An explicit `requestedChapter` (the ?chapter=
 * deep link from the novel page) always wins over saved progress - it is a
 * deliberate navigation. Unknown numbers fail safe to the first page.
 */
export function resolveInitialChapterIndex(
  segments: PackageChapterSegment[],
  options: { requestedChapter?: string | null | undefined } = {}
): number {
  if (segments.length === 0) return 0;
  const requested = options.requestedChapter;
  if (requested) {
    const idx = findSegmentIndexByChapterNumber(segments, requested);
    if (idx >= 0) return idx;
  }
  return 0;
}

export function findSegmentIndexByChapterNumber(
  segments: PackageChapterSegment[],
  chapterNumber: string | null | undefined
): number {
  if (!chapterNumber) return -1;
  return segments.findIndex((seg) => seg.entry !== null && seg.chapterNumber === chapterNumber);
}

export function findSegmentIndexByAnchorId(
  segments: PackageChapterSegment[],
  anchorId: string | null | undefined
): number {
  if (!anchorId) return -1;
  return segments.findIndex((seg) => seg.entry !== null && seg.anchorId === anchorId);
}

/**
 * Restore scrollTop WITHIN the current chapter page. Saved offsets written
 * before pagination (whole-package scroll positions) can exceed the current
 * chapter's entire scrollable range - clamping those to the bottom would
 * land the reader at the chapter END, so an offset past the measurable
 * range falls back to the chapter start (top), which is the honest restore
 * for "resume this chapter". Positions saved by the paginated layout always
 * fit and restore exactly.
 */
export function resolveChapterRestoreScrollTop(
  snapshot: { scrollTop: number | null | undefined },
  metrics: { scrollHeight: number; clientHeight: number } | null
): number {
  const raw = Number(snapshot?.scrollTop);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  if (!metrics) return 0;
  const max = metrics.scrollHeight - metrics.clientHeight;
  if (max <= 0) return 0;
  if (raw > max) return 0;
  return raw;
}

/**
 * Overall progress through the whole package (0..100, ROUNDED TO AN INTEGER),
 * from the current page index and the reader's within-page scroll percent.
 *
 * Two hard constraints:
 * - The server's progressPercent is displayed on My Novels / Profile / Novel
 *   Detail as "read X% of the book", so it must stay a whole-package number
 *   even though the reader now only ever scrolls one chapter at a time.
 * - The existing reading_progress column stores an INTEGER
 *   (drizzle schema: progressPercent int) and the schema must not change -
 *   so the value this function produces IS the value the database keeps
 *   (no silent server-side rounding divergence).
 */
export function packageOverallPercent(
  chapterIndex: number,
  withinPercent: number,
  totalSegments: number
): number {
  if (!Number.isFinite(totalSegments) || totalSegments <= 0) return 0;
  const idx = Math.min(Math.max(Math.floor(chapterIndex), 0), totalSegments - 1);
  const within = Math.min(Math.max(Number.isFinite(withinPercent) ? withinPercent : 0, 0), 100);
  const value = ((idx + within / 100) / totalSegments) * 100;
  return Math.round(Math.min(Math.max(value, 0), 100));
}
