import AdmZip from "adm-zip";
import * as XLSX from "xlsx";
import * as db from "../db";
import { normalizeEpisodeRange } from "./readerService";

// ============ LIMITS (configurable via env, sane defaults) ============
// Note: the express JSON body limit (server/_core/index.ts) is 50mb, and the
// zip travels as a base64 string (~33% larger than raw bytes) inside that
// JSON body - keep MAX_ZIP_SIZE_BYTES comfortably under ~37MB raw to avoid
// hitting the body parser limit before our own check even runs.
export const MAX_ZIP_SIZE_BYTES = Number(process.env.PACKAGE_IMPORT_MAX_ZIP_MB || 30) * 1024 * 1024;
export const MAX_TXT_SIZE_BYTES = Number(process.env.PACKAGE_IMPORT_MAX_TXT_MB || 8) * 1024 * 1024;

const ALLOWED_CONTENT_FORMATS = new Set(["plain_text", "markdown", "html"]);

const SALE_MODE_VALUE_ALIASES: Record<string, "chapter" | "package"> = {
  chapter: "chapter",
  "รายบท": "chapter",
  package: "package",
  "แพ็ก": "package",
  "แพ็กอ่านบนเว็บ": "package",
};

// Manifest header aliases (English and Thai), mirrors the client-side XLSX
// importer's convention so admins can reuse familiar column names.
const HEADER_ALIASES: Record<string, string> = {
  episodenumber: "episodeNumber",
  episode_number: "episodeNumber",
  episodeno: "episodeNumber",
  "ตอนที่": "episodeNumber",

  episodetitle: "episodeTitle",
  title: "episodeTitle",
  episode_title: "episodeTitle",
  "ชื่อตอน": "episodeTitle",

  price: "price",
  "ราคา": "price",

  isfree: "isFree",
  "ฟรี": "isFree",

  ispublished: "isPublished",
  "เผยแพร่": "isPublished",

  salemode: "saleMode",
  sale_mode: "saleMode",
  "ประเภทการขาย": "saleMode",
  "ประเภท": "saleMode",

  contentfile: "contentFile",
  content_file: "contentFile",
  "ไฟล์เนื้อหา": "contentFile",

  contentformat: "contentFormat",
  "รูปแบบเนื้อหา": "contentFormat",

  sortorder: "sortOrder",
  "ลำดับ": "sortOrder",

  description: "description",
  "คำอธิบาย": "description",
};

function normalizeHeader(header: string): string {
  const cleaned = header.toLowerCase().trim();
  return HEADER_ALIASES[cleaned] || cleaned;
}

function parseBoolean(value: unknown, defaultValue: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (value === null || value === undefined || value === "") return defaultValue;

  const str = String(value).toLowerCase().trim();
  return ["true", "yes", "y", "1", "ฟรี", "เผยแพร่", "published", "enable", "enabled"].includes(str);
}

/**
 * Reject any zip entry path that could escape the extraction target
 * ("zip slip"): parent-directory segments, absolute paths (unix or Windows
 * drive-letter), or embedded null bytes. Returns the normalized
 * forward-slash path, or null if the entry must be rejected.
 */
function sanitizeZipEntryPath(rawPath: string): string | null {
  if (!rawPath || rawPath.includes("\0")) return null;

  const normalized = rawPath.replace(/\\/g, "/");
  if (normalized.startsWith("/")) return null;
  if (/^[a-zA-Z]:/.test(normalized)) return null;

  const parts = normalized.split("/");
  if (parts.some((part) => part === "..")) return null;

  return normalized;
}

function basename(p: string): string {
  const parts = p.split("/");
  return parts[parts.length - 1] || "";
}

function extname(p: string): string {
  const base = basename(p);
  const dotIndex = base.lastIndexOf(".");
  return dotIndex === -1 ? "" : base.slice(dotIndex).toLowerCase();
}

export interface PackageImportRow {
  row: number;
  episodeNumber: string;
  episodeTitle: string;
  price: string;
  isFree: boolean;
  isPublished: boolean;
  saleMode: "package";
  contentFile: string;
  contentFormat: "plain_text" | "markdown" | "html";
  sortOrder?: number;
  description?: string;
  content: string;
  contentLength: number;
}

