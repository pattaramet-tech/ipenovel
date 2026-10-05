/**
 * IPE-059-C source fix — Thai-Novel upload export domain (PURE module).
 *
 * The attached, known-good Naruto bulk TXT archive is the source-of-truth
 * contract for Thai-Novel output:
 *
 * - one logical chapter per TXT file;
 * - the TXT filename is the sanitized first-line chapter heading;
 * - the first physical line inside the TXT is the original chapter heading;
 * - exactly one blank separator line follows the heading;
 * - pack wrapper lines such as "แพ็กตอน 141 - 190 001" never appear in an
 *   exported chapter file;
 * - flat ZIP root, UTF-8 without BOM, LF newlines, no manifest.csv.
 *
 * Range/pack Episodes are therefore expanded into their embedded "บทที่ N"
 * sections before serialization. The expansion is fail-closed: a range must
 * contain the exact contiguous chapter sequence declared by episodeNumber.
 */

import AdmZip from "adm-zip";
import {
  FIXED_ZIP_TIMESTAMP,
  MAX_EXPORT_ITEMS,
  MAX_EXPORT_PER_ITEM_BYTES,
  MAX_EXPORT_TOTAL_BYTES,
  MAX_EXPORT_ZIP_BYTES,
  NovelExportError,
  NovelExportItem,
  NovelExportPackage,
  flattenExportManifestField,
  normalizeExportText,
  parseExportEpisodeIdentity,
  sanitizeExportFilenameComponent,
  sortExportItemsCanonical,
  validateExportPackage,
} from "./novelExport.domain";

/** Filename suffix distinguishing Thai-Novel upload packages from A backups. */
export const THAI_NOVEL_ZIP_SUFFIX = "-thainovel";
/** Proven separator between title line and body. */
export const THAI_NOVEL_TITLE_SEPARATOR = "\n\n";
/** Minimum zero-padding width retained for optional generated numbering. */
export const THAI_NOVEL_FILENAME_PAD = 3;

const THAI_NOVEL_CHAPTER_HEADING_RE = /^บทที่[ \t]+(\d+)(?:[ \t]+[^\n]*)?$/gm;
const THAI_NOVEL_SINGLE_CHAPTER_HEADING_RE = /^บทที่[ \t]+(\d+)(?:[ \t]+[^\n]*)?$/;
const THAI_NOVEL_PACK_HEADER_RE = /^แพ็กตอน[ \t]+(\d+)[ \t]*-[ \t]*(\d+)(?:[ \t]+\d+)?$/;

export interface ThaiNovelExportOptions {
  /**
   * Optional sequential chapter-number override. When omitted, embedded
   * chapter numbers are preserved exactly as in the source heading.
   */
  startEpisodeNumber?: number;
  /** Prepended to the title line, joined with a single space (default none). */
  titlePrefix?: string;
  /** Append the generated chapter-number token to the title (default false). */
  appendFilenameToTitle?: boolean;
}

export interface NormalizedThaiNovelExportOptions {
  startEpisodeNumber: number | null;
  titlePrefix: string;
  appendFilenameToTitle: boolean;
}

export interface ThaiNovelExportEntry {
  episodeId: number;
  /** Raw canonical Episode identity as stored (e.g. "141 - 190"). */
  sourceEpisodeNumber: string;
  /** Logical chapter number after expanding a pack, e.g. "141". */
  sourceChapterNumber: string;
  /** Sequential/preserved numeric token, zero-padded to 3 digits minimum. */
  generatedNumber: string;
  /** Flat ZIP-root filename derived from the first-line title. */
  filename: string;
  /** Final first-line title after optional renumber/prefix/append transforms. */
  title: string;
  /** Full TXT bytes content as string (UTF-8 when encoded). */
  text: string;
  byteLength: number;
}

/** Preview row = entry without the heavy text payload. */
export interface ThaiNovelPreviewEntry {
  episodeId: number;
  sourceEpisodeNumber: string;
  sourceChapterNumber: string;
  generatedNumber: string;
  filename: string;
  title: string;
  byteLength: number;
}

interface ThaiNovelLogicalChapter {
  item: NovelExportItem;
  sourceChapterNumber: string;
  sourceTitle: string;
  body: string;
}

