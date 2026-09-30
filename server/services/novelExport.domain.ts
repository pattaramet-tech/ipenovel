/**
 * IPE-059-A — Novel export domain (PURE module).
 *
 * Deterministic TXT/ZIP serialization of canonical published IpeNovel
 * content. This module must never import the database or any service with
 * side effects: it receives fully-mapped rows and only decides ordering,
 * filename safety, manifest bytes, TXT bytes and ZIP structure.
 *
 * Round-trip contract: the generated ZIP is intentionally compatible with
 * the existing package ZIP import contract in `packageZipImportService.ts`
 * (same manifest headers, `contents/*.txt` layout, UTF-8 no-BOM). Two
 * existing-parser constraints shape this module and are deliberate:
 * 1. `parseCsvManifest` is line-oriented (splits on "\n" before unquoting),
 *    so manifest fields are flattened to single lines instead of using
 *    RFC multi-line quoted fields.
 * 2. The package import flow only accepts `saleMode = "package"` rows;
 *    chapter-mode episodes are still exported (full-fidelity admin backup)
 *    and the importer's own validation rejects those rows on re-import.
 */

import AdmZip from "adm-zip";

// ============ Package layout constants ============

export const EXPORT_MANIFEST_FILENAME = "manifest.csv";
export const EXPORT_CONTENTS_DIR = "contents";

/**
 * Exact manifest columns written by the exporter - the subset of
 * `packageZipImportService` HEADER_ALIASES the importer actually reads, in
 * a fixed order. Column names use the importer's canonical (normalized)
 * spellings, so `normalizeHeader` maps them 1:1.
 */
export const EXPORT_MANIFEST_HEADERS = [
  "episodeNumber",
  "episodeTitle",
  "price",
  "isFree",
  "isPublished",
  "saleMode",
  "contentFile",
  "contentFormat",
  "sortOrder",
  "description",
] as const;

// ============ Resource limits (bounded, fail closed) ============

export const MAX_EXPORT_ITEMS = 500;
/**
 * Mirrors the importer's per-content-file cap so anything we export always
 * passes the importer's own MAX_TXT_SIZE_BYTES check on round-trip.
 */
export const MAX_EXPORT_PER_ITEM_BYTES = 8 * 1024 * 1024;
export const MAX_EXPORT_TOTAL_BYTES = 40 * 1024 * 1024;
/**
 * Final ZIP byte cap. Chosen so `contentBase64` (~4/3 of raw bytes) stays
 * under the 50MB Express JSON body limit used by the existing tRPC ZIP
 * transport (see packageZipImportService.ts header comment).
 */
export const MAX_EXPORT_ZIP_BYTES = 24 * 1024 * 1024;

/**
 * Fixed ZIP timestamp (ZIP/DOS resolution is 2 seconds). adm-zip defaults
 * entry timestamps to the current time; we overwrite every entry's header
 * time with this constant so the same input produces byte-identical output.
 */
export const FIXED_ZIP_TIMESTAMP = new Date(Date.UTC(2000, 0, 1, 0, 0, 0));

// ============ Types ============

export type ExportSaleMode = "chapter" | "package";
export type ExportContentFormat = "plain_text" | "markdown" | "html";

export interface NovelExportItem {
  episodeId: number;
  /** Raw canonical episodeNumber as stored (e.g. "12", "001 - 050"). */
  episodeNumber: string;
  episodeTitle: string;
  content: string;
  /** Price exactly as stored (decimal string, e.g. "0.00", "25.00"). */
  price: string;
  isFree: boolean;
  saleMode: ExportSaleMode;
  contentFormat: ExportContentFormat;
  sortOrder: number | null;
  description: string | null;
}

export interface NovelExportPackage {
  novelId: number;
  novelTitle: string;
  items: NovelExportItem[];
}

export type NovelExportErrorCode =
  | "EXPORT_NOVEL_NOT_FOUND"
  | "EXPORT_EMPTY_SELECTION"
  | "EXPORT_UNKNOWN_EPISODE"
  | "EXPORT_EPISODE_NOT_IN_NOVEL"
  | "EXPORT_DUPLICATE_SELECTION"
  | "EXPORT_EPISODE_MISSING_CONTENT"
  | "EXPORT_INVALID_EPISODE_IDENTITY"
  | "EXPORT_INVALID_SALE_METADATA"
  | "EXPORT_LIMIT_ITEMS"
  | "EXPORT_LIMIT_ENTRY_BYTES"
  | "EXPORT_LIMIT_TOTAL_BYTES"
  | "EXPORT_LIMIT_ZIP_BYTES"
  | "EXPORT_UNSAFE_PATH";