export interface PackageImportRowError {
  row: number;
  field: string;
  message: string;
  /** Machine-readable error code, set only for a few well-known cases the
   *  preview/summary needs to bucket precisely (e.g. missing content file,
   *  duplicate range within the same zip). Undefined for generic validation
   *  errors - those are still human-readable via `message`. */
  code?: "MISSING_CONTENT_FILE" | "DUPLICATE_IN_BATCH";
  /** Raw (pre-validation) episodeNumber/episodeTitle values, when available
   *  at the point the error was raised - lets the preview table show what
   *  the admin actually typed even for rows that never became a full
   *  PackageImportRow. */
  episodeNumberRaw?: string;
  episodeTitleRaw?: string;
}

export interface PackageImportParseResult {
  manifestFileName: string;
  rows: PackageImportRow[];
  errors: PackageImportRowError[];
}

/**
 * Extract and validate a package-import ZIP: locate the manifest
 * (manifest.xlsx or manifest.csv), read every referenced .txt content file,
 * and return fully-validated rows ready to insert/update - or a list of
 * per-row errors. Never touches the database; used for both dry-run preview
 * and as the first step of a real import.
 *
 * Security:
 * - Every zip entry path is sanitized against zip-slip (path traversal).
 * - Only .txt, .xlsx, .csv extensions are ever read; everything else in the
 *   zip is ignored.
 * - Per-file and total zip size are capped (MAX_ZIP_SIZE_BYTES / MAX_TXT_SIZE_BYTES).
 * - fileUrl is never read from the manifest and never written - packages are
 *   web-read only.
 */
