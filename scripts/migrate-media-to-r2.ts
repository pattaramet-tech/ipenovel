#!/usr/bin/env tsx
/**
 * CLI wrapper around server/services/mediaMigrationService.ts - the same
 * service the admin.mediaMigration.preview/run tRPC procedures use (see
 * server/routers.ts), for running the novels.coverImageUrl/banners.imageUrl
 * -> R2 migration from a terminal where DATABASE_URL/R2_* are available in
 * the shell env. All the actual migration logic lives in the service; this
 * file only parses argv and formats the result for the console.
 *
 * Never runs automatically - only via an explicit `tsx` invocation / the
 * `migrate:media`/`migrate:media:dry` npm scripts. Not wired into any
 * build/deploy/start script.
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
import {
  runMediaMigrationBatch,
  formatRowLabel,
  MediaMigrationConfigError,
  MediaMigrationLockError,
  type MediaMigrationType,
} from "../server/services/mediaMigrationService";

interface CliArgs {
  dryRun: boolean;
  limit: number;
  type: MediaMigrationType;
  startId: number;
  force: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  let dryRun = false;
  let limit = 20;
  let type: MediaMigrationType = "all";
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

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log("=== Media -> R2 migration ===");
  console.log(
    `mode=${args.dryRun ? "DRY-RUN (no upload, no DB write)" : "LIVE"} type=${args.type} limit=${args.limit} startId=${args.startId} force=${args.force}`
  );

  let result;
  try {
    result = await runMediaMigrationBatch(args);
  } catch (error) {
    if (error instanceof MediaMigrationConfigError) {
      console.error(
        `\n${error.message}\nRun with --dry-run to preview without needing R2 configured, or set the R2_* env vars first.`
      );
      process.exit(1);
    }
    if (error instanceof MediaMigrationLockError) {
      console.error(`\n${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  console.log(
    `\nFound ${result.totalChecked} row(s) with a media URL (type=${args.type}, id>=${args.startId}). ` +
      `${result.alreadyMigratedCount} already on R2 (skipped), ${result.eligibleCount} eligible, processing ${result.processedCount} this run.`
  );

  if (result.processedCount === 0) {
    console.log("\nNothing to do.");
    return;
  }

  console.log("\n--- Results ---");
  for (const row of result.results) {
    const label = formatRowLabel(row);
    if (row.outcome === "failed") {
      console.log(`[FAILED]  ${label}: ${row.reason}\n          old: ${row.oldUrl}`);
    } else if (row.outcome === "would_migrate") {
      console.log(`[DRY-RUN] ${label}: ${row.oldUrl} -> ${row.newUrl}`);
    } else {
      console.log(`[OK]      ${label}: ${row.oldUrl} -> ${row.newUrl}`);
    }
  }

  console.log("\n--- Summary ---");
  console.log(`Total checked:     ${result.totalChecked}`);
  console.log(`Already migrated:  ${result.alreadyMigratedCount} (skipped)`);
  if (args.dryRun) {
    console.log(`Would migrate:     ${result.wouldMigrateCount}`);
  } else {
    console.log(`Migrated:          ${result.migratedCount}`);
  }
  console.log(`Failed:            ${result.failedCount}`);
  if (result.remainingEligible > 0) {
    console.log(
      `Not processed this run: ${result.remainingEligible} more eligible row(s) beyond --limit=${args.limit} - re-run with a higher --limit or a later --start-id to continue.`
    );
  }

  if (result.failedCount > 0) {
    console.log("\nFailed rows were left untouched in the DB and still point at their original URL.");
  }
}

// Only auto-run when executed directly (`tsx scripts/migrate-media-to-r2.ts`)
// - not when imported as a module (e.g. to unit-test parseArgs above), so
// importing this file never has the side effect of kicking off a real
// migration run.
const isDirectExecution = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectExecution) {
  main().catch((error) => {
    console.error("\nMigration script crashed:", error?.message || error);
    process.exit(1);
  });
}
