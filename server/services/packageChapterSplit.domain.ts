import { createHash } from "node:crypto";
import { normalizeEpisodeRange } from "./readerService";

/**
 * Package -> chapter split (PURE module, no database).
 *
 * Splits a range package's plaintext ("1 - 50") into its embedded chapters.
 * Fail-closed by design - every rule below produces an issue instead of a
 * best-effort guess, and a plan with ANY issue is not applicable:
 *
 *  - Chapter numbers come ONLY from headings at the START of a line in the
 *    content, in one of four formats (Owner heading policy): "บทที่ N",
 *    "ตอนที่ N", "Chapter N" (any case) and "#N" - N in Arabic or Thai
 *    digits. The package's episodeNumber range is used to VALIDATE them,
 *    never to invent them. A heading-like phrase mid-line is prose.
 *  - The headings must cover the declared range exactly: first = start, no
 *    gap, no duplicate, nothing beyond the end, nothing out of order.
 *  - Split-part headings ("บทที่ 7 ... (1/3)", "(2/3)", "(3/3)") that repeat
 *    the same number back-to-back are ONE chapter when the parts run 1..n.
 *  - The only text allowed before the first heading is a pack-header line
 *    ("แพ็กตอน 1 - 50") that matches the declared range.
 *  - Offsets refer to the ORIGINAL content and the stored chapter text IS the
 *    exact source slice [sourceStart, sourceEnd) - no trimming, no newline or
 *    BOM/NBSP normalization. preamble + every stored chapter re-concatenates
 *    to the byte-identical source, which is verified, not assumed.
 *  - planHash is deterministic: same source + same episodeNumber -> same hash.
 */

export const PACKAGE_CHAPTER_SPLIT_VERSION = "package-chapter-split-v1" as const;
export const MAX_SPLIT_CHAPTERS = 1000;
const MAX_TITLE_CHARS = 500;
const MAX_LISTED_MISSING = 50;

export type SplitIssueCode =
  | "EMPTY_CONTENT"
  | "NOT_RANGE"
  | "RANGE_TOO_LARGE"
  | "NO_HEADINGS"
  | "PREAMBLE_NOT_ALLOWED"
  | "NON_INTEGER_CHAPTER"
  | "FIRST_CHAPTER_MISMATCH"
  | "MISSING_CHAPTER"
  | "DUPLICATE_CHAPTER_NUMBER"
  | "OUT_OF_ORDER"
  | "EXTRA_CHAPTER_BEYOND_RANGE"
  | "PART_SEQUENCE_INVALID"
  | "EMPTY_CHAPTER"
  | "COVERAGE_MISMATCH";

export interface SplitIssue {
  code: SplitIssueCode;
  message: string;
  chapterNumber?: number;
  /** 1-based line number in the source, when the issue is tied to a line. */
  lineNumber?: number;
}

export interface SplitChapter {
  chapterNumber: number;
  /** Heading line (first part's heading, part marker removed), trimmed. */
  title: string;
  /** Inclusive UTF-16 offset into the ORIGINAL content where this chapter starts (its heading line). */
  sourceStart: number;
  /** Exclusive UTF-16 offset into the ORIGINAL content. */
  sourceEnd: number;
  /** 0-based first line index (heading line). */
  startLine: number;
  /** 0-based exclusive end line index. */
  endLine: number;
  /** 1 for a normal chapter, n for an "(k/n)" split-part group. */
  partCount: number;
  /** Stored chapter text: EXACTLY content.slice(sourceStart, sourceEnd) - nothing trimmed. */
  content: string;
  contentSha256: string;
  /** Characters of prose (headings excluded), trimmed. */
  bodyCharCount: number;
}

export interface SplitPlan {
  ok: boolean;
  version: typeof PACKAGE_CHAPTER_SPLIT_VERSION;
  episodeNumber: string;
  range: { start: number; end: number; count: number } | null;
  sourceLength: number;
  sourceSha256: string;
  preamble: { sourceStart: 0; sourceEnd: number; kind: "none" | "pack_header" };
  chapters: SplitChapter[];
  issues: SplitIssue[];
  /** Deterministic fingerprint of the split; null when the plan has issues. */
  planHash: string | null;
}

interface SourceLine {
  index: number;
  start: number;
  /** Exclusive, excludes the "\n" terminator. */
  end: number;
  /** Line text without a trailing "\r". */
  text: string;
}

