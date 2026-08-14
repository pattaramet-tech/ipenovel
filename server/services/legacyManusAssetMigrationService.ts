// Core logic for moving legacy Manus CloudFront-hosted assets onto
// Cloudflare R2:
//   A. payments.slipImageUrl / walletTopups.slipImageUrl -> PRIVATE R2
//      (r2p:<key> references, via r2PrivateStorage.ts - same bucket/
//      convention as newly-submitted slips)
//   B. sportsMatches.{homeTeamImageUrl,awayTeamImageUrl,coverImageUrl} ->
//      PUBLIC R2 (r2Storage.ts - same bucket/convention as novel covers/
//      banners)
//
// This is the single implementation shared by scripts/migrate-legacy-manus-
// assets-to-r2.ts (CLI). Only ever invoked explicitly by an operator - never
// wired into install/build/startup/deploy/db-migrate.
//
// Only a value whose hostname is EXACTLY the legacy Manus CloudFront
// hostname is ever migrated - not r2p: references, not media.ipenovel.com,
// not arbitrary external URLs, not relative/malformed values, and never a
// lookalike hostname (e.g. "<manus-host>.attacker.example"). See
// isMigratableManusCloudfrontUrl() below.
//
// Every row is its own safe unit: a row's DB column is only overwritten
// after ITS OWN download+validate+upload has already succeeded, and even
// then only via a compare-and-swap UPDATE that also requires the column to
// still hold the exact value read at candidate-discovery time (see
// updatePaymentSlipUrlIfUnchanged/updateWalletTopupSlipUrlIfUnchanged/
// updateSportsMatchImageUrlIfUnchanged in server/db.ts) - if the row changed
// or was deleted in the meantime, the write is skipped entirely rather than
// overwriting whatever is there now. A failed (or CAS-lost) row is left
// completely unchanged (and therefore safe to retry on the next run) and
// the legacy Manus source is never deleted by this service.
import { and, asc, gte, isNotNull, ne } from "drizzle-orm";
import {
  getDb,
  updatePaymentSlipUrlIfUnchanged,
  updateWalletTopupSlipUrlIfUnchanged,
  updateSportsMatchImageUrlIfUnchanged,
} from "../db";
import { payments, walletTopups, sportsMatches } from "../../drizzle/schema";
import {
  putPrivateObject,
  deletePrivateObject,
  isR2PrivateConfigured,
  R2PrivateStorageError,
  type PrivateObjectContext,
} from "./r2PrivateStorage";
import { r2Put, isR2Configured, R2StorageError } from "./r2Storage";
import { isPrivateObjectRef, toPrivateObjectRef } from "@shared/privateFileRef";
import { optimizeImageToWebp, ImageOptimizeError, SPORTS_MATCH_IMAGE_PRESET } from "./imageOptimizer";
import { ENV } from "../_core/env";

// ─── Legacy Manus hostname ──────────────────────────────────────────────────

/** The ONLY hostname this service will ever download from. Exact match
 *  only - never a prefix/suffix/substring check, so a lookalike hostname
 *  (e.g. this value followed by ".attacker.example") is never accepted. */
export const MANUS_CLOUDFRONT_HOSTNAME = "d2xsxph8kpxj0f.cloudfront.net";

/**
 * True only for an absolute https:// URL whose hostname is EXACTLY
 * MANUS_CLOUDFRONT_HOSTNAME. Rejects: http:// (not just https favored -
 * actually required), any other hostname, a hostname that merely contains
 * or is prefixed/suffixed by the Manus hostname, r2p: references (not a
 * recognized URL scheme), relative values, and anything that fails to parse
 * as a URL at all.
 */
export function isMigratableManusCloudfrontUrl(value: string | null | undefined): value is string {
  if (!value || typeof value !== "string") return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === "https:" && parsed.hostname.toLowerCase() === MANUS_CLOUDFRONT_HOSTNAME;
}

// ─── Already-migrated detection ─────────────────────────────────────────────

const KNOWN_PUBLIC_MEDIA_DOMAIN = "https://media.ipenovel.com";

function isAlreadyMigratedSlipValue(value: string): boolean {
  return isPrivateObjectRef(value);
}