export function normalizeThaiNovelOptions(
  options: ThaiNovelExportOptions | undefined
): NormalizedThaiNovelExportOptions {
  const raw = options ?? {};
  const start = raw.startEpisodeNumber ?? null;
  if (start !== null && (!Number.isInteger(start) || start < 1)) {
    throw new NovelExportError(
      "EXPORT_INVALID_SALE_METADATA",
      `เริ่มตอนที่ต้องเป็นจำนวนเต็มตั้งแต่ 1 ขึ้นไป (พบ "${String(raw.startEpisodeNumber)}")`,
      { startEpisodeNumber: start }
    );
  }
  return {
    startEpisodeNumber: start,
    titlePrefix: String(raw.titlePrefix ?? "").trim(),
    appendFilenameToTitle: Boolean(raw.appendFilenameToTitle),
  };
}

/** Zero-pad to 3 digits minimum; never truncate larger numbers. */
export function resolveThaiNovelGeneratedNumber(startNumber: number, index: number): string {
  return String(startNumber + index).padStart(THAI_NOVEL_FILENAME_PAD, "0");
}

/**
 * Known-good Naruto contract: filename stem mirrors the first physical line,
 * with only filesystem-unsafe characters sanitized.
 */
export function resolveThaiNovelFilename(title: string, fallbackStem = "chapter"): string {
  return `${sanitizeExportFilenameComponent(title, fallbackStem)}.txt`;
}

function titleAlreadyHasPrefix(title: string, prefix: string): boolean {
  return title === prefix || title.startsWith(`${prefix} `);
}

function titleAlreadyEndsWithToken(title: string, token: string): boolean {
  return title === token || title.endsWith(` ${token}`);
}

function rewriteLeadingThaiChapterNumber(title: string, chapterNumber: number): string {
  return title.replace(/^บทที่[ \t]+\d+(?=[ \t]|$)/, `บทที่ ${chapterNumber}`);
}

/**
 * Final first-line title. By default source chapter headings are preserved
 * verbatim. An explicit startEpisodeNumber may renumber a leading "บทที่ N"
 * token; prefix/append remain opt-in compatibility features.
 */
export function resolveThaiNovelTitle(
  sourceTitle: string,
  generatedNumber: string,
  options: NormalizedThaiNovelExportOptions,
  explicitChapterNumber?: number
): string {
  let title = flattenExportManifestField(sourceTitle);
  if (!title) title = generatedNumber;

  if (explicitChapterNumber !== undefined) {
    title = rewriteLeadingThaiChapterNumber(title, explicitChapterNumber);
  }

  const prefix = options.titlePrefix;
  if (prefix && !titleAlreadyHasPrefix(title, prefix)) {
    title = `${prefix} ${title}`.replace(/\s+/g, " ").trim();
  }
  if (options.appendFilenameToTitle && !titleAlreadyEndsWithToken(title, generatedNumber)) {
    title = `${title} ${generatedNumber}`;
  }
  return title;
}

/** Full TXT: title + blank line + canonical LF-normalized body. */
export function buildThaiNovelTxt(body: string, title: string): string {
  return `${title}${THAI_NOVEL_TITLE_SEPARATOR}${normalizeExportText(body)}`;
}

function stripOuterNewlines(text: string): string {
  return text.replace(/^\n+/, "").replace(/\n+$/, "");
}

function invalidPack(item: NovelExportItem, message: string): never {
  throw new NovelExportError(
    "EXPORT_INVALID_EPISODE_IDENTITY",
    `${message} (episodeId ${item.episodeId}, episodeNumber "${item.episodeNumber}")`,
    { episodeId: item.episodeId }
  );
}