interface HeadingLine {
  line: SourceLine;
  chapterNumber: number;
  integer: boolean;
  part: { index: number; total: number } | null;
  title: string;
}

const HEADING_RE =
  /^[ \t\u00a0\ufeff]*(?:บทที่|ตอนที่|chapter|#)[ \t\u00a0]*([0-9๐-๙]+)(\.[0-9๐-๙]+)?(?![0-9๐-๙])(.*)$/i;
const PART_MARKER_RE = /\(\s*([0-9๐-๙]+)\s*\/\s*([0-9๐-๙]+)\s*\)/;
const THAI_DIGITS = "๐๑๒๓๔๕๖๗๘๙";

/** Thai digits -> Arabic digits (numbers only; the stored text is never rewritten). */
export function normalizeDigits(value: string): string {
  return value.replace(/[๐-๙]/g, (digit) => String(THAI_DIGITS.indexOf(digit)));
}
const PACK_HEADER_RE = /^[\s\u00a0\ufeff]*แพ็กตอน[ \t\u00a0]*([0-9]+)[ \t\u00a0]*-[ \t\u00a0]*([0-9]+)(?:[ \t\u00a0]+[0-9]+)?[\s\u00a0]*$/;

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function cleanTitle(value: string): string {
  return value.replace(/^[\s\u00a0\ufeff]+/, "").replace(/[\s\u00a0]+$/, "").slice(0, MAX_TITLE_CHARS);
}

function splitSourceLines(content: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  let index = 0;
  while (start <= content.length) {
    const newline = content.indexOf("\n", start);
    const end = newline === -1 ? content.length : newline;
    const raw = content.slice(start, end);
    lines.push({ index, start, end, text: raw.endsWith("\r") ? raw.slice(0, -1) : raw });
    if (newline === -1) break;
    start = newline + 1;
    index += 1;
  }
  return lines;
}

function parseHeading(line: SourceLine): HeadingLine | null {
  const match = line.text.match(HEADING_RE);
  if (!match) return null;
  const chapterNumber = Number(normalizeDigits(match[1]));
  const partMatch = (match[3] ?? "").match(PART_MARKER_RE);
  const part = partMatch
    ? { index: Number(normalizeDigits(partMatch[1])), total: Number(normalizeDigits(partMatch[2])) }
    : null;
  const titleSource = partMatch ? line.text.replace(PART_MARKER_RE, "") : line.text;
  return {
    line,
    chapterNumber,
    integer: !match[2] && Number.isSafeInteger(chapterNumber) && chapterNumber > 0,
    part,
    title: cleanTitle(titleSource),
  };
}

export function parseSplitRange(episodeNumber: string): { start: number; end: number; count: number } | null {
  const match = normalizeEpisodeRange(episodeNumber).match(/^(\d+) - (\d+)$/);
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start <= 0 || end < start) return null;
  return { start, end, count: end - start + 1 };
}

function stripHeadingLines(chapterText: string): string {
  return chapterText
    .split("\n")
    .filter((line) => !HEADING_RE.test(line.endsWith("\r") ? line.slice(0, -1) : line))
    .join("\n")
    .trim();
}

function canonicalPlanHash(plan: Omit<SplitPlan, "planHash" | "ok" | "issues">): string {
  const payload = {
    v: plan.version,
    episodeNumber: normalizeEpisodeRange(plan.episodeNumber),
    sourceSha256: plan.sourceSha256,
    sourceLength: plan.sourceLength,
    preamble: [plan.preamble.kind, plan.preamble.sourceEnd],
    chapters: plan.chapters.map((c) => [
      c.chapterNumber,
      c.sourceStart,
      c.sourceEnd,
      c.partCount,
      c.contentSha256,
      c.title,
    ]),
  };
  return sha256Hex(JSON.stringify(payload));
}

/**
 * Split a range package's content into chapters. Never throws on bad input -
 * every problem is reported as an issue and `ok` is false.
 */