/**
 * Safe origin+path-prefix comparison - deliberately NOT a raw
 * `value.startsWith(base)` string check, which would misclassify a
 * lookalike hostname like "https://media.ipenovel.com.attacker.example/x"
 * as already-migrated (it textually starts with the base string, but is a
 * completely different host). Both `value` and `base` are parsed as URLs;
 * protocol, hostname (case-insensitive), and port must match exactly, and
 * `base`'s own path (if any - e.g. a configured R2_PUBLIC_BASE_URL with a
 * subpath) must be a genuine path-SEGMENT prefix of `value`'s path, never a
 * bare string prefix (so a base path of "/media" matches "/media" or
 * "/media/x", never "/media-other/x").
 */
function isSameOriginAndPathPrefix(value: string, base: string): boolean {
  let parsedValue: URL;
  let parsedBase: URL;
  try {
    parsedValue = new URL(value);
    parsedBase = new URL(base);
  } catch {
    return false;
  }

  if (parsedValue.protocol !== parsedBase.protocol) return false;
  if (parsedValue.hostname.toLowerCase() !== parsedBase.hostname.toLowerCase()) return false;
  if (parsedValue.port !== parsedBase.port) return false;

  const basePath = parsedBase.pathname.replace(/\/+$/, "");
  if (!basePath || basePath === "/") return true;
  return parsedValue.pathname === basePath || parsedValue.pathname.startsWith(`${basePath}/`);
}

export function isAlreadyMigratedSportsValue(value: string): boolean {
  const bases = [ENV.r2PublicBaseUrl, KNOWN_PUBLIC_MEDIA_DOMAIN].filter((b): b is string => !!b);
  return bases.some((base) => isSameOriginAndPathPrefix(value, base));
}

// ─── Download hardening ─────────────────────────────────────────────────────

export type LegacyAssetDownloadFailureReason =
  | "HOSTNAME_MISMATCH"
  | "FETCH_FAILED"
  | "FETCH_TIMEOUT"
  | "NON_2XX_RESPONSE"
  | "TOO_LARGE"
  | "UNSUPPORTED_TYPE"
  | "EMPTY_BODY";

/** `.message` is always the fixed reason string only - never the source URL,
 *  a query string, or any upstream response detail. */
export class LegacyAssetDownloadError extends Error {
  constructor(public readonly reason: LegacyAssetDownloadFailureReason) {
    super(`Legacy asset download failed: ${reason}`);
    this.name = "LegacyAssetDownloadError";
  }
}

/** Strips `; charset=...` and any other parameters - never trusts a
 *  filename/extension, only this header. */
function normalizeContentType(rawContentType: string | null): string {
  if (!rawContentType) return "";
  return rawContentType.split(";")[0].trim().toLowerCase();
}

/** Best-effort teardown for a response being rejected WITHOUT reading its
 *  body - never throws. */
async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // intentionally ignored - best-effort only
  }
}

const MAGIC_BYTES: Record<string, Buffer> = {
  "image/jpeg": Buffer.from([0xff, 0xd8, 0xff]),
  "image/png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  "application/pdf": Buffer.from("%PDF-", "ascii"),
};

/** A lightweight second check beyond the declared Content-Type header - an
 *  obviously mislabeled payload (e.g. an HTML error page served with
 *  `content-type: image/png`) is rejected before it ever reaches R2. No rule
 *  exists for image/webp here - sports rows are always decoded by
 *  optimizeImageToWebp() afterward, which itself rejects anything
 *  undecodable. */
function matchesDeclaredContentType(buffer: Buffer, contentType: string): boolean {
  const magic = MAGIC_BYTES[contentType];
  if (!magic) return true;
  if (buffer.length < magic.length) return false;
  return buffer.subarray(0, magic.length).equals(magic);
}

/**
 * Reads the response body up to `maxBytes`, aborting (and canceling the
 * reader) as soon as the running total exceeds it - never accumulates an
 * unbounded stream in memory, and never relies on Content-Length alone.
 * Never falls back to an unbounded `response.arrayBuffer()` read.
 */