function expandRangePack(item: NovelExportItem, start: number, end: number): ThaiNovelLogicalChapter[] {
  if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) {
    return invalidPack(item, "ช่วงตอนของแพ็กต้องเป็นจำนวนเต็มเรียงจากน้อยไปมาก");
  }

  const normalized = normalizeExportText(item.content);
  const matches: RegExpExecArray[] = [];
  THAI_NOVEL_CHAPTER_HEADING_RE.lastIndex = 0;
  let headingMatch: RegExpExecArray | null;
  while ((headingMatch = THAI_NOVEL_CHAPTER_HEADING_RE.exec(normalized)) !== null) {
    matches.push(headingMatch);
  }
  if (matches.length === 0) {
    return invalidPack(item, "ไม่พบหัวบท 'บทที่ N' ภายในตอนแบบแพ็ก");
  }

  const firstIndex = matches[0].index ?? 0;
  const preamble = normalized.slice(0, firstIndex).trim();
  if (preamble) {
    const header = preamble.match(THAI_NOVEL_PACK_HEADER_RE);
    if (!header || Number(header[1]) !== start || Number(header[2]) !== end) {
      return invalidPack(item, "พบบรรทัดก่อนหัวบทที่ไม่ใช่ pack header ที่ตรงกับช่วงตอน");
    }
  }

  const expectedCount = end - start + 1;
  // IPE-064R3: headings FEWER than the declared range stay a defect (missing
  // chapters). Headings BEYOND the declared end are allowed — the pack
  // genuinely contains extra chapters (พบ 52, คาด 50) — as long as the
  // sequence check below proves they continue 141, 142, … without gaps or
  // duplicates; any sequence break still blocks.
  if (matches.length < expectedCount) {
    return invalidPack(item, `จำนวนหัวบทในแพ็กไม่ตรงช่วงที่ประกาศ (พบ ${matches.length}, คาด ${expectedCount})`);
  }

  const numbers = matches.map((match) => Number(match[1]));
  for (let index = 0; index < numbers.length; index += 1) {
    const expected = start + index;
    if (numbers[index] !== expected) {
      return invalidPack(item, `ลำดับหัวบทในแพ็กไม่ต่อเนื่อง (พบ ${numbers[index]}, คาด ${expected})`);
    }
  }

  return matches.map((match, index) => {
    const matchIndex = match.index ?? 0;
    const bodyStart = matchIndex + match[0].length;
    const bodyEnd = index + 1 < matches.length ? (matches[index + 1].index ?? normalized.length) : normalized.length;
    return {
      item,
      sourceChapterNumber: match[1],
      sourceTitle: match[0].trim(),
      body: stripOuterNewlines(normalized.slice(bodyStart, bodyEnd)),
    };
  });
}

function expandSingleEpisode(item: NovelExportItem, sourceNumber: number): ThaiNovelLogicalChapter[] {
  const normalized = normalizeExportText(item.content);
  const withoutLeadingBlankLines = normalized.replace(/^\n+/, "");
  const firstBreak = withoutLeadingBlankLines.indexOf("\n");
  const firstLine = firstBreak >= 0 ? withoutLeadingBlankLines.slice(0, firstBreak) : withoutLeadingBlankLines;
  const heading = firstLine.match(THAI_NOVEL_SINGLE_CHAPTER_HEADING_RE);

  if (heading && Number(heading[1]) === sourceNumber) {
    const body = firstBreak >= 0 ? withoutLeadingBlankLines.slice(firstBreak + 1) : "";
    return [{
      item,
      sourceChapterNumber: heading[1],
      sourceTitle: firstLine.trim(),
      body: stripOuterNewlines(body),
    }];
  }

  return [{
    item,
    sourceChapterNumber: String(sourceNumber),
    sourceTitle: flattenExportManifestField(item.episodeTitle) || String(sourceNumber),
    body: normalized,
  }];
}

/**
 * Expand canonical source Episodes into logical Thai-Novel chapters.
 * Range identities must split to every declared chapter — fewer headings
 * than declared is a defect; sequential extras beyond the declared end are
 * included (IPE-064R3).
 */
export function expandThaiNovelLogicalChapters(pkg: NovelExportPackage): ThaiNovelLogicalChapter[] {
  validateExportPackage(pkg);

  const chapters = expandItemsToLogicalChapters(pkg.items);

  if (chapters.length > MAX_EXPORT_ITEMS) {
    throw new NovelExportError(
      "EXPORT_LIMIT_ITEMS",
      `จำนวนบทหลังแยกแพ็กเกินกำหนด (${chapters.length} > ${MAX_EXPORT_ITEMS})`,
      { itemCount: chapters.length, maxItems: MAX_EXPORT_ITEMS }
    );
  }

  assertNoCrossItemChapterCollisions(chapters);

  return chapters;
}

function expandItemsToLogicalChapters(items: NovelExportItem[]): ThaiNovelLogicalChapter[] {
  return sortExportItemsCanonical(items).flatMap((item) => {
    const identity = parseExportEpisodeIdentity(item.episodeNumber);
    if (!identity) {
      return invalidPack(item, "episodeNumber ไม่มีเลขตอนที่อ่านได้");
    }
    return identity.kind === "range"
      ? expandRangePack(item, identity.start, identity.end)
      : expandSingleEpisode(item, identity.start);
  });
}

/**
 * IPE-064R4B (P2): a sequential overrun must never silently overlap ANOTHER
 * pack — e.g. declared 141-190 with headings through 192 while a normal
 * 191-240 pack also exists would expand the same chapter twice (duplicate
 * filenames, or duplicated renumbered content). Fail closed on any
 * cross-item chapter-number collision; within one item the sequence check
 * already rejects duplicates. Collision identity is the NUMERIC chapter
 * number — raw heading strings like "001" and "1" are the same chapter.
 */