export function splitPackageContent(input: { episodeNumber: string; content: string | null | undefined }): SplitPlan {
  const content = input.content ?? "";
  const issues: SplitIssue[] = [];
  const base = {
    version: PACKAGE_CHAPTER_SPLIT_VERSION,
    episodeNumber: String(input.episodeNumber ?? ""),
    sourceLength: content.length,
    sourceSha256: sha256Hex(content),
  };
  const fail = (range: SplitPlan["range"], preambleEnd = 0): SplitPlan => ({
    ...base,
    ok: false,
    range,
    preamble: { sourceStart: 0, sourceEnd: preambleEnd, kind: "none" },
    chapters: [],
    issues,
    planHash: null,
  });

  if (content.trim().length === 0) {
    issues.push({ code: "EMPTY_CONTENT", message: "แพ็กนี้ไม่มีเนื้อหา" });
    return fail(null);
  }

  const range = parseSplitRange(base.episodeNumber);
  if (!range) {
    issues.push({ code: "NOT_RANGE", message: `เลขตอน "${base.episodeNumber}" ไม่ใช่ช่วงแพ็กแบบ "N - M"` });
    return fail(null);
  }
  if (range.count > MAX_SPLIT_CHAPTERS) {
    issues.push({ code: "RANGE_TOO_LARGE", message: `ช่วงแพ็ก ${range.count} บท เกินขีดจำกัด ${MAX_SPLIT_CHAPTERS} บท` });
    return fail(range);
  }

  const lines = splitSourceLines(content);
  const headings = lines.map(parseHeading).filter((h): h is HeadingLine => h !== null);
  if (headings.length === 0) {
    issues.push({
      code: "NO_HEADINGS",
      message: 'ไม่พบหัวบทต้นบรรทัด ("บทที่ N", "ตอนที่ N", "Chapter N" หรือ "#N") ในเนื้อหาแพ็ก',
    });
    return fail(range);
  }

  for (const heading of headings) {
    if (!heading.integer) {
      issues.push({
        code: "NON_INTEGER_CHAPTER",
        message: `หัวบท "${heading.title}" ไม่ใช่เลขบทจำนวนเต็ม`,
        lineNumber: heading.line.index + 1,
      });
    }
  }

  // Preamble: nothing, or exactly one pack-header line matching the range.
  const preambleLines = lines.filter((l) => l.index < headings[0].line.index);
  const preambleText = preambleLines.map((l) => l.text).filter((t) => t.trim().length > 0);
  let preambleKind: "none" | "pack_header" = "none";
  if (preambleText.length > 0) {
    const header = preambleText.length === 1 ? preambleText[0].match(PACK_HEADER_RE) : null;
    if (header && Number(header[1]) === range.start && Number(header[2]) === range.end) {
      preambleKind = "pack_header";
    } else {
      issues.push({
        code: "PREAMBLE_NOT_ALLOWED",
        message: "พบข้อความก่อนหัวบทแรกที่ไม่ใช่ pack header ที่ตรงกับช่วงแพ็ก",
        lineNumber: (preambleLines.find((l) => l.text.trim().length > 0)?.index ?? 0) + 1,
      });
    }
  }

  // Group consecutive same-number headings (split parts).
  const groups: HeadingLine[][] = [];
  for (const heading of headings) {
    const last = groups[groups.length - 1];
    if (last && last[0].chapterNumber === heading.chapterNumber) last.push(heading);
    else groups.push([heading]);
  }
  for (const group of groups) {
    const number = group[0].chapterNumber;
    const lineNumber = group[0].line.index + 1;
    if (group.length === 1) {
      const part = group[0].part;
      if (part && !(part.index === 1 && part.total === 1)) {
        issues.push({
          code: "PART_SEQUENCE_INVALID",
          message: `บทที่ ${number} มีเครื่องหมายส่วน (${part.index}/${part.total}) แต่ไม่พบส่วนอื่นครบ`,
          chapterNumber: number,
          lineNumber,
        });
      }
      continue;
    }
    const allMarked = group.every((h) => h.part !== null);
    if (!allMarked) {
      issues.push({
        code: "DUPLICATE_CHAPTER_NUMBER",
        message: `หัวบทเลข ${number} ซ้ำกัน ${group.length} ครั้ง`,
        chapterNumber: number,
        lineNumber,
      });
      continue;
    }
    const total = group.length;
    const wellFormed = group.every((h, i) => h.part!.total === total && h.part!.index === i + 1);
    if (!wellFormed) {
      issues.push({
        code: "PART_SEQUENCE_INVALID",
        message: `ส่วนของบทที่ ${number} ไม่เรียงครบ 1..${total}`,
        chapterNumber: number,
        lineNumber,
      });
    }
  }

  // Sequence: first = start, increasing, nothing beyond end, nothing missing.
  const numbers = groups.map((g) => g[0].chapterNumber);
  if (numbers[0] !== range.start) {
    issues.push({
      code: "FIRST_CHAPTER_MISMATCH",
      message: `บทแรกในเนื้อหาคือบทที่ ${numbers[0]} แต่ช่วงแพ็กเริ่มที่ ${range.start}`,
      chapterNumber: numbers[0],
      lineNumber: groups[0][0].line.index + 1,
    });
  }
  const seen = new Set<number>();
  for (let i = 0; i < groups.length; i += 1) {
    const number = numbers[i];
    const lineNumber = groups[i][0].line.index + 1;
    if (seen.has(number)) {
      issues.push({
        code: "DUPLICATE_CHAPTER_NUMBER",
        message: `หัวบทเลข ${number} ปรากฏซ้ำในตำแหน่งที่ไม่ติดกัน`,
        chapterNumber: number,
        lineNumber,
      });
    } else if (i > 0 && number < numbers[i - 1]) {
      issues.push({
        code: "OUT_OF_ORDER",
        message: `บทที่ ${number} อยู่หลังบทที่ ${numbers[i - 1]}`,
        chapterNumber: number,
        lineNumber,
      });
    }
    if (number > range.end) {
      issues.push({
        code: "EXTRA_CHAPTER_BEYOND_RANGE",
        message: `บทที่ ${number} เกินปลายช่วงแพ็ก (${range.start} - ${range.end})`,
        chapterNumber: number,
        lineNumber,
      });
    }
    seen.add(number);
  }
  const missing: number[] = [];
  for (let n = range.start; n <= range.end; n += 1) if (!seen.has(n)) missing.push(n);
  if (missing.length > 0) {
    const listed = missing.slice(0, MAX_LISTED_MISSING).join(", ");
    issues.push({
      code: "MISSING_CHAPTER",
      message: `ไม่พบบทที่ ${listed}${missing.length > MAX_LISTED_MISSING ? ` และอีก ${missing.length - MAX_LISTED_MISSING} บท` : ""}`,
      chapterNumber: missing[0],
    });
  }

  // Build chapter slices on the ORIGINAL content.
  const chapters: SplitChapter[] = groups.map((group, i) => {
    const first = group[0];
    const sourceStart = first.line.start;
    const nextGroup = groups[i + 1];
    const sourceEnd = nextGroup ? nextGroup[0].line.start : content.length;
    const endLine = nextGroup ? nextGroup[0].line.index : lines.length;
    const slice = content.slice(sourceStart, sourceEnd);
    return {
      chapterNumber: first.chapterNumber,
      title: first.title,
      sourceStart,
      sourceEnd,
      startLine: first.line.index,
      endLine,
      partCount: group.length,
      content: slice,
      contentSha256: sha256Hex(slice),
      bodyCharCount: stripHeadingLines(slice).length,
    };
  });

  for (const chapter of chapters) {
    if (chapter.bodyCharCount === 0) {
      issues.push({
        code: "EMPTY_CHAPTER",
        message: `บทที่ ${chapter.chapterNumber} มีแค่หัวบท ไม่มีเนื้อเรื่อง`,
        chapterNumber: chapter.chapterNumber,
        lineNumber: chapter.startLine + 1,
      });
    }
  }

  // Coverage invariant: preamble + the STORED chapter texts re-concatenate to
  // the exact source (checks what will be written, not just the offsets).
  const preambleEnd = chapters.length > 0 ? chapters[0].sourceStart : content.length;
  const rebuilt = content.slice(0, preambleEnd) + chapters.map((c) => c.content).join("");
  const contiguous = chapters.every((c, i) => (i === 0 ? c.sourceStart === preambleEnd : c.sourceStart === chapters[i - 1].sourceEnd));
  if (rebuilt !== content || !contiguous || (chapters.length > 0 && chapters[chapters.length - 1].sourceEnd !== content.length)) {
    issues.push({ code: "COVERAGE_MISMATCH", message: "การแบ่งบทไม่ครอบคลุมเนื้อหาเดิมครบทุกตัวอักษร" });
  }

  const partial = {
    ...base,
    range,
    preamble: { sourceStart: 0 as const, sourceEnd: preambleEnd, kind: preambleKind },
    chapters,
  };
  const ok = issues.length === 0;
  return { ...partial, ok, issues, planHash: ok ? canonicalPlanHash(partial) : null };
}