export class NovelExportError extends Error {
  readonly code: NovelExportErrorCode;
  /** Bounded context only - never novel text or full titles. */
  readonly details?: Record<string, string | number | boolean>;

  constructor(code: NovelExportErrorCode, message: string, details?: Record<string, string | number | boolean>) {
    super(message);
    this.name = "NovelExportError";
    this.code = code;
    this.details = details;
  }
}

// ============ Text normalization ============

/**
 * Canonical newline policy: LF ("\n") everywhere. CR-LF and lone CR in DB
 * content are normalized so exports do not drift per authoring platform.
 * A stray BOM is stripped; everything else (Thai, emoji, whitespace) is
 * preserved byte-for-byte as UTF-8.
 */
export function normalizeExportText(content: string): string {
  let text = String(content ?? "");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return text.replace(/\r\n?/g, "\n");
}

/**
 * Flatten a string to a single line for manifest cells (see module comment:
 * the existing CSV parser is line-oriented). Deterministic: CRLF/CR/LF and
 * tabs collapse to a single space, like the importer's own .trim() contract
 * trims the edges of every cell.
 */
export function flattenExportManifestField(value: string | null | undefined): string {
  return String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .trim();
}

// ============ Canonical episode identity & ordering ============

export interface ExportEpisodeIdentity {
  kind: "single" | "range";
  start: number;
  end: number;
}

/**
 * Parse an episodeNumber into a comparable numeric identity WITHOUT
 * parseInt-ing the raw string. Uses the same token extraction rule as
 * `normalizeEpisodeRange` (first and last numeric token) so "001-050",
 * "1 - 50", "#1-50" are equivalent. Returns null for strings with no
 * numeric token - callers must fail-safe (report) instead of guessing.
 */
export function parseExportEpisodeIdentity(episodeNumber: string): ExportEpisodeIdentity | null {
  const numbers = String(episodeNumber ?? "").match(/\d+(?:\.\d+)?/g);
  if (!numbers || numbers.length === 0) return null;

  const start = Number(numbers[0]);
  const end = Number(numbers[numbers.length - 1]);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;

  return numbers.length === 1 ? { kind: "single", start, end: start } : { kind: "range", start, end };
}

/**
 * Deterministic canonical ordering, matching the expected export sequence
 * 1, 2, 3, ... 10 ... 001-050, 051-100, 101-150: single episodes first
 * (ascending), then range/pack identities (ascending by start, then end),
 * then episodeId as the final tiebreak (only for rows with identical
 * identity spellings, e.g. duplicate "1" vs "001" rows the DB unique key
 * allows). Never uses DB insertion order, tabOrder, lexical string sort
 * or titles.
 */
export function compareExportItemsCanonical(a: NovelExportItem, b: NovelExportItem): number {
  const identityA = parseExportEpisodeIdentity(a.episodeNumber);
  const identityB = parseExportEpisodeIdentity(b.episodeNumber);

  if (!identityA && !identityB) return a.episodeId - b.episodeId;
  if (!identityA) return 1; // unparseable identities sort last, never silently interleaved
  if (!identityB) return -1;

  const kindRankA = identityA.kind === "single" ? 0 : 1;
  const kindRankB = identityB.kind === "single" ? 0 : 1;
  if (kindRankA !== kindRankB) return kindRankA - kindRankB;
  if (identityA.start !== identityB.start) return identityA.start - identityB.start;
  if (identityA.end !== identityB.end) return identityA.end - identityB.end;
  return a.episodeId - b.episodeId;
}

export function sortExportItemsCanonical(items: NovelExportItem[]): NovelExportItem[] {
  return [...items].sort(compareExportItemsCanonical);
}

// ============ Filename / path safety ============

const WINDOWS_INVALID_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;
const WINDOWS_RESERVED_NAMES = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
]);

/** Maximum characters kept in a sanitized filename component (before ext). */
export const MAX_EXPORT_FILENAME_COMPONENT_CHARS = 80;
/** Deterministic fallback when a component sanitizes to nothing. */
export const EXPORT_FILENAME_FALLBACK = "export";

