/**
 * IPE-059-B — Thai-Novel upload export domain (PURE module).
 *
 * Builds upload-ready flat TXT files for the Thai-Novel portal, where the
 * portal derives episode order from FILENAME ordering (001.txt, 002.txt, ...)
 * and each file's first physical line is the episode title.
 *
 * Proven portal-compatible TXT contract (preserved from the legacy working
 * exporter — do not "fix" the blank line without evidence):
 *
 *   <episode title>\n
 *   \n
 *   <body>\n
 *
 * i.e. title + "\n\n" + normalized content. No manifest.csv, no contents/
 * folder: the ZIP is a convenience container of flat `NNN.txt` files only.
 *
 * Pure module: no database, no side effects. Reuses the IPE-059-A export
 * domain for source limits, canonical ordering, text normalization and
 * filename safety so both export modes share one authority.
 */

import AdmZip from "adm-zip";
import {
  FIXED_ZIP_TIMESTAMP,
  MAX_EXPORT_PER_ITEM_BYTES,
  MAX_EXPORT_ZIP_BYTES,
  NovelExportError,
  NovelExportItem,
  NovelExportPackage,
  flattenExportManifestField,
  normalizeExportText,
  sanitizeExportFilenameComponent,
  sortExportItemsCanonical,
  validateExportPackage,
} from "./novelExport.domain";

/** Filename suffix distinguishing Thai-Novel upload packages from A backups. */
export const THAI_NOVEL_ZIP_SUFFIX = "-thainovel";
/** Proven separator between title line and body (legacy exporter behavior). */
export const THAI_NOVEL_TITLE_SEPARATOR = "\n\n";
/** Minimum zero-padding width for generated filenames; never truncates. */
export const THAI_NOVEL_FILENAME_PAD = 3;

export interface ThaiNovelExportOptions {
  /** First generated episode number (default 1). */
  startEpisodeNumber?: number;
  /** Prepended to the title line, joined with a single space (default none). */
  titlePrefix?: string;
  /** Append the generated filename stem to the title line (default false). */
  appendFilenameToTitle?: boolean;
}

export interface ThaiNovelExportEntry {
  episodeId: number;
  /** Raw canonical episodeNumber as stored (e.g. "391", "001-050"). */
  sourceEpisodeNumber: string;
  /** Generated sequential number after start-override renumbering ("001"). */
  generatedNumber: string;
  /** Flat ZIP-root filename ("001.txt"). */
  filename: string;
  /** Final first-line title after prefix/append options. */
  title: string;
  /** Full TXT bytes content as string (UTF-8 when encoded). */
  text: string;
  byteLength: number;
}

/** Preview row = entry without the heavy text payload. */
export interface ThaiNovelPreviewEntry {
  episodeId: number;
  sourceEpisodeNumber: string;
  generatedNumber: string;
  filename: string;
  title: string;
  byteLength: number;
}