async function readBodyBounded(response: Response, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  if (!response.body) {
    throw new LegacyAssetDownloadError("EMPTY_BODY");
  }

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch {
    await cancelResponseBody(response);
    throw new LegacyAssetDownloadError("FETCH_FAILED");
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        total += value.byteLength;
        if (total > maxBytes) {
          throw new LegacyAssetDownloadError("TOO_LARGE");
        }
        chunks.push(value);
      }
    }
  } catch (err) {
    await reader.cancel().catch(() => {});
    if (err instanceof LegacyAssetDownloadError) throw err;
    throw new LegacyAssetDownloadError(signal.aborted ? "FETCH_TIMEOUT" : "FETCH_FAILED");
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

export interface DownloadLegacyManusAssetOptions {
  allowedMimeTypes: ReadonlySet<string>;
  maxBytes: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Bounded, hardened download of a single legacy Manus CloudFront asset.
 * Strict sequence: (1) hostname must be EXACTLY MANUS_CLOUDFRONT_HOSTNAME
 * over https, (2) fetch with a timeout and `redirect: "error"` (a legacy
 * CDN reference never needs to redirect), (3) response must be 2xx,
 * (4) Content-Length (when present) must not exceed maxBytes,
 * (5) Content-Type must be one of allowedMimeTypes, (6) the body is read
 * with a hard streamed byte ceiling regardless of what Content-Length
 * claimed, (7) the downloaded bytes must match their declared type's magic
 * number (where a rule exists). Never logs the URL, a query string, or the
 * response body.
 */
export async function downloadLegacyManusAsset(
  url: string,
  options: DownloadLegacyManusAssetOptions
): Promise<{ buffer: Buffer; contentType: string }> {
  if (!isMigratableManusCloudfrontUrl(url)) {
    throw new LegacyAssetDownloadError("HOSTNAME_MISMATCH");
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? LEGACY_ASSET_FETCH_TIMEOUT_MS;
  const { maxBytes, allowedMimeTypes } = options;

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetchImpl(url, { signal: controller.signal, redirect: "error" });
    } catch {
      throw new LegacyAssetDownloadError(controller.signal.aborted ? "FETCH_TIMEOUT" : "FETCH_FAILED");
    }

    if (!response.ok) {
      await cancelResponseBody(response);
      throw new LegacyAssetDownloadError("NON_2XX_RESPONSE");
    }

    const contentLengthHeader = response.headers.get("content-length");
    if (contentLengthHeader) {
      const declared = Number(contentLengthHeader);
      if (Number.isFinite(declared) && declared > maxBytes) {
        await cancelResponseBody(response);
        throw new LegacyAssetDownloadError("TOO_LARGE");
      }
    }

    const contentType = normalizeContentType(response.headers.get("content-type"));
    if (!allowedMimeTypes.has(contentType)) {
      await cancelResponseBody(response);
      throw new LegacyAssetDownloadError("UNSUPPORTED_TYPE");
    }

    const bodyBytes = await readBodyBounded(response, maxBytes, controller.signal);
    if (bodyBytes.length === 0) {
      throw new LegacyAssetDownloadError("EMPTY_BODY");
    }
    if (!matchesDeclaredContentType(bodyBytes, contentType)) {
      throw new LegacyAssetDownloadError("UNSUPPORTED_TYPE");
    }

    return { buffer: bodyBytes, contentType };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

// Historical Manus-hosted payment slips predate the app's current 5MB
// upload ceiling (see slipFileUploadService.ts's MAX_FILE_SIZE) - allow some
// headroom for old files while still bounding the worst case.
const MAX_LEGACY_SLIP_ASSET_BYTES = 10 * 1024 * 1024;
// Historical sports images predate the app's current 2MB upload ceiling (see
// routers.ts's sportsMatches.uploadImage) - same headroom reasoning.
const MAX_LEGACY_SPORTS_ASSET_BYTES = 5 * 1024 * 1024;
const LEGACY_ASSET_FETCH_TIMEOUT_MS = 20_000;

/** application/pdf accepted for slips (historical data contains scanned
 *  PDFs); never optimized/transformed - see migrateSlipRow(). */
const SLIP_ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "application/pdf"]);
const SPORTS_ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

// ─── Object key builders ────────────────────────────────────────────────────
// Never trusts a source filename (Manus CloudFront paths are opaque object
// ids, not reliable). Timestamp + random suffix guarantees collision safety.

function randomKeySuffix(): string {
  return Math.random().toString(36).substring(2, 8);
}

function extensionForContentType(contentType: string): string {
  switch (contentType) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "application/pdf":
      return "pdf";
    default:
      return "bin";
  }
}

function buildPaymentSlipKey(paymentId: number, contentType: string): string {
  return `payment-slips/legacy/payments/${paymentId}/${Date.now()}-${randomKeySuffix()}.${extensionForContentType(contentType)}`;
}

