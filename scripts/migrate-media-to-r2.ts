#!/usr/bin/env tsx
/**
 * One-off, manually-run migration: moves existing novels.coverImageUrl /
 * banners.imageUrl files off the old storage and onto Cloudflare R2, using
 * the exact same optimize-to-WebP pipeline as the live upload endpoints
 * (admin.novels.uploadCover / admin.banners.uploadImage in server/routers.ts)
 * - see server/services/imageOptimizer.ts and server/services/r2Storage.ts.
 *
 * Safety properties (see the task's acceptance criteria for the full list):
 * - Never runs automatically - only via an explicit `tsx` invocation / the
 *   `migrate:media`/`migrate:media:dry` npm scripts. Not wired into any
 *   build/deploy/start script.
 * - Never deletes the old file - only re-points the DB row's URL column
 *   after a successful R2 upload.
 * - A row's DB URL is only ever updated after its R2 upload has already
 *   succeeded - a failed upload never touches the DB.
 * - Rows whose URL already starts with R2_PUBLIC_BASE_URL (or the known
 *   production CDN domain) are skipped, so re-running the script is safe
 *   and idempotent.
 * - --dry-run downloads and optimizes nothing (see EFFECTIVE work below) and
 *   never uploads or writes to the DB - it only reports what a real run
 *   would do.
 * - Low, bounded concurrency (default 3) instead of firing every request at
 *   once.
 *
 * Usage:
 *   tsx scripts/migrate-media-to-r2.ts --dry-run --limit=20 --type=all
 *   tsx scripts/migrate-media-to-r2.ts --limit=5 --type=banners
 *   tsx scripts/migrate-media-to-r2.ts --limit=5 --type=novels --start-id=100
 *   tsx scripts/migrate-media-to-r2.ts --limit=5 --type=novels --force
 *
 * Flags:
 *   --dry-run       Preview only - no download optimize/upload/DB write.
 *   --limit=N       Max rows to actually process this run (default 20).
 *   --type=TYPE     "novels" | "banners" | "all" (default "all").
 *   --start-id=N    Only rows with id >= N (default 0) - for resuming/
 *                   paginating through a large table in batches.
 *   --force         Also re-process rows whose URL already looks migrated
 *                   (normally skipped). Rarely needed - e.g. to re-run with
 *                   a changed optimize preset.
 */
import { pathToFileURL } from "node:url";
import { and, asc, gte, isNotNull, ne } from "drizzle-orm";
import { getDb, updateNovel, updateBanner } from "../server/db";
import { novels, banners } from "../drizzle/schema";
import { r2Put, isR2Configured, R2StorageError } from "../server/services/r2Storage";
import {
  optimizeImageToWebp,
  ImageOptimizeError,
  NOVEL_COVER_PRESET,
  BANNER_IMAGE_PRESET,
} from "../server/services/imageOptimizer";
import { ENV } from "../server/_core/env";

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
const CONCURRENCY = 3;

type MediaType = "novel" | "banner";
type CliType = "novels" | "banners" | "all";

interface CliArgs {
  dryRun: boolean;
  limit: number;
  type: CliType;
  startId: number;
  force: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  let dryRun = false;
  let limit = 20;
  let type: CliType = "all";
  let startId = 0;
  let force = false;

  for (const raw of argv) {
    if (raw === "--dry-run") {
      dryRun = true;
    } else if (raw === "--force") {
      force = true;
    } else if (raw.startsWith("--limit=")) {
      const parsed = parseInt(raw.slice("--limit=".length), 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`Invalid --limit value: "${raw}"`);
      }
      limit = parsed;
    } else if (raw.startsWith("--start-id=")) {
      const parsed = parseInt(raw.slice("--start-id=".length), 10);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`Invalid --start-id value: "${raw}"`);
      }
      startId = parsed;
    } else if (raw.startsWith("--type=")) {
      const value = raw.slice("--type=".length);
      if (value !== "novels" && value !== "banners" && value !== "all") {
        throw new Error(`Invalid --type value: "${raw}" (expected novels|banners|all)`);
      }
      type = value;
    } else {
      throw new Error(`Unrecognized argument: "${raw}"`);
    }
  }

  return { dryRun, limit, type, startId, force };
}

interface CandidateRow {
  type: MediaType;
  id: number;
  url: string;
}

export function isAlreadyMigratedUrl(url: string): boolean {
  const bases = [ENV.r2PublicBaseUrl, KNOWN_MIGRATED_DOMAIN]
    .filter((b) => !!b)
    .map((b) => b.replace(/\/+$/, ""));
  return bases.some((base) => url.startsWith(base));
}

/**
 * All novel/banner rows with a non-empty URL and id >= startId, for the
 * requested --type, ordered by id ascending. Not capped by --limit - the
 * caller applies the limit only to rows that actually need migrating, so the
 * "skipped" (already migrated) count in the summary reflects the whole
 * candidate pool, not just the processed slice.
 */