export function assertNoCrossItemChapterCollisions(chapters: ThaiNovelLogicalChapter[]): void {
  const seenByChapterNumber = new Map<string, NovelExportItem>();
  for (const chapter of chapters) {
    const collisionKey = /^\d+$/.test(chapter.sourceChapterNumber)
      ? String(Number(chapter.sourceChapterNumber))
      : chapter.sourceChapterNumber;
    const previous = seenByChapterNumber.get(collisionKey);
    if (previous && previous.episodeId !== chapter.item.episodeId) {
      throw new NovelExportError(
        "EXPORT_INVALID_EPISODE_IDENTITY",
        `พบบทที่ ${chapter.sourceChapterNumber} ซ้ำข้ามแพ็ก (${previous.episodeNumber} และ ${chapter.item.episodeNumber})`,
        { sourceChapterNumber: chapter.sourceChapterNumber }
      );
    }
    seenByChapterNumber.set(collisionKey, chapter.item);
  }
}

/**
 * IPE-064R4B (P2): per-pack subset exports must not silently double-export
 * chapters that an overrunning pack shares with a following pack — the
 * selected-subset collision loop cannot see outside its selection. Validates
 * the FULL published episode list of the novel (no MAX_EXPORT_ITEMS count
 * limit here; subsets stay under it and whole-scope keeps its own check).
 */
export function assertNoCrossPackChapterCollisions(
  items: NovelExportItem[],
  selectedItemIds: ReadonlySet<number> | null
): void {
  // IPE-064R4B review round 3 (P2): an UNSELECTED malformed pack (e.g. a
  // legacy range with fewer headings than declared) must not block exporting
  // a valid subset — skip expansion failures of unselected items and only
  // fail closed when the defect belongs to a selected item (or a whole-novel
  // export, where every item is selected). Unparseable legacy identities are
  // skipped outright: they cannot be numerically validated, and the
  // selected-item path still fail-closes on them.
  const chapters: ThaiNovelLogicalChapter[] = [];
  for (const item of sortExportItemsCanonical(items)) {
    const identity = parseExportEpisodeIdentity(item.episodeNumber);
    if (!identity) continue;
    try {
      const expanded =
        identity.kind === "range"
          ? expandRangePack(item, identity.start, identity.end)
          : expandSingleEpisode(item, identity.start);
      chapters.push(...expanded);
    } catch (error) {
      if (selectedItemIds === null || selectedItemIds.has(item.episodeId)) {
        throw error;
      }
    }
  }
  // IPE-064R4B review round 6 (P2): a collision wholly between two
  // UNSELECTED packs is an unrelated data defect — it must not block
  // exporting the selected subset. Throw only when the scope is whole
  // (every pack is being exported) or at least one participant is selected.
  const seenByChapterNumber = new Map<string, NovelExportItem>();
  for (const chapter of chapters) {
    const collisionKey = /^\d+$/.test(chapter.sourceChapterNumber)
      ? String(Number(chapter.sourceChapterNumber))
      : chapter.sourceChapterNumber;
    const previous = seenByChapterNumber.get(collisionKey);
    if (
      previous &&
      previous.episodeId !== chapter.item.episodeId &&
      (selectedItemIds === null ||
        selectedItemIds.has(previous.episodeId) ||
        selectedItemIds.has(chapter.item.episodeId))
    ) {
      throw new NovelExportError(
        "EXPORT_INVALID_EPISODE_IDENTITY",
        `พบบทที่ ${chapter.sourceChapterNumber} ซ้ำข้ามแพ็ก (${previous.episodeNumber} และ ${chapter.item.episodeNumber})`,
        { sourceChapterNumber: chapter.sourceChapterNumber }
      );
    }
    seenByChapterNumber.set(collisionKey, chapter.item);
  }
}

/**
 * Deterministic entries. Default behavior preserves embedded chapter numbers
 * and source headings, matching the attached Naruto bulk TXT example.
 */