function buildWalletTopupSlipKey(topupId: number, contentType: string): string {
  return `payment-slips/legacy/wallet-topups/${topupId}/${Date.now()}-${randomKeySuffix()}.${extensionForContentType(contentType)}`;
}

function buildSportsMatchKey(matchId: number, column: SportsColumn): string {
  return `sports-matches/legacy/${matchId}/${column}/${Date.now()}-${randomKeySuffix()}.webp`;
}

// ─── Types ───────────────────────────────────────────────────────────────────

export type LegacyManusAssetMigrationType = "payments" | "wallet" | "sports" | "all";
export type SportsColumn = "home" | "away" | "cover";

interface SlipCandidateRow {
  source: "payments" | "walletTopups";
  id: number;
  value: string;
}
interface SportsCandidateRow {
  source: "sportsMatches";
  id: number;
  column: SportsColumn;
  value: string;
}
export type CandidateRow = SlipCandidateRow | SportsCandidateRow;

type RowClassification = "eligible" | "already_migrated" | "out_of_scope";

export interface LegacyManusAssetMigrationOptions {
  /** Preview only - no download-through-upload/DB write is committed; every
   *  eligible row is still downloaded+validated (and, for sports, optimized)
   *  so the preview is an accurate check that the source asset is real and
   *  decodable, it just stops before uploading to R2 or writing the DB. */
  dryRun: boolean;
  type: LegacyManusAssetMigrationType;
  /** Max rows to actually process this call (after already-migrated/
   *  out-of-scope rows are filtered out). */
  limit: number;
  /** Only rows with id >= startId. This is a LOWER-BOUND FILTER ONLY, never
   *  a resume cursor - the correct way to resume across multiple calls is
   *  rerunning with the SAME startId (an already-migrated row stops
   *  matching the Manus hostname and is naturally excluded on its own).
   *  Raising startId is safe only after independently verifying every row
   *  below it is already migrated or intentionally out of scope - see
   *  docs/LEGACY_MANUS_ASSET_MIGRATION.md's "Resume procedure". */
  startId?: number;
  /** sports-only: restrict to a single image column. Omit to check all
   *  three (home/away/cover). */
  column?: SportsColumn;
}

export interface LegacyManusAssetRowResult {
  source: "payments" | "walletTopups" | "sportsMatches";
  id: number;
  column?: SportsColumn;
  outcome: "migrated" | "would_migrate" | "failed";
  /** Safe identifier only - e.g. "payment #123", "walletTopup #456",
   *  "sportsMatch #789 home". Never the row's URL/key. */
  label: string;
  /** Only for outcome "failed" - a fixed, safe reason code, never a raw
   *  error message (which could otherwise echo a URL/response detail). */
  reason?: string;
  /** Only for outcome "migrated" and source "sportsMatches" - the new
   *  PUBLIC R2 URL (safe to display; sports images are public-facing).
   *  Never populated for payments/walletTopups (private, sensitive). */
  newUrl?: string;
}

export interface LegacyManusAssetMigrationBatchResult {
  dryRun: boolean;
  type: LegacyManusAssetMigrationType;
  limit: number;
  startId: number;
  column?: SportsColumn;
  /** Every row found matching type/startId/column with a non-empty value,
   *  before any classification. */
  totalChecked: number;
  /** Subset already migrated (r2p: for slips, public R2/media domain for
   *  sports) - skipped. */
  alreadyMigratedCount: number;
  /** Subset that is neither the legacy Manus hostname nor already migrated
   *  (e.g. an unrelated external URL, Google Docs link, or a malformed
   *  value) - out of scope for this migration, never touched. */
  outOfScopeCount: number;
  /** Rows whose hostname is exactly the legacy Manus CloudFront hostname. */
  eligibleCount: number;
  /** How many eligible rows were actually attempted this call (<= limit). */
  processedCount: number;
  /** eligibleCount - processedCount - still waiting for a future call. */
  remainingEligible: number;
  migratedCount: number;
  wouldMigrateCount: number;
  failedCount: number;
  results: LegacyManusAssetRowResult[];
}

/** Thrown when a live (non-dryRun) run is requested but the R2 bucket(s)
 *  needed for the requested `type` aren't fully configured. Message never
 *  contains a secret value - only which subsystem is missing config. */
export class LegacyManusAssetMigrationConfigError extends Error {}

/** Thrown when a migration is requested while another one is already
 *  running in this process. */
export class LegacyManusAssetMigrationLockError extends Error {}