export function normalizeThaiNovelOptions(options: ThaiNovelExportOptions | undefined): Required<ThaiNovelExportOptions> {
  const raw = options ?? {};
  const start = raw.startEpisodeNumber ?? 1;
  if (!Number.isInteger(start) || start < 1) {
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

/**
 * Sequential generated number: zero-padded to 3 digits minimum, never
 * truncated (1000th item -> "1000"). Deterministic.
 */
export function resolveThaiNovelGeneratedNumber(startNumber: number, index: number): string {
  return String(startNumber + index).padStart(THAI_NOVEL_FILENAME_PAD, "0");
}

export function resolveThaiNovelFilename(generatedNumber: string): string {
  return `${generatedNumber}.txt`;
}

function titleAlreadyHasPrefix(title: string, prefix: string): boolean {
  return title === prefix || title.startsWith(`${prefix} `);
}

function titleAlreadyEndsWithToken(title: string, token: string): boolean {
  return title === token || title.endsWith(` ${token}`);
}

/**
 * Final first-line title. The title must stay a single physical line (the
 * portal contract reads it as line 1), so it is single-line flattened like
 * manifest cells. Prefix/filename are never duplicated when already present.
 */
export function resolveThaiNovelTitle(
  item: Pick<NovelExportItem, "episodeTitle">,
  generatedNumber: string,
  options: Required<ThaiNovelExportOptions>
): string {
  let title = flattenExportManifestField(item.episodeTitle);
  if (!title) title = generatedNumber;

  const prefix = options.titlePrefix;
  if (prefix && !titleAlreadyHasPrefix(title, prefix)) {
    title = `${prefix} ${title}`.replace(/\s+/g, " ").trim();
  }
  if (options.appendFilenameToTitle && !titleAlreadyEndsWithToken(title, generatedNumber)) {
    title = `${title} ${generatedNumber}`;
  }
  return title;
}

/**
 * Full TXT body for one entry: proven portal contract
 * title + "\n\n" + canonical normalized content (LF, UTF-8, no BOM).
 */
export function buildThaiNovelTxt(item: NovelExportItem, title: string): string {
  return `${title}${THAI_NOVEL_TITLE_SEPARATOR}${normalizeExportText(item.content)}`;
}

/**
 * Deterministic entries for the package: canonical source ordering first,
 * then sequential renumbering from the start number — a selected subset
 * (5, 7, 10 with start=1) becomes 001/002/003 in canonical source order.
 */
export function buildThaiNovelExportEntries(
  pkg: NovelExportPackage,
  options?: ThaiNovelExportOptions
): ThaiNovelExportEntry[] {
  validateExportPackage(pkg);
  const opts = normalizeThaiNovelOptions(options);

  return sortExportItemsCanonical(pkg.items).map((item, index) => {
    const generatedNumber = resolveThaiNovelGeneratedNumber(opts.startEpisodeNumber, index);
    const filename = resolveThaiNovelFilename(generatedNumber);
    const title = resolveThaiNovelTitle(item, generatedNumber, opts);
    const text = buildThaiNovelTxt(item, title);
    const byteLength = Buffer.byteLength(text, "utf8");

    if (byteLength > MAX_EXPORT_PER_ITEM_BYTES) {
      throw new NovelExportError(
        "EXPORT_LIMIT_ENTRY_BYTES",
        `ไฟล์ TXT ใหญ่เกินกำหนด (episodeId ${item.episodeId}, ${byteLength} bytes > ${MAX_EXPORT_PER_ITEM_BYTES})`,
        { episodeId: item.episodeId, entryBytes: byteLength, maxEntryBytes: MAX_EXPORT_PER_ITEM_BYTES }
      );
    }

    return {
      episodeId: item.episodeId,
      sourceEpisodeNumber: item.episodeNumber,
      generatedNumber,
      filename,
      title,
      text,
      byteLength,
    };
  });
}

/** Preview rows derived from the exact same serializer output as the download. */
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

/**
 * Flat-root ZIP of upload-ready TXT files: `001.txt`, `002.txt`, ... at the
 * archive root — NO manifest.csv, NO contents/ folder. Deterministic bytes:
 * canonical entry order + fixed entry timestamps (same infrastructure as A).
 */
export function buildThaiNovelExportZip(
  pkg: NovelExportPackage,
  options?: ThaiNovelExportOptions
): ThaiNovelZipExport {
  const entries = buildThaiNovelExportEntries(pkg, options);
  const zip = new AdmZip();

  const seenEntryPaths = new Set<string>();
  for (const entry of entries) {
    // Defense in depth: filenames are generated numerically here, but the
    // guard is cheap and keeps the "never overwrite an entry silently" rule.
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
    // adm-zip physically stores entries lexicographically — report the
    // actual archive order (deterministic), matching A's behavior.
    entryFilenames: zip.getEntries().map((zipEntry) => zipEntry.entryName),
    itemCount: entries.length,
    totalPlaintextBytes: entries.reduce((sum, entry) => sum + entry.byteLength, 0),
  };
}
