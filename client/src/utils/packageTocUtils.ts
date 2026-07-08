/**
 * Parse an in-package table of contents out of a package episode's raw
 * content. A "package" episode bundles many chapters worth of plaintext
 * into a single content blob (imported from a .txt file) - this scans it
 * for recognizable chapter headings so the reader can build a jump-to-chapter
 * table of contents and figure out "which chapter is the reader currently on"
 * from scroll position.
 *
 * Recognized heading formats (must be the first thing on their own line):
 * - "บทที่ 12" / "บทที่12"
 * - "ตอนที่ 12"
 * - "Chapter 12" (case-insensitive)
 * - "#12"
 */

export interface PackageTocEntry {
  chapterNumber: string;
  title: string;
  /** Stable DOM id to scroll/anchor to - assigned to the <p> rendering this line. */
  anchorId: string;
  /** Index into content.split("\n") - matches the paragraph index ReaderPage renders. */
  lineIndex: number;
}

const HEADING_PATTERNS: RegExp[] = [
  /^บทที่\s*(\d+(?:\.\d+)?)/,
  /^ตอนที่\s*(\d+(?:\.\d+)?)/,
  /^chapter\s*(\d+(?:\.\d+)?)/i,
  /^#\s*(\d+(?:\.\d+)?)/,
];

export function tocAnchorId(lineIndex: number): string {
  return `toc-line-${lineIndex}`;
}

/**
 * Scan package content for chapter headings. Returns an empty array for
 * plain chapter content (no headings match) - callers should treat an empty
 * TOC as "no internal table of contents to show".
 */
export function parsePackageToc(content: string): PackageTocEntry[] {
  if (!content) return [];

  const lines = content.split("\n");
  const toc: PackageTocEntry[] = [];

  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    for (const pattern of HEADING_PATTERNS) {
      const match = trimmed.match(pattern);
      if (match) {
        toc.push({
          chapterNumber: match[1],
          title: trimmed,
          anchorId: tocAnchorId(idx),
          lineIndex: idx,
        });
        break;
      }
    }
  });

  return toc;
}

/**
 * The TOC entry whose heading the reader has scrolled past most recently
 * (the last entry at or before `lineIndex`), or null if the reader hasn't
 * reached the first heading yet.
 */
export function findCurrentTocEntry(toc: PackageTocEntry[], lineIndex: number): PackageTocEntry | null {
  let current: PackageTocEntry | null = null;
  for (const entry of toc) {
    if (entry.lineIndex <= lineIndex) {
      current = entry;
    } else {
      break;
    }
  }
  return current;
}

/**
 * The TOC entry matching a previously-saved chapter number (from
 * reader.getProgress), for resuming at the right heading when scrollY/anchor
 * data is unavailable or stale (e.g. after a font-size-driven reflow).
 */
export function findTocEntryByChapterNumber(toc: PackageTocEntry[], chapterNumber: string | null | undefined): PackageTocEntry | null {
  if (!chapterNumber) return null;
  return toc.find((entry) => entry.chapterNumber === chapterNumber) || null;
}
