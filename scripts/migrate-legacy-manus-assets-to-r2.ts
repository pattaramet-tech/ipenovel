#!/usr/bin/env tsx
/**
 * CLI wrapper around server/services/legacyManusAssetMigrationService.ts -
 * moves legacy Manus CloudFront-hosted assets onto Cloudflare R2:
 *   A. payments.slipImageUrl / walletTopups.slipImageUrl -> PRIVATE R2
 *   B. sportsMatches.{homeTeamImageUrl,awayTeamImageUrl,coverImageUrl} ->
 *      PUBLIC R2
 *
 * All the actual migration logic lives in the service; this file only
 * parses argv and formats the result for the console. Never runs
 * automatically - only via an explicit `tsx` invocation / the
 * `migrate:legacy-manus-assets`/`migrate:legacy-manus-assets:dry` npm
 * scripts. Not wired into any install/build/deploy/db-migrate/startup path.
 *
 * See docs/LEGACY_MANUS_ASSET_MIGRATION.md for the full runbook.
 *
 * Usage:
 *   tsx scripts/migrate-legacy-manus-assets-to-r2.ts --dry-run --limit=20 --type=all
 *   tsx scripts/migrate-legacy-manus-assets-to-r2.ts --limit=20 --type=payments
 *   tsx scripts/migrate-legacy-manus-assets-to-r2.ts --limit=20 --type=wallet --start-id=100
 *   tsx scripts/migrate-legacy-manus-assets-to-r2.ts --limit=20 --type=sports --column=cover
 *
 * Flags:
 *   --dry-run       Preview only - downloads+validates each eligible row
 *                    (and, for sports, optimizes it), but never uploads to
 *                    R2 or writes to the DB.
 *   --limit=N       Max rows to actually process this run (default 20).
 *   --type=TYPE     "payments" | "wallet" | "sports" | "all" (default "all").
 *   --start-id=N    Only rows with id >= N (default 0) - for resuming/
 *                   paginating through a large table in batches.
 *   --column=COL    sports-only: "home" | "away" | "cover". Omit to check
 *                    all three columns.
 *
 * There is deliberately no --force flag - every row is re-classified fresh
 * on every run (a migrated row no longer has the legacy Manus hostname, so
 * it's naturally skipped on rerun).
 */
import { pathToFileURL } from "node:url";
import {
  runLegacyManusAssetMigrationBatch,
  formatRowLabel,
  LegacyManusAssetMigrationConfigError,
  LegacyManusAssetMigrationLockError,
  type LegacyManusAssetMigrationType,
  type SportsColumn,
} from "../server/services/legacyManusAssetMigrationService";

interface CliArgs {
  dryRun: boolean;
  limit: number;
  type: LegacyManusAssetMigrationType;
  startId: number;
  column?: SportsColumn;
}

export function parseArgs(argv: string[]): CliArgs {
  let dryRun = false;
  let limit = 20;
  let type: LegacyManusAssetMigrationType = "all";
  let startId = 0;
  let column: SportsColumn | undefined;

  for (const raw of argv) {
    if (raw === "--dry-run") {
      dryRun = true;
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
      if (value !== "payments" && value !== "wallet" && value !== "sports" && value !== "all") {
        throw new Error(`Invalid --type value: "${raw}" (expected payments|wallet|sports|all)`);
      }
      type = value;
    } else if (raw.startsWith("--column=")) {
      const value = raw.slice("--column=".length);
      if (value !== "home" && value !== "away" && value !== "cover") {
        throw new Error(`Invalid --column value: "${raw}" (expected home|away|cover)`);
      }
      column = value;
    } else {
      throw new Error(`Unrecognized argument: "${raw}"`);
    }
  }

  if (column && type !== "sports" && type !== "all") {
    throw new Error(`--column is only valid with --type=sports or --type=all (got --type=${type})`);
  }

  return { dryRun, limit, type, startId, column };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log("=== Legacy Manus assets -> R2 migration ===");
  console.log(
    `mode=${args.dryRun ? "DRY-RUN (no upload, no DB write)" : "LIVE"} type=${args.type} limit=${args.limit} startId=${args.startId}` +
      (args.column ? ` column=${args.column}` : "")
  );

  let result;
  try {
    result = await runLegacyManusAssetMigrationBatch(args);
  } catch (error) {
    if (error instanceof LegacyManusAssetMigrationConfigError) {
      console.error(`\n${error.message}`);
      process.exit(1);
    }
    if (error instanceof LegacyManusAssetMigrationLockError) {
      console.error(`\n${error.message}`);
      process.exit(1);
    }
    throw error;
  }

  console.log(
    `\nChecked ${result.totalChecked} row(s) with a non-empty value (type=${args.type}, id>=${args.startId}). ` +
      `${result.alreadyMigratedCount} already migrated (skipped), ${result.outOfScopeCount} out of scope (skipped), ` +
      `${result.eligibleCount} eligible, processing ${result.processedCount} this run.`
  );

  if (result.processedCount === 0) {
    console.log("\nNothing to do.");
    return;
  }

  console.log("\n--- Results ---");
  for (const row of result.results) {
    const label = formatRowLabel(row);
    if (row.outcome === "failed") {
      console.log(`[FAILED]  ${label}: ${row.reason}`);
    } else if (row.outcome === "would_migrate") {
      console.log(`[DRY-RUN] ${label}: would migrate`);
    } else if (row.newUrl) {
      // sports (public) - safe to show the new URL.
      console.log(`[OK]      ${label}: migrated -> ${row.newUrl}`);
    } else {
      // payments/walletTopups (private) - never print the URL/key.
      console.log(`[OK]      ${label}: migrated to private R2`);
    }
  }

  console.log("\n--- Summary ---");
  console.log(`Checked:             ${result.totalChecked}`);
  console.log(`Already migrated:    ${result.alreadyMigratedCount} (skipped)`);
  console.log(`Out of scope:        ${result.outOfScopeCount} (skipped - not a Manus CloudFront URL)`);
  console.log(`Eligible:            ${result.eligibleCount}`);
  if (args.dryRun) {
    console.log(`Would migrate:       ${result.wouldMigrateCount}`);
  } else {
    console.log(`Migrated:            ${result.migratedCount}`);
  }
  console.log(`Failed:              ${result.failedCount}`);
  console.log(`Remaining:           ${result.remainingEligible}`);
  if (result.remainingEligible > 0) {
    console.log(
      `\nNot processed this run: ${result.remainingEligible} more eligible row(s) beyond --limit=${args.limit} - re-run with a higher --limit or a later --start-id to continue.`
    );
  }

  if (result.failedCount > 0) {
    console.log("\nFailed rows were left untouched in the DB and still point at the original Manus URL - safe to retry.");
  }
}

// Only auto-run when executed directly - not when imported as a module (e.g.
// to unit-test parseArgs above), so importing this file never has the side
// effect of kicking off a real migration run.
const isDirectExecution = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectExecution) {
  main().catch((error) => {
    console.error("\nMigration script crashed:", error?.message || error);
    process.exit(1);
  });
}