async function fetchCandidateRows(type: CliType, startId: number): Promise<CandidateRow[]> {
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

export function buildMigrationKey(row: CandidateRow): string {
  const prefix = row.type === "novel" ? "novel-covers" : "banners";
  return `${prefix}/migrated/${row.id}/${Date.now()}-${randomKeySuffix()}.webp`;
}

type Outcome = "migrated" | "would_migrate" | "failed";

interface RowResult {
  type: MediaType;
  id: number;
  outcome: Outcome;
  oldUrl: string;
  newUrl?: string;
  reason?: string;
}

async function migrateRow(row: CandidateRow, dryRun: boolean): Promise<RowResult> {
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
    // value is never touched on failure.
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

/** Minimal bounded-concurrency runner - no need for an extra dependency for
 *  a handful of parallel downloads. */
async function runWithConcurrency<T, R>(items: T[], concurrency: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function runOne(): Promise<void> {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await worker(items[current]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => runOne()));
  return results;
}

function formatRowLabel(row: { type: MediaType; id: number }): string {
  return row.type === "novel" ? `novel #${row.id}` : `banner #${row.id}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log("=== Media -> R2 migration ===");
  console.log(
    `mode=${args.dryRun ? "DRY-RUN (no upload, no DB write)" : "LIVE"} type=${args.type} limit=${args.limit} startId=${args.startId} force=${args.force}`
  );

  if (!args.dryRun && !isR2Configured()) {
    console.error(
      "\nR2 is not configured (missing one or more of R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / " +
        "R2_SECRET_ACCESS_KEY / R2_BUCKET_NAME / R2_PUBLIC_BASE_URL / R2_ENDPOINT). " +
        "Run with --dry-run to preview without needing R2 configured, or set the R2_* env vars first."
    );
    process.exit(1);
  }

  const candidates = await fetchCandidateRows(args.type, args.startId);
  const totalChecked = candidates.length;

  const alreadyMigrated = args.force ? [] : candidates.filter((row) => isAlreadyMigratedUrl(row.url));
  const eligible = args.force ? candidates : candidates.filter((row) => !isAlreadyMigratedUrl(row.url));
  const toProcess = eligible.slice(0, args.limit);
  const remainingEligible = eligible.length - toProcess.length;

  console.log(
    `\nFound ${totalChecked} row(s) with a media URL (type=${args.type}, id>=${args.startId}). ` +
      `${alreadyMigrated.length} already on R2 (skipped), ${eligible.length} eligible, processing ${toProcess.length} this run.`
  );

  if (toProcess.length === 0) {
    console.log("\nNothing to do.");
    return;
  }

  const results = await runWithConcurrency(toProcess, CONCURRENCY, (row) => migrateRow(row, args.dryRun));

  console.log("\n--- Results ---");
  for (const result of results) {
    const label = formatRowLabel(result);
    if (result.outcome === "failed") {
      console.log(`[FAILED]  ${label}: ${result.reason}\n          old: ${result.oldUrl}`);
    } else if (result.outcome === "would_migrate") {
      console.log(`[DRY-RUN] ${label}: ${result.oldUrl} -> ${result.newUrl}`);
    } else {
      console.log(`[OK]      ${label}: ${result.oldUrl} -> ${result.newUrl}`);
    }
  }

  const migratedCount = results.filter((r) => r.outcome === "migrated").length;
  const wouldMigrateCount = results.filter((r) => r.outcome === "would_migrate").length;
  const failedCount = results.filter((r) => r.outcome === "failed").length;

  console.log("\n--- Summary ---");
  console.log(`Total checked:     ${totalChecked}`);
  console.log(`Already migrated:  ${alreadyMigrated.length} (skipped)`);
  if (args.dryRun) {
    console.log(`Would migrate:     ${wouldMigrateCount}`);
  } else {
    console.log(`Migrated:          ${migratedCount}`);
  }
  console.log(`Failed:            ${failedCount}`);
  if (remainingEligible > 0) {
    console.log(
      `Not processed this run: ${remainingEligible} more eligible row(s) beyond --limit=${args.limit} - re-run with a higher --limit or a later --start-id to continue.`
    );
  }

  if (failedCount > 0) {
    console.log("\nFailed rows were left untouched in the DB and still point at their original URL.");
  }
}

// Only auto-run when executed directly (`tsx scripts/migrate-media-to-r2.ts`)
// - not when imported as a module (e.g. to unit-test the exported pure
//   functions above), so importing this file never has the side effect of
//   kicking off a real migration run.
const isDirectExecution = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectExecution) {
  main().catch((error) => {
    console.error("\nMigration script crashed:", error?.message || error);
    process.exit(1);
  });
}