export function parsePackageZip(zipBuffer: Buffer): PackageImportParseResult {
  if (zipBuffer.length > MAX_ZIP_SIZE_BYTES) {
    throw new Error(
      `ไฟล์ zip ใหญ่เกินไป (${(zipBuffer.length / 1024 / 1024).toFixed(1)}MB) จำกัดไว้ที่ ${(MAX_ZIP_SIZE_BYTES / 1024 / 1024).toFixed(0)}MB`
    );
  }

  let zip: AdmZip;
  try {
    zip = new AdmZip(zipBuffer);
  } catch (error) {
    throw new Error("ไม่สามารถเปิดไฟล์ zip ได้ กรุณาตรวจสอบว่าไฟล์ไม่เสียหาย");
  }

  const entries = zip.getEntries();

  // Map of sanitized path -> entry, for .txt/.xlsx/.csv files only. Any
  // entry whose path fails sanitization is a zip-slip attempt - reject the
  // whole archive rather than silently skipping it.
  const fileEntries = new Map<string, AdmZip.IZipEntry>();

  for (const entry of entries) {
    if (entry.isDirectory) continue;

    const sanitized = sanitizeZipEntryPath(entry.entryName);
    if (sanitized === null) {
      throw new Error(`พบ path ที่ไม่ปลอดภัยใน zip: "${entry.entryName}"`);
    }

    const ext = extname(sanitized);
    if (ext !== ".txt" && ext !== ".xlsx" && ext !== ".csv") {
      // Ignore unrelated files (e.g. .DS_Store, folder metadata) rather than
      // failing the whole import - only .txt/.xlsx/.csv are ever read.
      continue;
    }

    fileEntries.set(sanitized, entry);
  }

  // Locate manifest.xlsx or manifest.csv (case-insensitive basename match,
  // any folder depth - but the documented convention is zip root).
  let manifestPath: string | null = null;
  let manifestExt: "xlsx" | "csv" | null = null;
  for (const path of Array.from(fileEntries.keys())) {
    const base = basename(path).toLowerCase();
    if (base === "manifest.xlsx" || base === "manifest.csv") {
      manifestPath = path;
      manifestExt = base.endsWith(".xlsx") ? "xlsx" : "csv";
      break;
    }
  }

  if (!manifestPath || !manifestExt) {
    throw new Error("ไม่พบ manifest.xlsx หรือ manifest.csv ใน zip");
  }

  const manifestEntry = fileEntries.get(manifestPath)!;
  const manifestBuffer = manifestEntry.getData();

  const rawRows = manifestExt === "xlsx" ? parseXlsxManifest(manifestBuffer) : parseCsvManifest(manifestBuffer);

  const rows: PackageImportRow[] = [];
  const errors: PackageImportRowError[] = [];
  const seenNumbers = new Set<string>();

  for (let i = 0; i < rawRows.length; i++) {
    const rowNum = i + 2; // +1 header, +1 for 1-based
    const data = rawRows[i];

    const episodeNumber = (data.episodeNumber || "").trim();
    const episodeTitle = (data.episodeTitle || "").trim();
    const contentFileRaw = (data.contentFile || "").trim();
    const isFree = parseBoolean(data.isFree, false);
    const isPublished = parseBoolean(data.isPublished, true);
    const priceStr = data.price || "0";
    const description = (data.description || "").trim();

    if (!episodeNumber) {
      errors.push({ row: rowNum, field: "episodeNumber", message: "ต้องระบุ episodeNumber", episodeNumberRaw: episodeNumber, episodeTitleRaw: episodeTitle });
      continue;
    }
    if (!episodeTitle) {
      errors.push({ row: rowNum, field: "episodeTitle", message: "ต้องระบุ episodeTitle", episodeNumberRaw: episodeNumber, episodeTitleRaw: episodeTitle });
      continue;
    }
    const normalizedEpisodeNumber = normalizeEpisodeRange(episodeNumber);
    if (seenNumbers.has(normalizedEpisodeNumber)) {
      errors.push({
        row: rowNum,
        field: "episodeNumber",
        message: `episodeNumber "${episodeNumber}" ซ้ำในไฟล์เดียวกัน (normalized: "${normalizedEpisodeNumber}")`,
        code: "DUPLICATE_IN_BATCH",
        episodeNumberRaw: episodeNumber,
        episodeTitleRaw: episodeTitle,
      });
      continue;
    }

    // This import path is package-only. If saleMode is provided and resolves
    // to "chapter", reject the row rather than silently importing a single
    // chapter through the bulk package flow.
    const saleModeRaw = (data.saleMode || "").toLowerCase().trim();
    const resolvedSaleMode = saleModeRaw ? SALE_MODE_VALUE_ALIASES[saleModeRaw] : "package";
    if (resolvedSaleMode !== "package") {
      errors.push({
        row: rowNum,
        field: "saleMode",
        message: `Import นี้รองรับเฉพาะ saleMode = package เท่านั้น (พบค่า "${data.saleMode}")`,
        episodeNumberRaw: episodeNumber,
        episodeTitleRaw: episodeTitle,
      });
      continue;
    }

    const price = isNaN(parseFloat(priceStr)) ? "0" : priceStr;
    if (!isFree && (!price || parseFloat(price) <= 0)) {
      errors.push({ row: rowNum, field: "price", message: "แพ็กที่ไม่ฟรีต้องมีราคามากกว่า 0", episodeNumberRaw: episodeNumber, episodeTitleRaw: episodeTitle });
      continue;
    }

    if (!contentFileRaw) {
      errors.push({
        row: rowNum,
        field: "contentFile",
        message: "ต้องระบุ contentFile",
        code: "MISSING_CONTENT_FILE",
        episodeNumberRaw: episodeNumber,
        episodeTitleRaw: episodeTitle,
      });
      continue;
    }
    if (extname(contentFileRaw) !== ".txt") {
      errors.push({
        row: rowNum,
        field: "contentFile",
        message: `contentFile ต้องเป็นไฟล์ .txt เท่านั้น (พบ "${contentFileRaw}")`,
        episodeNumberRaw: episodeNumber,
        episodeTitleRaw: episodeTitle,
      });
      continue;
    }

    const sanitizedContentFile = sanitizeZipEntryPath(contentFileRaw);
    const contentEntry = sanitizedContentFile ? fileEntries.get(sanitizedContentFile) : undefined;
    if (!sanitizedContentFile || !contentEntry) {
      errors.push({
        row: rowNum,
        field: "contentFile",
        message: `ไม่พบไฟล์ "${contentFileRaw}" ใน zip`,
        code: "MISSING_CONTENT_FILE",
        episodeNumberRaw: episodeNumber,
        episodeTitleRaw: episodeTitle,
      });
      continue;
    }

    const rawContentBuffer = contentEntry.getData();
    if (rawContentBuffer.length > MAX_TXT_SIZE_BYTES) {
      errors.push({
        row: rowNum,
        field: "contentFile",
        message: `ไฟล์ "${contentFileRaw}" ใหญ่เกินไป (${(rawContentBuffer.length / 1024 / 1024).toFixed(1)}MB) จำกัดไว้ที่ ${(MAX_TXT_SIZE_BYTES / 1024 / 1024).toFixed(0)}MB`,
        episodeNumberRaw: episodeNumber,
        episodeTitleRaw: episodeTitle,
      });
      continue;
    }

    // Decode as UTF-8 and strip a leading BOM if present. Interior line
    // breaks are preserved exactly as authored in the .txt file.
    let content = rawContentBuffer.toString("utf-8");
    if (content.charCodeAt(0) === 0xfeff) {
      content = content.slice(1);
    }

    if (!content.trim()) {
      errors.push({
        row: rowNum,
        field: "contentFile",
        message: `ไฟล์ "${contentFileRaw}" ไม่มีเนื้อหา`,
        code: "MISSING_CONTENT_FILE",
        episodeNumberRaw: episodeNumber,
        episodeTitleRaw: episodeTitle,
      });
      continue;
    }

    const contentFormatRaw = (data.contentFormat || "").toLowerCase().trim();
    const contentFormat = (ALLOWED_CONTENT_FORMATS.has(contentFormatRaw) ? contentFormatRaw : "plain_text") as
      | "plain_text"
      | "markdown"
      | "html";

    let sortOrder: number | undefined;
    const sortOrderStr = (data.sortOrder || "").trim();
    if (sortOrderStr) {
      const parsed = parseInt(sortOrderStr, 10);
      if (!isNaN(parsed)) sortOrder = parsed;
    } else {
      const numericMatch = episodeNumber.match(/\d+/);
      if (numericMatch) {
        const parsed = parseInt(numericMatch[0], 10);
        if (!isNaN(parsed)) sortOrder = parsed;
      }
    }

    seenNumbers.add(normalizedEpisodeNumber);
    rows.push({
      row: rowNum,
      episodeNumber,
      episodeTitle,
      price,
      isFree,
      isPublished,
      saleMode: "package",
      contentFile: contentFileRaw,
      contentFormat,
      sortOrder,
      description: description || undefined,
      content,
      contentLength: content.length,
    });
  }

  return { manifestFileName: basename(manifestPath), rows, errors };
}