// Single in-memory lock for the whole process - same reasoning as
// mediaMigrationService.ts's migrationInProgress: a real migration run is a
// deliberate, infrequent operator action, not something that needs per-batch
// or per-type locking. Always released in `finally`.
let migrationInProgress = false;

export function isLegacyManusAssetMigrationInProgress(): boolean {
  return migrationInProgress;
}

// ─── Candidate discovery ────────────────────────────────────────────────────

/**
 * All payments/walletTopups/sportsMatches rows with a non-empty relevant
 * column and id >= startId, for the requested type, ordered by id ascending.
 * Not capped by limit - the caller applies the limit only to eligible rows,
 * so alreadyMigratedCount/outOfScopeCount in the result reflect the whole
 * candidate pool, not just the processed slice.
 */
export async function fetchCandidateRows(
  type: LegacyManusAssetMigrationType,
  startId: number,
  column?: SportsColumn
): Promise<CandidateRow[]> {
  const db = await getDb();
  if (!db) {
    throw new Error("Database not available - check DATABASE_URL");
  }

  const rows: CandidateRow[] = [];

  if (type === "payments" || type === "all") {
    const paymentRows = await db
      .select({ id: payments.id, slipImageUrl: payments.slipImageUrl })
      .from(payments)
      .where(and(isNotNull(payments.slipImageUrl), ne(payments.slipImageUrl, ""), gte(payments.id, startId)))
      .orderBy(asc(payments.id));
    for (const p of paymentRows) {
      const value = (p.slipImageUrl || "").trim();
      if (value) rows.push({ source: "payments", id: p.id, value });
    }
  }

  if (type === "wallet" || type === "all") {
    const walletRows = await db
      .select({ id: walletTopups.id, slipImageUrl: walletTopups.slipImageUrl })
      .from(walletTopups)
      .where(and(isNotNull(walletTopups.slipImageUrl), ne(walletTopups.slipImageUrl, ""), gte(walletTopups.id, startId)))
      .orderBy(asc(walletTopups.id));
    for (const w of walletRows) {
      const value = (w.slipImageUrl || "").trim();
      if (value) rows.push({ source: "walletTopups", id: w.id, value });
    }
  }

  if (type === "sports" || type === "all") {
    const sportsRows = await db
      .select({
        id: sportsMatches.id,
        homeTeamImageUrl: sportsMatches.homeTeamImageUrl,
        awayTeamImageUrl: sportsMatches.awayTeamImageUrl,
        coverImageUrl: sportsMatches.coverImageUrl,
      })
      .from(sportsMatches)
      .where(gte(sportsMatches.id, startId))
      .orderBy(asc(sportsMatches.id));
    const columnsToCheck: SportsColumn[] = column ? [column] : ["home", "away", "cover"];
    for (const m of sportsRows) {
      for (const col of columnsToCheck) {
        const raw = col === "home" ? m.homeTeamImageUrl : col === "away" ? m.awayTeamImageUrl : m.coverImageUrl;
        const value = (raw || "").trim();
        if (value) rows.push({ source: "sportsMatches", id: m.id, column: col, value });
      }
    }
  }

  rows.sort((a, b) => a.id - b.id);
  return rows;
}

function classifyRow(row: CandidateRow): RowClassification {
  if (isMigratableManusCloudfrontUrl(row.value)) return "eligible";
  if (row.source === "sportsMatches") {
    return isAlreadyMigratedSportsValue(row.value) ? "already_migrated" : "out_of_scope";
  }
  return isAlreadyMigratedSlipValue(row.value) ? "already_migrated" : "out_of_scope";
}

export function formatRowLabel(row: CandidateRow): string {
  if (row.source === "payments") return `payment #${row.id}`;
  if (row.source === "walletTopups") return `walletTopup #${row.id}`;
  if (row.source === "sportsMatches") return `sportsMatch #${row.id} ${row.column}`;
  return `unknown row #${(row as CandidateRow).id}`;
}

function toSafeReasonCode(error: unknown): string {
  if (error instanceof LegacyAssetDownloadError) return error.reason;
  if (error instanceof R2PrivateStorageError) return `R2_PRIVATE_${error.reason.toUpperCase()}`;
  if (error instanceof R2StorageError) return `R2_${error.reason.toUpperCase()}`;
  if (error instanceof ImageOptimizeError) return "IMAGE_OPTIMIZE_FAILED";
  return "UNKNOWN_ERROR";
}

