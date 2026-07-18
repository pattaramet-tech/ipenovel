// Core logic for moving existing novels.coverImageUrl / banners.imageUrl
// files off the old storage and onto Cloudflare R2. This is the single
// implementation shared by:
// - scripts/migrate-media-to-r2.ts (CLI, run locally where DATABASE_URL/R2_*
//   are available in the shell env)
// - admin.mediaMigration.preview/run in server/routers.ts (HTTP, for
//   Manus production where there is no terminal - the Application Secrets
//   for DATABASE_URL/R2_* are only available to the running server process)
//
// Neither caller duplicates this logic - see runMediaMigrationBatch below.
import { and, asc, gte, isNotNull, ne } from "drizzle-orm";
import { getDb, updateNovel, updateBanner } from "../db";
import { novels, banners } from "../../drizzle/schema";
import { r2Put, isR2Configured, R2StorageError } from "./r2Storage";
import {
  optimizeImageToWebp,
  ImageOptimizeError,
  NOVEL_COVER_PRESET,
  BANNER_IMAGE_PRESET,
} from "./imageOptimizer";
import { ENV } from "../_core/env";

// Known production CDN domain, in addition to whatever R2_PUBLIC_BASE_URL
// resolves to in this environment - a URL matching either is treated as
// already migrated. Not a secret: this is the same public hostname images
// are already served from today.
const KNOWN_MIGRATED_DOMAIN = "https://media.ipenovel.com";

// Generous ceiling against a corrupt/wrong URL returning something huge -
// this is a legacy image being re-downloaded, never a fresh untrusted
// upload, but we still don't want one bad row to pull gigabytes.
const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 20_000;

export type MediaType = "novel" | "banner";
export type MediaMigrationType = "novels" | "banners" | "all";

export interface MediaMigrationOptions {
  /** Preview only - no download optimize/upload/DB write; every row that
   *  would be migrated is reported with outcome "would_migrate" instead. */
  dryRun: boolean;
  type: MediaMigrationType;
  /** Max rows to actually process this call (after already-migrated rows
   *  are filtered out) - see MediaMigrationBatchResult.remainingEligible for
   *  how many more are waiting beyond this. */
  limit: number;
  /** Only rows with id >= startId - for paginating through a large table in
   *  batches across multiple calls. */
  startId?: number;
  /** Also re-process rows whose URL already looks migrated (normally
   *  skipped). Not exposed in the admin UI - CLI-only escape hatch. */
  force?: boolean;
}

export interface MediaMigrationRowResult {
  type: MediaType;
  id: number;
  outcome: "migrated" | "would_migrate" | "failed";
  oldUrl: string;
  newUrl?: string;
  reason?: string;
}

export interface MediaMigrationBatchResult {
  dryRun: boolean;
  type: MediaMigrationType;
  limit: number;
  startId: number;
  force: boolean;
  /** Every row found matching type/startId with a non-empty URL, before any
   *  already-migrated filtering. */
  totalChecked: number;
  /** Subset of totalChecked already pointing at R2 - skipped (unless
   *  force). */
  alreadyMigratedCount: number;
  /** totalChecked - alreadyMigratedCount (or totalChecked if force). */
  eligibleCount: number;
  /** How many eligible rows were actually attempted this call (<= limit). */
  processedCount: number;
  /** eligibleCount - processedCount - still waiting for a future call with
   *  a higher limit or a later startId. */
  remainingEligible: number;
  migratedCount: number;
  wouldMigrateCount: number;
  failedCount: number;
  results: MediaMigrationRowResult[];
}

/** Thrown when a live (non-dryRun) run is requested but R2 isn't fully
 *  configured. Message never contains a secret value - only which env var
 *  names are missing. */
export class MediaMigrationConfigError extends Error {}

/** Thrown when a migration is requested while another one (dry-run or live)
 *  is already in progress in this process. */
export class MediaMigrationLockError extends Error {}

// Single in-memory lock for the whole process - a real migration run is a
// deliberate, infrequent admin action, not something that needs per-batch or
// per-type locking. Reset in the `finally` below no matter how the run ends.
let migrationInProgress = false;