function parseXlsxManifest(buffer: Buffer): Array<Record<string, string>> {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) {
    throw new Error("manifest.xlsx ไม่มีชีตข้อมูล");
  }

  const worksheet = workbook.Sheets[firstSheetName];
  const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1, blankrows: false }) as (
    | string
    | number
    | boolean
  )[][];

  if (jsonData.length < 2) {
    throw new Error("manifest.xlsx ต้องมี header และอย่างน้อย 1 แถวข้อมูล");
  }

  const headerRow = jsonData[0].map((h) => normalizeHeader(String(h ?? "")));
  const result: Array<Record<string, string>> = [];

  for (let i = 1; i < jsonData.length; i++) {
    const rowData = jsonData[i];
    const row: Record<string, string> = {};
    for (let j = 0; j < headerRow.length; j++) {
      if (headerRow[j] && rowData[j] != null && rowData[j] !== "") {
        row[headerRow[j]] = String(rowData[j]);
      }
    }
    if (Object.keys(row).length > 0) result.push(row);
  }

  return result;
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const nextChar = line[i + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }

  result.push(current.trim());
  return result;
}

function parseCsvManifest(buffer: Buffer): Array<Record<string, string>> {
  let text = buffer.toString("utf-8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const lines = text.split("\n").filter((line) => line.trim());
  if (lines.length < 2) {
    throw new Error("manifest.csv ต้องมี header และอย่างน้อย 1 แถวข้อมูล");
  }

  const headerLine = parseCsvLine(lines[0]);
  const normalizedHeaders = headerLine.map(normalizeHeader);

  const result: Array<Record<string, string>> = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const row: Record<string, string> = {};
    for (let j = 0; j < normalizedHeaders.length; j++) {
      if (normalizedHeaders[j] && cols[j]) {
        row[normalizedHeaders[j]] = cols[j];
      }
    }
    if (Object.keys(row).length > 0) result.push(row);
  }

  return result;
}