// ─── Dependency injection (tests only - production always uses the real
// implementations imported at the top of this file) ─────────────────────────

export interface LegacyManusAssetMigrationDeps {
  downloadFn?: typeof downloadLegacyManusAsset;
  putPrivateObjectFn?: typeof putPrivateObject;
  deletePrivateObjectFn?: typeof deletePrivateObject;
  r2PutFn?: typeof r2Put;
  optimizeImageFn?: typeof optimizeImageToWebp;
  /** Compare-and-swap writers (see server/db.ts) - the migration's ONLY DB
   *  write path. Each returns false (never throws) when the row's column no
   *  longer holds the exact value read at candidate-discovery time (or the
   *  row is gone) - callers must treat false as "not migrated". */
  updatePaymentSlipUrlIfUnchangedFn?: typeof updatePaymentSlipUrlIfUnchanged;
  updateWalletTopupSlipUrlIfUnchangedFn?: typeof updateWalletTopupSlipUrlIfUnchanged;
  updateSportsMatchImageUrlIfUnchangedFn?: typeof updateSportsMatchImageUrlIfUnchanged;
  isR2PrivateConfiguredFn?: typeof isR2PrivateConfigured;
  isR2ConfiguredFn?: typeof isR2Configured;
}

/** Returned when the upload itself succeeded but the final compare-and-swap
 *  DB write lost the race (the source column no longer held the exact value
 *  read at candidate-discovery time, or the row was deleted) - the row is
 *  reported as failed and its DB value is left completely untouched. */
const SOURCE_CHANGED_OR_ROW_MISSING = "SOURCE_CHANGED_OR_ROW_MISSING";

async function migrateSlipRow(
  row: SlipCandidateRow,
  dryRun: boolean,
  deps: LegacyManusAssetMigrationDeps
): Promise<LegacyManusAssetRowResult> {
  const label = formatRowLabel(row);
  const download = deps.downloadFn ?? downloadLegacyManusAsset;
  const putPrivate = deps.putPrivateObjectFn ?? putPrivateObject;
  const deletePrivate = deps.deletePrivateObjectFn ?? deletePrivateObject;
  const updatePaymentSlipUrlIfUnchangedFn = deps.updatePaymentSlipUrlIfUnchangedFn ?? updatePaymentSlipUrlIfUnchanged;
  const updateWalletTopupSlipUrlIfUnchangedFn =
    deps.updateWalletTopupSlipUrlIfUnchangedFn ?? updateWalletTopupSlipUrlIfUnchanged;

  try {
    // 1-5: hostname, fetch, response validity, size ceiling, MIME/magic
    // bytes - all enforced inside downloadLegacyManusAsset.
    const { buffer, contentType } = await download(row.value, {
      allowedMimeTypes: SLIP_ALLOWED_MIME_TYPES,
      maxBytes: MAX_LEGACY_SLIP_ASSET_BYTES,
    });

    if (dryRun) {
      return { source: row.source, id: row.id, outcome: "would_migrate", label };
    }

    // 6: upload to PRIVATE R2. Payment slips are financial evidence - never
    // optimized/transformed here, the original downloaded bytes are stored
    // unchanged (this applies to both image slips and PDFs).
    const key =
      row.source === "payments" ? buildPaymentSlipKey(row.id, contentType) : buildWalletTopupSlipKey(row.id, contentType);
    const context: PrivateObjectContext = "paymentSlip";
    const uploaded = await putPrivate(context, key, buffer, contentType);

    // 7: verify - a successful putPrivateObject() call always echoes back
    // the exact key it was given (see r2PrivateStorage.ts); a mismatch here
    // would indicate something unexpected happened between validation and
    // upload, and must never be treated as success.
    if (!uploaded.key || uploaded.key !== key) {
      throw new Error("UPLOAD_VERIFICATION_FAILED");
    }
    const ref = toPrivateObjectRef(uploaded.key);

    // 8: ONLY THEN update the DB row - a failure at any step above throws
    // before this line is ever reached, leaving the row (and the legacy
    // Manus source) completely untouched. Compare-and-swap on the EXACT
    // value read at candidate-discovery time (row.value) - if the column no
    // longer holds that value (a concurrent re-submission/edit, or the row
    // was deleted), this returns false instead of overwriting whatever is
    // there now.
    const wonCas =
      row.source === "payments"
        ? await updatePaymentSlipUrlIfUnchangedFn(row.id, row.value, ref)
        : await updateWalletTopupSlipUrlIfUnchangedFn(row.id, row.value, ref);

    if (!wonCas) {
      // The upload already succeeded and is now an orphaned private R2
      // object, since the DB write it was for was skipped. Best-effort
      // delete of EXACTLY that just-created key (never anything else,
      // never derived from a value read from the DB) - putPrivateObject()/
      // deletePrivateObject() are the only R2-private primitives that exist
      // for this, and this is exactly the safe, narrow use they support.
      // Cleanup failing here must never change the reported outcome or
      // retry semantics - correct DB preservation (never overwriting a
      // changed row) matters far more than avoiding an orphan object.
      await deletePrivate(context, key).catch(() => {});
      return { source: row.source, id: row.id, outcome: "failed", label, reason: SOURCE_CHANGED_OR_ROW_MISSING };
    }

    return { source: row.source, id: row.id, outcome: "migrated", label };
  } catch (error) {
    return { source: row.source, id: row.id, outcome: "failed", label, reason: toSafeReasonCode(error) };
  }
}