/**
 * Sanitize one filename component (never a multi-segment path) for
 * Windows-safe, deterministic use in ZIP entry names and download
 * filenames. Thai/Unicode characters that are safe are preserved readable.
 */
export function sanitizeExportFilenameComponent(raw: string, fallback: string = EXPORT_FILENAME_FALLBACK): string {
  let name = String(raw ?? "");

  // Strip any path structure the caller may have smuggled in: only the
  // final segment survives, so "..", "a/b", "C:foo" can never traverse.
  name = name.split(/[\\/]/).pop() ?? "";

  name = name
    .replace(WINDOWS_INVALID_CHARS, " ")
    .replace(/[\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    // Trailing dots/spaces are illegal or ignored on Windows.
    .replace(/[. ]+$/g, "");

  if (name.length > MAX_EXPORT_FILENAME_COMPONENT_CHARS) {
    name = name.slice(0, MAX_EXPORT_FILENAME_COMPONENT_CHARS).replace(/[. ]+$/g, "");
  }

  if (!name) return fallback;

  if (WINDOWS_RESERVED_NAMES.has(name.toUpperCase())) {
    return `_${name}`;
  }

  return name;
}

/**
 * Zero-pad an episode number for filenames: minimum width 3, no truncation
 * ("001", "010", "1000"). Ranges join start and end with "-".
 */
function padExportNumber(n: number): string {
  return String(Math.trunc(n)).padStart(3, "0");
}

function exportIdentityStem(identity: ExportEpisodeIdentity): string {
  return identity.kind === "single"
    ? padExportNumber(identity.start)
    : `${padExportNumber(identity.start)}-${padExportNumber(identity.end)}`;
}

/**
 * Deterministic content filename for one item: identity-based stem
 * ("001", "001-050") + ".txt". Collisions after identity normalization
 * (e.g. episodes "1" and "001" in one novel, which the DB unique key on
 * raw episodeNumber allows) get a stable `__ep<episodeId>` suffix - never
 * a silent overwrite, never randomness.
 */
export function resolveExportContentFilename(item: NovelExportItem, usedNames: Set<string>): string {
  const identity = parseExportEpisodeIdentity(item.episodeNumber);
  const stem = identity ? exportIdentityStem(identity) : `episode-${item.episodeId}`;
  let filename = `${stem}.txt`;

  if (usedNames.has(filename.toLowerCase())) {
    filename = `${stem}__ep${item.episodeId}.txt`;
  }
  if (usedNames.has(filename.toLowerCase())) {
    throw new NovelExportError(
      "EXPORT_UNSAFE_PATH",
      `ชื่อไฟล์เนื้อหาซ้ำกันหลัง sanitize (episodeId ${item.episodeId})`
    );
  }

  usedNames.add(filename.toLowerCase());
  return filename;
}

// ============ Manifest rows & CSV serialization ============

export interface ExportManifestRow {
  episodeNumber: string;
  episodeTitle: string;
  price: string;
  isFree: boolean;
  isPublished: boolean;
  saleMode: ExportSaleMode;
  contentFile: string;
  contentFormat: ExportContentFormat;
  sortOrder: number | null;
  description: string | null;
}

/**
 * Build manifest rows in canonical order; `contentFile` paths are the exact
 * ZIP entry names generated for the same package, so the importer's
 * contentFile lookup always resolves.
 */
export function buildExportManifestRows(pkg: NovelExportPackage): ExportManifestRow[] {
  const usedNames = new Set<string>();
  const sorted = sortExportItemsCanonical(pkg.items);

  return sorted.map((item) => ({
    episodeNumber: item.episodeNumber,
    episodeTitle: flattenExportManifestField(item.episodeTitle),
    price: item.price,
    isFree: item.isFree,
    isPublished: true,
    saleMode: item.saleMode,
    contentFile: `${EXPORT_CONTENTS_DIR}/${resolveExportContentFilename(item, usedNames)}`,
    contentFormat: item.contentFormat,
    sortOrder: item.sortOrder,
    description: item.description ? flattenExportManifestField(item.description) : "",
  }));
}

/**
 * RFC-4180-style CSV cell quoting: quote when the cell contains a comma,
 * double quote, CR or LF; embedded quotes doubled. (Cells are pre-flattened
 * by `buildExportManifestRows`, so LF never occurs - the quoting still
 * covers it for safety.)
 */
export function serializeExportCsvCell(value: string): string {
  const text = String(value ?? "");
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/**
 * Serialize the manifest as UTF-8 (no BOM) with LF line endings - the
 * encoding/line policy the existing importer reads deterministically
 * (it strips an optional BOM and splits on "\n").
 */
export function serializeExportManifestCsv(rows: ExportManifestRow[]): string {
  const lines: string[] = [
    EXPORT_MANIFEST_HEADERS.join(","),
    ...rows.map((row) =>
      [
        serializeExportCsvCell(row.episodeNumber),
        serializeExportCsvCell(row.episodeTitle),
        serializeExportCsvCell(row.price),
        serializeExportCsvCell(row.isFree ? "true" : "false"),
        serializeExportCsvCell(row.isPublished ? "true" : "false"),
        serializeExportCsvCell(row.saleMode),
        serializeExportCsvCell(row.contentFile),
        serializeExportCsvCell(row.contentFormat),
        serializeExportCsvCell(row.sortOrder === null || row.sortOrder === undefined ? "" : String(row.sortOrder)),
        serializeExportCsvCell(row.description ?? ""),
      ].join(",")
    ),
  ];
  return `${lines.join("\n")}\n`;
}

// ============ Package validation ============

/** Aggregate-byte/bounds validation shared by TXT and ZIP paths. */
export function validateExportPackage(pkg: NovelExportPackage): void {
  if (pkg.items.length === 0) {
    throw new NovelExportError(
      "EXPORT_EMPTY_SELECTION",
      "ไม่มีตอนที่เผยแพร่และมีเนื้อหาให้ export"
    );
  }

  if (pkg.items.length > MAX_EXPORT_ITEMS) {
    throw new NovelExportError(
      "EXPORT_LIMIT_ITEMS",
      `จำนวนตอนต่อการ export เกินกำหนด (${pkg.items.length} > ${MAX_EXPORT_ITEMS})`,
      { itemCount: pkg.items.length, maxItems: MAX_EXPORT_ITEMS }
    );
  }

  let totalBytes = 0;
  for (const item of pkg.items) {
    const identity = parseExportEpisodeIdentity(item.episodeNumber);
    if (!identity) {
      throw new NovelExportError(
        "EXPORT_INVALID_EPISODE_IDENTITY",
        `episodeNumber ไม่มีเลขตอนที่อ่านได้ (episodeId ${item.episodeId})`,
        { episodeId: item.episodeId }
      );
    }

    if (!item.isFree && !(Number(item.price) > 0)) {
      throw new NovelExportError(
        "EXPORT_INVALID_SALE_METADATA",
        `ตอนที่ไม่ฟรีต้องมีราคามากกว่า 0 (episodeId ${item.episodeId})`,
        { episodeId: item.episodeId }
      );
    }

    const bytes = Buffer.byteLength(normalizeExportText(item.content), "utf8");
    if (bytes > MAX_EXPORT_PER_ITEM_BYTES) {
      throw new NovelExportError(
        "EXPORT_LIMIT_ENTRY_BYTES",
        `เนื้อหาตอนใหญ่เกินกำหนด (episodeId ${item.episodeId}, ${bytes} bytes > ${MAX_EXPORT_PER_ITEM_BYTES})`,
        { episodeId: item.episodeId, entryBytes: bytes, maxEntryBytes: MAX_EXPORT_PER_ITEM_BYTES }
      );
    }
    totalBytes += bytes;
  }

  if (totalBytes > MAX_EXPORT_TOTAL_BYTES) {
    throw new NovelExportError(
      "EXPORT_LIMIT_TOTAL_BYTES",
      `ขนาดเนื้อหารวมเกินกำหนด (${totalBytes} bytes > ${MAX_EXPORT_TOTAL_BYTES})`,
      { totalBytes, maxTotalBytes: MAX_EXPORT_TOTAL_BYTES }
    );
  }
}

// ============ TXT serialization ============

export interface SerializedTxtExport {
  filename: string;
  mimeType: "text/plain; charset=utf-8";
  content: Buffer;
}

/**
 * Single-item TXT export. Uses the exact same normalization as the ZIP
 * content entry serializer so the two never drift. UTF-8, no BOM.
 */
export function serializeNovelExportTxt(item: NovelExportItem): SerializedTxtExport {
  const usedNames = new Set<string>();
  const filename = resolveExportContentFilename(item, usedNames);
  return {
    filename,
    mimeType: "text/plain; charset=utf-8",
    content: Buffer.from(normalizeExportText(item.content), "utf8"),
  };
}

// ============ ZIP serialization ============

export interface SerializedZipExport {
  filename: string;
  mimeType: "application/zip";
  content: Buffer;
  manifestCsv: string;
  entryFilenames: string[];
  itemCount: number;
  totalPlaintextBytes: number;
}

function buildExportZipFilename(novelTitle: string, novelId: number): string {
  return `${sanitizeExportFilenameComponent(novelTitle, `novel-${novelId}`)}.zip`;
}

/**
 * Build the import-compatible ZIP: `manifest.csv` at the package root plus
 * one sanitized `contents/*.txt` entry per item, in canonical order.
 *
 * Determinism: entry order is canonical, all bytes are pure functions of
 * the input, and every entry's timestamp is overwritten with
 * FIXED_ZIP_TIMESTAMP - so the same input produces byte-identical output
 * (verified by test). No current time, randomness or DB order is involved.
 */
export function buildNovelExportZip(pkg: NovelExportPackage): SerializedZipExport {
  validateExportPackage(pkg);

  const zip = new AdmZip();

  const rows = buildExportManifestRows(pkg);
  const manifestCsv = serializeExportManifestCsv(rows);

  const seenEntryPaths = new Set<string>();
  const addEntry = (entryName: string, data: Buffer) => {
    // Defense in depth: even though every name is built here from
    // sanitized components, refuse any unsafe/duplicate final path.
    if (!entryName || entryName.includes("\0") || entryName.startsWith("/") || entryName.split("/").includes("..")) {
      throw new NovelExportError("EXPORT_UNSAFE_PATH", `พบ path ที่ไม่ปลอดภัยใน zip ที่จะสร้าง: "${entryName}"`);
    }
    const pathKey = entryName.toLowerCase();
    if (seenEntryPaths.has(pathKey)) {
      throw new NovelExportError("EXPORT_UNSAFE_PATH", `พบ entry path ซ้ำใน zip ที่จะสร้าง: "${entryName}"`);
    }
    seenEntryPaths.add(pathKey);
    zip.addFile(entryName, data);
  };

  addEntry(EXPORT_MANIFEST_FILENAME, Buffer.from(manifestCsv, "utf8"));

  const usedNames = new Set<string>();
  let totalPlaintextBytes = 0;
  for (const item of sortExportItemsCanonical(pkg.items)) {
    const entryName = `${EXPORT_CONTENTS_DIR}/${resolveExportContentFilename(item, usedNames)}`;
    const content = Buffer.from(normalizeExportText(item.content), "utf8");
    totalPlaintextBytes += content.length;
    addEntry(entryName, content);
  }

  // Overwrite adm-zip's current-time default with a fixed timestamp so the
  // archive is byte-reproducible. adm-zip 0.5.x exposes the DOS time field
  // via entry.header.time; if a future version drops it we still stay
  // manifest/order/bytes-deterministic, just not binary-identical.
  for (const entry of zip.getEntries()) {
    entry.header.time = FIXED_ZIP_TIMESTAMP;
  }

  const content = zip.toBuffer();
  // adm-zip physically stores entries in lexicographic entry-name order
  // (deterministic); report the actual archive order, not insertion order.
  const entryFilenames = zip.getEntries().map((entry) => entry.entryName);
  if (content.length > MAX_EXPORT_ZIP_BYTES) {
    throw new NovelExportError(
      "EXPORT_LIMIT_ZIP_BYTES",
      `ไฟล์ zip ที่สร้างใหญ่เกินกำหนด (${content.length} bytes > ${MAX_EXPORT_ZIP_BYTES})`,
      { zipBytes: content.length, maxZipBytes: MAX_EXPORT_ZIP_BYTES }
    );
  }

  return {
    filename: buildExportZipFilename(pkg.novelTitle, pkg.novelId),
    mimeType: "application/zip",
    content,
    manifestCsv,
    entryFilenames,
    itemCount: pkg.items.length,
    totalPlaintextBytes,
  };
}