export interface PackageImportRowResult {
  row: number;
  episodeNumber: string;
  action: "created" | "updated";
  episodeId: number;
  preservedFileUrl: boolean;
  message: string;
}

export interface PackageImportSummary {
  manifestFileName: string;
  totalRows: number;
  successCount: number;
  errorCount: number;
  createdCount: number;
  updatedCount: number;
  preservedFileUrlCount: number;
  errors: PackageImportRowError[];
  results: PackageImportRowResult[];
}

/**
 * Find every existing episode in a novel whose normalized episodeNumber
 * matches the given (already-normalized) range. Matching considers all
 * existing episodes, not just saleMode="package" ones, since legacy
 * file-only packages predate the saleMode column and must still be found
 * by a plaintext-content import so they get synced instead of duplicated.
 */
function findMatchingExistingEpisodes(existingEpisodes: any[], normalizedTarget: string): any[] {
  return existingEpisodes.filter((e: any) => normalizeEpisodeRange(e.episodeNumber) === normalizedTarget);
}

function isValidNormalizedRange(normalized: string): boolean {
  return normalized.length > 0 && /\d/.test(normalized);
}

interface RowClassification {
  action: "update_existing" | "create_new" | "error_ambiguous_match" | "error_invalid_range";
  matchedEpisode: any | null;
  ambiguousMatches: any[];
  normalizedRange: string;
  message: string;
}

/**
 * Classify a single parsed row against a novel's existing episodes - the one
 * function both the dry-run preview (buildImportPreview) and the real write
 * path (importPackageRows) call, so the preview can never show something
 * different from what actually happens on import.
 *
 * Matching is done via normalizeEpisodeRange() rather than raw string
 * equality, so "51-100", "51 - 100", "051 - 100" etc. are all recognized as
 * the same package. If more than one existing episode normalizes to the same
 * range, the row is classified as an ambiguous match rather than guessed -
 * callers must block the write and report it for manual admin review.
 */
function classifyImportRow(existingEpisodes: any[], row: PackageImportRow): RowClassification {
  const normalizedRange = normalizeEpisodeRange(row.episodeNumber);

  if (!isValidNormalizedRange(normalizedRange)) {
    return {
      action: "error_invalid_range",
      matchedEpisode: null,
      ambiguousMatches: [],
      normalizedRange,
      message: `episodeNumber "${row.episodeNumber}" ไม่สามารถแปลงเป็นเลขตอน/ช่วงที่ถูกต้องได้`,
    };
  }

  const matches = findMatchingExistingEpisodes(existingEpisodes, normalizedRange);

  if (matches.length > 1) {
    return {
      action: "error_ambiguous_match",
      matchedEpisode: null,
      ambiguousMatches: matches,
      normalizedRange,
      message: `episodeNumber "${row.episodeNumber}" ตรงกับตอนที่มีอยู่แล้วมากกว่า 1 รายการ (episodeId: ${matches.map((m: any) => m.id).join(", ")}) กรุณาตรวจสอบและแก้ไขด้วยตนเอง`,
    };
  }

  if (matches.length === 1) {
    return {
      action: "update_existing",
      matchedEpisode: matches[0],
      ambiguousMatches: [],
      normalizedRange,
      message: `${row.episodeNumber}: จะอัปเดต episodeId ${matches[0].id}`,
    };
  }

  return {
    action: "create_new",
    matchedEpisode: null,
    ambiguousMatches: [],
    normalizedRange,
    message: `${row.episodeNumber}: จะสร้างตอนใหม่`,
  };
}

/**
 * Import already-parsed, validated rows into a novel's episodes.
 *
 * mode "create_only": a normalized-duplicate episodeNumber is an error.
 * mode "upsert" (recommended default): a normalized-duplicate episodeNumber
 * updates the existing row in place, preserving its episodeId and any
 * legacy fileUrl - this is what keeps a customer's past Docs/PDF purchase
 * valid after the admin later syncs plaintext content into the same package.
 *
 * fileUrl is never written by this function - the update payload simply
 * omits the fileUrl key entirely, so Drizzle's partial `.set()` leaves any
 * existing legacy file link untouched. Never pass `fileUrl: null` here.
 */