export function isMediaMigrationInProgress(): boolean {
  return migrationInProgress;
}

interface CandidateRow {
  type: MediaType;
  id: number;
  url: string;
}

export function isAlreadyMigratedUrl(url: string): boolean {
  const bases = [ENV.r2PublicBaseUrl, KNOWN_MIGRATED_DOMAIN]
    .filter((b): b is string => !!b)
    .map((b) => b.replace(/\/+$/, ""));
  return bases.some((base) => url.startsWith(base));
}

/**
 * All novel/banner rows with a non-empty URL and id >= startId, for the
 * requested type, ordered by id ascending. Not capped by limit - the caller
 * applies the limit only to rows that actually need migrating, so the
 * "skipped" (already migrated) count in the result reflects the whole
 * candidate pool, not just the processed slice.
 */
async function fetchCandidateRows(type: MediaMigrationType, startId: number): Promise<CandidateRow[]> {
  const db = await getDb();
  if (!db) {
    throw new Error("Database not available - check DATABASE_URL");
  }

  const rows: CandidateRow[] = [];

  if (type === "novels" || type === "all") {
    const novelRows = await db
      .select({ id: novels.id, coverImageUrl: novels.coverImageUrl })
      .from(novels)
      .where(and(isNotNull(novels.coverImageUrl), ne(novels.coverImageUrl, ""), gte(novels.id, startId)))
      .orderBy(asc(novels.id));

    for (const n of novelRows) {
      const url = (n.coverImageUrl || "").trim();
      if (url) rows.push({ type: "novel", id: n.id, url });
    }
  }

  if (type === "banners" || type === "all") {
    const bannerRows = await db
      .select({ id: banners.id, imageUrl: banners.imageUrl })
      .from(banners)
      .where(and(ne(banners.imageUrl, ""), gte(banners.id, startId)))
      .orderBy(asc(banners.id));

    for (const b of bannerRows) {
      const url = (b.imageUrl || "").trim();
      if (url) rows.push({ type: "banner", id: b.id, url });
    }
  }

  rows.sort((a, b) => a.id - b.id);
  return rows;
}

export async function downloadImage(url: string): Promise<{ buffer: Buffer; contentType: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } catch (error: any) {
    throw new Error(`ดาวน์โหลดไม่สำเร็จ: ${error?.message || "network error"}`);
  } finally {
    clearTimeout(timeout);
  }

  if (response.status !== 200) {
    throw new Error(`HTTP status ${response.status} (ต้องเป็น 200)`);
  }

  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  if (!contentType.startsWith("image/")) {
    throw new Error(`content-type "${contentType || "(none)"}" ไม่ใช่ image/*`);
  }

  const contentLengthHeader = response.headers.get("content-length");
  if (contentLengthHeader && Number(contentLengthHeader) > MAX_DOWNLOAD_BYTES) {
    throw new Error(
      `ไฟล์ใหญ่เกินไป (${(Number(contentLengthHeader) / 1024 / 1024).toFixed(1)}MB, จำกัดที่ ${(MAX_DOWNLOAD_BYTES / 1024 / 1024).toFixed(0)}MB)`
    );
  }

  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > MAX_DOWNLOAD_BYTES) {
    throw new Error(
      `ไฟล์ใหญ่เกินไป (${(arrayBuffer.byteLength / 1024 / 1024).toFixed(1)}MB, จำกัดที่ ${(MAX_DOWNLOAD_BYTES / 1024 / 1024).toFixed(0)}MB)`
    );
  }

  return { buffer: Buffer.from(arrayBuffer), contentType };
}

function randomKeySuffix(): string {
  return Math.random().toString(36).substring(2, 8);
}

export function buildMigrationKey(row: { type: MediaType; id: number }): string {
  const prefix = row.type === "novel" ? "novel-covers" : "banners";
  return `${prefix}/migrated/${row.id}/${Date.now()}-${randomKeySuffix()}.webp`;
}