async function migrateSportsRow(
  row: SportsCandidateRow,
  dryRun: boolean,
  deps: LegacyManusAssetMigrationDeps
): Promise<LegacyManusAssetRowResult> {
  const label = formatRowLabel(row);
  const download = deps.downloadFn ?? downloadLegacyManusAsset;
  const r2PutFn = deps.r2PutFn ?? r2Put;
  const optimize = deps.optimizeImageFn ?? optimizeImageToWebp;
  const updateSportsMatchImageUrlIfUnchangedFn =
    deps.updateSportsMatchImageUrlIfUnchangedFn ?? updateSportsMatchImageUrlIfUnchanged;

  try {
    // 1-5: hostname, fetch, response validity, size ceiling, MIME/magic
    // bytes.
    const { buffer } = await download(row.value, {
      allowedMimeTypes: SPORTS_ALLOWED_MIME_TYPES,
      maxBytes: MAX_LEGACY_SPORTS_ASSET_BYTES,
    });

    // Optimize to WebP using the same preset/pipeline as a fresh sports
    // upload (see routers.ts Part C) - also acts as a second decode-level
    // validation: an undecodable buffer throws ImageOptimizeError here even
    // if it slipped past the Content-Type/magic-byte checks above.
    const optimized = await optimize(buffer, SPORTS_MATCH_IMAGE_PRESET);

    if (dryRun) {
      return { source: row.source, id: row.id, column: row.column, outcome: "would_migrate", label };
    }

    // 6: upload to PUBLIC R2.
    const key = buildSportsMatchKey(row.id, row.column);
    const uploaded = await r2PutFn(key, optimized.buffer, optimized.contentType);

    // 7: verify.
    if (!uploaded.url || uploaded.key !== key) {
      throw new Error("UPLOAD_VERIFICATION_FAILED");
    }

    // 8: ONLY THEN update the single requested column on this match row,
    // via compare-and-swap on the EXACT value read at candidate-discovery
    // time (row.value) - if that column no longer holds it (a concurrent
    // admin edit, or the row was deleted), this returns false instead of
    // overwriting whatever is there now.
    const columnField =
      row.column === "home" ? "homeTeamImageUrl" : row.column === "away" ? "awayTeamImageUrl" : "coverImageUrl";
    const wonCas = await updateSportsMatchImageUrlIfUnchangedFn(row.id, columnField, row.value, uploaded.url);

    if (!wonCas) {
      // Unlike the private-slip path, r2Storage.ts (the PUBLIC R2 adapter)
      // has no delete primitive at all - adding one solely for this cleanup
      // would be new surface area, not "an existing R2 abstraction that
      // already provides a clearly safe delete". The uploaded object is
      // therefore left in place as a harmless orphan (a public, non-
      // sensitive image, unreferenced by any DB row) - see
      // docs/LEGACY_MANUS_ASSET_MIGRATION.md's "Rollback philosophy"
      // section. Correct DB preservation (never overwriting a changed row)
      // matters far more than avoiding this orphan.
      return {
        source: row.source,
        id: row.id,
        column: row.column,
        outcome: "failed",
        label,
        reason: SOURCE_CHANGED_OR_ROW_MISSING,
      };
    }

    return { source: row.source, id: row.id, column: row.column, outcome: "migrated", label, newUrl: uploaded.url };
  } catch (error) {
    return { source: row.source, id: row.id, column: row.column, outcome: "failed", label, reason: toSafeReasonCode(error) };
  }
}