export async function importPackageRows(
  novelId: number,
  rows: PackageImportRow[],
  mode: "create_only" | "upsert"
): Promise<PackageImportSummary> {
  const existingEpisodes = await db.getEpisodesByNovelId(novelId);
  const errors: PackageImportRowError[] = [];
  const results: PackageImportRowResult[] = [];
  let successCount = 0;
  let createdCount = 0;
  let updatedCount = 0;
  let preservedFileUrlCount = 0;

  for (const row of rows) {
    const classification = classifyImportRow(existingEpisodes, row);

    try {
      if (classification.action === "error_ambiguous_match" || classification.action === "error_invalid_range") {
        errors.push({ row: row.row, field: "episodeNumber", message: classification.message });
        continue;
      }

      if (classification.action === "update_existing") {
        const existing = classification.matchedEpisode;

        if (mode === "create_only") {
          errors.push({
            row: row.row,
            field: "episodeNumber",
            message: `episodeNumber "${row.episodeNumber}" มีอยู่แล้วในนิยายนี้ (episodeId ${existing.id}, โหมด create only)`,
          });
          continue;
        }

        const hadFileUrl = Boolean(existing.fileUrl && String(existing.fileUrl).trim().length > 0);

        // Never include `fileUrl` in this payload - omitting the key (not
        // setting it to null) is what preserves any existing legacy file
        // link during a plaintext sync.
        await db.updateEpisode(existing.id, {
          title: row.episodeTitle,
          price: row.price,
          isFree: row.isFree,
          isPublished: row.isPublished,
          saleMode: "package",
          content: row.content,
          contentFormat: row.contentFormat,
          description: row.description,
          sortOrder: row.sortOrder,
        });
        successCount++;
        updatedCount++;
        if (hadFileUrl) preservedFileUrlCount++;
        results.push({
          row: row.row,
          episodeNumber: row.episodeNumber,
          action: "updated",
          episodeId: existing.id,
          preservedFileUrl: hadFileUrl,
          message: hadFileUrl
            ? `${row.episodeNumber}: updated existing episodeId ${existing.id}, preserved legacy fileUrl`
            : `${row.episodeNumber}: updated existing episodeId ${existing.id}, added plaintext content`,
        });
        continue;
      }

      // action === "create_new"
      const created = await db.createEpisode({
        novelId,
        episodeNumber: row.episodeNumber,
        title: row.episodeTitle,
        price: row.price,
        isFree: row.isFree,
        isPublished: row.isPublished,
        saleMode: "package",
        content: row.content,
        contentFormat: row.contentFormat,
        description: row.description,
        sortOrder: row.sortOrder,
      });
      successCount++;
      createdCount++;
      results.push({
        row: row.row,
        episodeNumber: row.episodeNumber,
        action: "created",
        episodeId: created.id,
        preservedFileUrl: false,
        message: `${row.episodeNumber}: created new episodeId ${created.id}`,
      });
    } catch (error) {
      errors.push({
        row: row.row,
        field: "database",
        message: (error as Error).message || "Import row failed",
      });
    }
  }

  return {
    manifestFileName: "",
    totalRows: rows.length,
    successCount,
    errorCount: errors.length,
    createdCount,
    updatedCount,
    preservedFileUrlCount,
    errors,
    results,
  };
}

export type ImportRowAction =
  | "update_existing"
  | "create_new"
  | "error_ambiguous_match"
  | "error_invalid_range"
  | "error_existing_conflict"
  | "error_missing_content_file"
  | "error_duplicate_range"
  | "error_invalid_row";

export interface PackageImportPreviewRow {
  row: number;
  rawEpisodeNumber: string;
  normalizedRange: string | null;
  episodeTitle: string;
  matchedEpisodeId: number | null;
  currentFileUrlExists: boolean;
  incomingContentExists: boolean;
  action: ImportRowAction;
  preserveFileUrl: boolean;
  message: string;
}

