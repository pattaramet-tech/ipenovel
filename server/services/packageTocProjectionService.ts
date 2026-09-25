export type PackageTocProjectionEntry = {
  chapterNumber: string;
  title: string;
  lineIndex: number;
};

const HEADING_PATTERNS: RegExp[] = [
  /^บทที่\s*(\d+(?:\.\d+)?)/,
  /^ตอนที่\s*(\d+(?:\.\d+)?)/,
  /^chapter\s*(\d+(?:\.\d+)?)/i,
  /^#\s*(\d+(?:\.\d+)?)/,
];

/** Project only chapter headings from a package blob. Never returns prose. */
export function projectPackageToc(content: string | null | undefined): PackageTocProjectionEntry[] {
  if (!content) return [];
  const projected: PackageTocProjectionEntry[] = [];
  content.split("\n").forEach((line, lineIndex) => {
    const title = line.trim();
    if (!title) return;
    for (const pattern of HEADING_PATTERNS) {
      const match = title.match(pattern);
      if (!match) continue;
      projected.push({ chapterNumber: match[1], title, lineIndex });
      break;
    }
  });
  return projected;
}