export function buildThaiNovelExportEntries(
  pkg: NovelExportPackage,
  options?: ThaiNovelExportOptions
): ThaiNovelExportEntry[] {
  const opts = normalizeThaiNovelOptions(options);
  const chapters = expandThaiNovelLogicalChapters(pkg);
  let totalBytes = 0;

  const entries = chapters.map((chapter, index) => {
    const sourceChapterNumber = Number(chapter.sourceChapterNumber);
    const explicitChapterNumber = opts.startEpisodeNumber === null
      ? undefined
      : opts.startEpisodeNumber + index;
    const numericForToken = explicitChapterNumber ?? sourceChapterNumber;
    const generatedNumber = String(numericForToken).padStart(THAI_NOVEL_FILENAME_PAD, "0");
    const title = resolveThaiNovelTitle(
      chapter.sourceTitle,
      generatedNumber,
      opts,
      explicitChapterNumber
    );
    const filename = resolveThaiNovelFilename(title, generatedNumber);
    const text = buildThaiNovelTxt(chapter.body, title);
    const byteLength = Buffer.byteLength(text, "utf8");

    if (byteLength > MAX_EXPORT_PER_ITEM_BYTES) {
      throw new NovelExportError(
        "EXPORT_LIMIT_ENTRY_BYTES",
        `ไฟล์ TXT ใหญ่เกินกำหนด (episodeId ${chapter.item.episodeId}, ${byteLength} bytes > ${MAX_EXPORT_PER_ITEM_BYTES})`,
        { episodeId: chapter.item.episodeId, entryBytes: byteLength, maxEntryBytes: MAX_EXPORT_PER_ITEM_BYTES }
      );
    }
    totalBytes += byteLength;

    return {
      episodeId: chapter.item.episodeId,
      sourceEpisodeNumber: chapter.item.episodeNumber,
      sourceChapterNumber: chapter.sourceChapterNumber,
      generatedNumber,
      filename,
      title,
      text,
      byteLength,
    };
  });

  if (totalBytes > MAX_EXPORT_TOTAL_BYTES) {
    throw new NovelExportError(
      "EXPORT_LIMIT_TOTAL_BYTES",
      `ขนาด TXT รวมหลังแยกแพ็กเกินกำหนด (${totalBytes} bytes > ${MAX_EXPORT_TOTAL_BYTES})`,
      { totalBytes, maxTotalBytes: MAX_EXPORT_TOTAL_BYTES }
    );
  }

  return entries;
}

/** Preview rows derived from the exact same entries as the download. */
export function buildThaiNovelPreviewRows(entries: ThaiNovelExportEntry[]): ThaiNovelPreviewEntry[] {
  return entries.map(({ text: _text, ...preview }) => preview);
}

function buildThaiNovelZipFilename(novelTitle: string, novelId: number): string {
  const base = sanitizeExportFilenameComponent(novelTitle, `novel-${novelId}`);
  return `${base}${THAI_NOVEL_ZIP_SUFFIX}.zip`;
}

export interface ThaiNovelZipExport {
  filename: string;
  mimeType: "application/zip";
  content: Buffer;
  entries: ThaiNovelPreviewEntry[];
  entryFilenames: string[];
  itemCount: number;
  totalPlaintextBytes: number;
}

/** Flat-root ZIP of one-chapter-per-TXT files. */
export function buildThaiNovelExportZip(
  pkg: NovelExportPackage,
  options?: ThaiNovelExportOptions
): ThaiNovelZipExport {
  const entries = buildThaiNovelExportEntries(pkg, options);
  const zip = new AdmZip();

  const seenEntryPaths = new Set<string>();
  for (const entry of entries) {
    if (!entry.filename || entry.filename.includes("\0") || entry.filename.includes("/") || entry.filename.includes("\\")) {
      throw new NovelExportError("EXPORT_UNSAFE_PATH", `พบชื่อไฟล์ที่ไม่ปลอดภัย: "${entry.filename}"`);
    }
    const pathKey = entry.filename.toLowerCase();
    if (seenEntryPaths.has(pathKey)) {
      throw new NovelExportError("EXPORT_UNSAFE_PATH", `พบชื่อไฟล์ซ้ำใน zip: "${entry.filename}"`);
    }
    seenEntryPaths.add(pathKey);
    zip.addFile(entry.filename, Buffer.from(entry.text, "utf8"));
  }

  for (const zipEntry of zip.getEntries()) {
    zipEntry.header.time = FIXED_ZIP_TIMESTAMP;
  }

  const content = zip.toBuffer();
  if (content.length > MAX_EXPORT_ZIP_BYTES) {
    throw new NovelExportError(
      "EXPORT_LIMIT_ZIP_BYTES",
      `ไฟล์ zip ที่สร้างใหญ่เกินกำหนด (${content.length} bytes > ${MAX_EXPORT_ZIP_BYTES})`,
      { zipBytes: content.length, maxZipBytes: MAX_EXPORT_ZIP_BYTES }
    );
  }

  return {
    filename: buildThaiNovelZipFilename(pkg.novelTitle, pkg.novelId),
    mimeType: "application/zip",
    content,
    entries: buildThaiNovelPreviewRows(entries),
    entryFilenames: zip.getEntries().map((zipEntry) => zipEntry.entryName),
    itemCount: entries.length,
    totalPlaintextBytes: entries.reduce((sum, entry) => sum + entry.byteLength, 0),
  };
}