export interface PackageImportPreviewSummary {
  totalRows: number;
  createCount: number;
  updateCount: number;
  errorCount: number;
  preservedFileUrlCount: number;
  duplicateRangeCount: number;
  ambiguousMatchCount: number;
  missingContentFileCount: number;
}

export interface PackageImportPreview {
  manifestFileName: string;
  mode: "create_only" | "upsert";
  rows: PackageImportPreviewRow[];
  summary: PackageImportPreviewSummary;
}

/**
 * Read-only dry-run diff: shows exactly what importPackageRows() would do,
 * without writing to the database. Built on the same classifyImportRow()
 * used by the real import, so this can never drift from actual behavior.
 *
 * Merges in parse-time errors (missing content file, duplicate range within
 * the same zip, etc.) alongside classify-time errors (ambiguous match,
 * invalid range) so the admin sees one unified table covering every row in
 * the manifest, sorted back into original row order.
 */
export async function buildImportPreview(
  novelId: number,
  parsed: PackageImportParseResult,
  mode: "create_only" | "upsert"
): Promise<PackageImportPreview> {
  const existingEpisodes = await db.getEpisodesByNovelId(novelId);
  const previewRows: PackageImportPreviewRow[] = [];

  for (const row of parsed.rows) {
    const classification = classifyImportRow(existingEpisodes, row);
    const currentFileUrlExists = Boolean(
      classification.matchedEpisode?.fileUrl && String(classification.matchedEpisode.fileUrl).trim().length > 0
    );
    const incomingContentExists = Boolean(row.content && row.content.trim().length > 0);

    let action: ImportRowAction = classification.action;
    let message = classification.message;
    let preserveFileUrl = false;

    if (classification.action === "update_existing" && mode === "create_only") {
      action = "error_existing_conflict";
      message = `episodeNumber "${row.episodeNumber}" มีอยู่แล้ว (episodeId ${classification.matchedEpisode.id}) - โหมด create only จะไม่ import แถวนี้ แนะนำสลับเป็น Sync/Upsert`;
    } else if (classification.action === "update_existing") {
      preserveFileUrl = currentFileUrlExists;
    }

    previewRows.push({
      row: row.row,
      rawEpisodeNumber: row.episodeNumber,
      normalizedRange: classification.normalizedRange || null,
      episodeTitle: row.episodeTitle,
      matchedEpisodeId: classification.matchedEpisode?.id ?? null,
      currentFileUrlExists,
      incomingContentExists,
      action,
      preserveFileUrl,
      message,
    });
  }

  for (const err of parsed.errors) {
    let action: ImportRowAction = "error_invalid_row";
    if (err.code === "MISSING_CONTENT_FILE") action = "error_missing_content_file";
    else if (err.code === "DUPLICATE_IN_BATCH") action = "error_duplicate_range";

    const rawEpisodeNumber = err.episodeNumberRaw ?? "";
    previewRows.push({
      row: err.row,
      rawEpisodeNumber,
      normalizedRange: rawEpisodeNumber ? normalizeEpisodeRange(rawEpisodeNumber) || null : null,
      episodeTitle: err.episodeTitleRaw ?? "",
      matchedEpisodeId: null,
      currentFileUrlExists: false,
      incomingContentExists: false,
      action,
      preserveFileUrl: false,
      message: err.message,
    });
  }

  previewRows.sort((a, b) => a.row - b.row);

  const summary: PackageImportPreviewSummary = {
    totalRows: previewRows.length,
    createCount: previewRows.filter((r) => r.action === "create_new").length,
    updateCount: previewRows.filter((r) => r.action === "update_existing").length,
    errorCount: previewRows.filter((r) => r.action.startsWith("error_")).length,
    preservedFileUrlCount: previewRows.filter((r) => r.preserveFileUrl).length,
    duplicateRangeCount: previewRows.filter((r) => r.action === "error_duplicate_range").length,
    ambiguousMatchCount: previewRows.filter((r) => r.action === "error_ambiguous_match").length,
    missingContentFileCount: previewRows.filter((r) => r.action === "error_missing_content_file").length,
  };

  return {
    manifestFileName: parsed.manifestFileName,
    mode,
    rows: previewRows,
    summary,
  };
}