async function migrateRow(
  row: CandidateRow,
  dryRun: boolean,
  deps: LegacyManusAssetMigrationDeps
): Promise<LegacyManusAssetRowResult> {
  return row.source === "sportsMatches" ? migrateSportsRow(row, dryRun, deps) : migrateSlipRow(row, dryRun, deps);
}

/**
 * Run one bounded batch of the legacy Manus CloudFront -> R2 migration.
 * Processes rows strictly sequentially (one at a time) - 2,878 total assets
 * is manageable, and safety matters far more than speed here; no concurrent
 * fan-out.
 *
 * Safety:
 * - A single in-memory lock across the whole process - a second call while
 *   one is already running throws LegacyManusAssetMigrationLockError instead
 *   of racing it. Always released in `finally`.
 * - dryRun still downloads+validates (and, for sports, optimizes) each
 *   eligible row, it just never uploads to R2 or writes to the DB.
 * - A row's DB column is only updated after ITS OWN R2 upload has already
 *   succeeded; any failure leaves that row (and the legacy Manus source)
 *   completely untouched, safe to retry on a later run.
 * - Only a value whose hostname is EXACTLY the legacy Manus CloudFront
 *   hostname is ever migrated - r2p: references, already-public-R2 URLs,
 *   and any other out-of-scope value are left untouched and merely counted.
 * - `fetchCandidateRowsFn`/other `deps` overrides exist ONLY for unit
 *   tests - production code always uses the real DB/R2/optimizer.
 */
export async function runLegacyManusAssetMigrationBatch(
  options: LegacyManusAssetMigrationOptions,
  deps: LegacyManusAssetMigrationDeps & { fetchCandidateRowsFn?: typeof fetchCandidateRows } = {}
): Promise<LegacyManusAssetMigrationBatchResult> {
  const { dryRun, type, limit, column } = options;
  const startId = options.startId ?? 0;
  const fetchRows = deps.fetchCandidateRowsFn ?? fetchCandidateRows;
  const checkR2PrivateConfigured = deps.isR2PrivateConfiguredFn ?? isR2PrivateConfigured;
  const checkR2Configured = deps.isR2ConfiguredFn ?? isR2Configured;

  if (!dryRun) {
    const missing: string[] = [];
    if ((type === "payments" || type === "wallet" || type === "all") && !checkR2PrivateConfigured()) {
      missing.push("private R2 (payments/wallet slips)");
    }
    if ((type === "sports" || type === "all") && !checkR2Configured()) {
      missing.push("public R2 (sports images)");
    }
    if (missing.length > 0) {
      throw new LegacyManusAssetMigrationConfigError(
        `R2 storage is not fully configured for this run: ${missing.join("; ")}. ` +
          "Run with --dry-run to preview without needing R2 configured, or set the R2_* env vars first."
      );
    }
  }

  if (migrationInProgress) {
    throw new LegacyManusAssetMigrationLockError("A legacy Manus asset migration run is already in progress. Please wait.");
  }
  migrationInProgress = true;

  try {
    const candidates = await fetchRows(type, startId, column);
    const totalChecked = candidates.length;

    const classified = candidates.map((row) => ({ row, classification: classifyRow(row) }));
    const alreadyMigrated = classified.filter((c) => c.classification === "already_migrated");
    const outOfScope = classified.filter((c) => c.classification === "out_of_scope");
    const eligible = classified.filter((c) => c.classification === "eligible").map((c) => c.row);
    const toProcess = eligible.slice(0, limit);
    const remainingEligible = eligible.length - toProcess.length;

    const results: LegacyManusAssetRowResult[] = [];
    for (const row of toProcess) {
      results.push(await migrateRow(row, dryRun, deps));
    }

    return {
      dryRun,
      type,
      limit,
      startId,
      column,
      totalChecked,
      alreadyMigratedCount: alreadyMigrated.length,
      outOfScopeCount: outOfScope.length,
      eligibleCount: eligible.length,
      processedCount: toProcess.length,
      remainingEligible,
      migratedCount: results.filter((r) => r.outcome === "migrated").length,
      wouldMigrateCount: results.filter((r) => r.outcome === "would_migrate").length,
      failedCount: results.filter((r) => r.outcome === "failed").length,
      results,
    };
  } finally {
    migrationInProgress = false;
  }
}