async function migrateRow(row: CandidateRow, dryRun: boolean): Promise<MediaMigrationRowResult> {
  try {
    const { buffer } = await downloadImage(row.url);

    const preset = row.type === "novel" ? NOVEL_COVER_PRESET : BANNER_IMAGE_PRESET;
    let optimized;
    try {
      optimized = await optimizeImageToWebp(buffer, preset);
    } catch (error) {
      throw new Error(error instanceof ImageOptimizeError ? error.message : String(error));
    }

    const key = buildMigrationKey(row);

    if (dryRun) {
      return {
        type: row.type,
        id: row.id,
        outcome: "would_migrate",
        oldUrl: row.url,
        newUrl: `(dry-run, not uploaded) -> ${key}`,
      };
    }

    let newUrl: string;
    try {
      const uploaded = await r2Put(key, optimized.buffer, optimized.contentType);
      newUrl = uploaded.url;
    } catch (error) {
      throw new Error(error instanceof R2StorageError ? error.message : String(error));
    }

    // Only touch the DB row after the R2 upload has already succeeded - a
    // failed upload above throws before we ever get here, so this row's DB
    // value (and the old file it still points at) is never touched on
    // failure.
    if (row.type === "novel") {
      await updateNovel(row.id, { coverImageUrl: newUrl });
    } else {
      await updateBanner(row.id, { imageUrl: newUrl });
    }

    return { type: row.type, id: row.id, outcome: "migrated", oldUrl: row.url, newUrl };
  } catch (error: any) {
    return {
      type: row.type,
      id: row.id,
      outcome: "failed",
      oldUrl: row.url,
      reason: error?.message || String(error),
    };
  }
}

export function formatRowLabel(row: { type: MediaType; id: number }): string {
  return row.type === "novel" ? `novel #${row.id}` : `banner #${row.id}`;
}

/**
 * Run one bounded batch of the novels.coverImageUrl/banners.imageUrl -> R2
 * migration. Processes rows strictly sequentially (one at a time) - this is
 * called from an HTTP request handler as well as a long-lived CLI process,
 * every batch is intentionally small, and there's no upside to concurrent
 * fan-out here that's worth the extra risk of a request timeout.
 *
 * Safety:
 * - A single in-memory lock across the whole process (see
 *   isMediaMigrationInProgress) - a second call while one is already running
 *   throws MediaMigrationLockError instead of racing it. Always released in
 *   `finally`, however the run ends.
 * - dryRun still downloads+optimizes each row (so the preview is an
 *   accurate check that the source image is real and decodable), it just
 *   never uploads to R2 or writes to the DB.
 * - A row's DB URL is only updated after ITS OWN R2 upload has already
 *   succeeded; a failed download/optimize/upload never touches the DB and
 *   never deletes the old file.
 * - Rows already pointing at R2_PUBLIC_BASE_URL / media.ipenovel.com are
 *   skipped unless `force` is set.
 */
export async function runMediaMigrationBatch(options: MediaMigrationOptions): Promise<MediaMigrationBatchResult> {
  const { dryRun, type, limit, force = false } = options;
  const startId = options.startId ?? 0;

  if (!dryRun && !isR2Configured()) {
    throw new MediaMigrationConfigError(
      "R2 is not configured - missing one or more of R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / " +
        "R2_SECRET_ACCESS_KEY / R2_BUCKET_NAME / R2_PUBLIC_BASE_URL / R2_ENDPOINT."
    );
  }

  if (migrationInProgress) {
    throw new MediaMigrationLockError("Migration is already running. Please wait.");
  }
  migrationInProgress = true;

  try {
    const candidates = await fetchCandidateRows(type, startId);
    const totalChecked = candidates.length;

    const alreadyMigrated = force ? [] : candidates.filter((row) => isAlreadyMigratedUrl(row.url));
    const eligible = force ? candidates : candidates.filter((row) => !isAlreadyMigratedUrl(row.url));
    const toProcess = eligible.slice(0, limit);
    const remainingEligible = eligible.length - toProcess.length;

    const results: MediaMigrationRowResult[] = [];
    for (const row of toProcess) {
      results.push(await migrateRow(row, dryRun));
    }

    return {
      dryRun,
      type,
      limit,
      startId,
      force,
      totalChecked,
      alreadyMigratedCount: alreadyMigrated.length,
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
