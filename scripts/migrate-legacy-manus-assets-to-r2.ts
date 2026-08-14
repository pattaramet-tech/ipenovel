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
 * `migrate:legacy-manus-assets:dry` npm script (there is deliberately no
 * live npm script - see "PACKAGE.JSON" below). Not wired into any
 * install/build/deploy/db-migrate/startup path.
 *
 * See docs/LEGACY_MANUS_ASSET_MIGRATION.md for the full runbook.
 *
 * ─── MODE SELECTION: FAILS CLOSED, NO IMPLICIT LIVE MODE ────────────────
 * Exactly ONE of --dry-run or --live is REQUIRED on every invocation.
 * Neither flag, or both flags together, is rejected by parseArgs() before
 * any database or R2 access is even attempted - there is no default mode.
 *
 *   --dry-run    Preview only - downloads+validates each eligible row (and,
 *                for sports, optimizes it), but never uploads to R2 or
 *                writes to the DB. --type defaults to "all" and MAY be
 *                "all" here.
 *   --live       Writes to R2 and the DB. Requires an EXPLICIT
 *                --type=payments|wallet|sports - there is no default type
 *                for a live run, and --live --type=all is rejected outright
 *                (a live run always migrates exactly one asset class at a
 *                time - this also sidesteps the --type=all
 *                unrelated-id-space hazard documented under --start-id
 *                below).
 *
 * DRY RUN example:
 *   tsx scripts/migrate-legacy-manus-assets-to-r2.ts --dry-run --limit=20 --type=all
 *
 * LIVE example (one asset class, explicit --type, no --type=all):
 *   tsx scripts/migrate-legacy-manus-assets-to-r2.ts --live --limit=20 --type=payments
 *
 * INVALID (rejected before any DB/R2 access):
 *   tsx scripts/migrate-legacy-manus-assets-to-r2.ts                              # no mode flag
 *   tsx scripts/migrate-legacy-manus-assets-to-r2.ts --limit=20 --type=payments   # no mode flag
 *   tsx scripts/migrate-legacy-manus-assets-to-r2.ts --live --dry-run --type=payments  # both flags
 *   tsx scripts/migrate-legacy-manus-assets-to-r2.ts --live --type=all            # live + all
 *   tsx scripts/migrate-legacy-manus-assets-to-r2.ts --live                       # live, no --type
 *
 * Other flags:
 *   --limit=N       Max rows to actually process this run (default 20).
 *   --type=TYPE     "payments" | "wallet" | "sports" | "all" - see mode
 *                    selection above for when "all" is/isn't allowed.
 *   --start-id=N    Only rows with id >= N (default 0). This is a
 *                   LOWER-BOUND FILTER ONLY, never a resume cursor - see
 *                   "Resuming" below.
 *   --column=COL    sports-only: "home" | "away" | "cover". Omit to check
 *                    all three columns.
 *
 * Resuming: rerun the EXACT SAME command (same mode flag, same
 * --start-id, same --limit). A row that migrated successfully no longer
 * has the legacy Manus hostname, so it's automatically excluded ("already
 * migrated") on the next run, which naturally reveals the next batch of
 * still-eligible rows without any bookkeeping. Do NOT advance --start-id
 * based on the last-seen id or the "remaining" count - a single
 * sportsMatches row has THREE image columns (home/away/cover) that can
 * each independently still be pending after a --limit cutoff, --type=all
 * (dry-run only) draws from multiple tables whose ids are unrelated to
 * each other, and a row that FAILED (not migrated) keeps its original low
 * id forever. Advancing --start-id past any of these permanently skips
 * them. Only raise --start-id when you have independently verified every
 * row below it is either already migrated or intentionally out of scope -
 * see docs/LEGACY_MANUS_ASSET_MIGRATION.md.
 *
 * There is deliberately no --force flag - every row is re-classified fresh
 * on every run (a migrated row no longer has the legacy Manus hostname, so
 * it's naturally skipped on rerun).
 */
import { pathToFileURL } from "node:url";
import { safeErrorSummary } from "./lib/safeErrorSummary.mjs";
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

/**
 * Fails closed: exactly one of --dry-run / --live is required, and a live
 * run additionally requires an explicit, non-"all" --type. Every rejection
 * here throws synchronously, before this function returns and therefore
 * before main() ever calls runLegacyManusAssetMigrationBatch() - parseArgs
 * makes no DB/R2/network call of any kind, so a thrown Error here is
 * guaranteed to occur before any database or R2 access is even attempted.
 */
export function parseArgs(argv: string[]): CliArgs {
  let dryRunFlag = false;
  let liveFlag = false;
  let limit = 20;
  let type: LegacyManusAssetMigrationType = "all";
  let typeExplicitlySet = false;
  let startId = 0;
  let column: SportsColumn | undefined;

  for (const raw of argv) {
    if (raw === "--dry-run") {
      dryRunFlag = true;
    } else if (raw === "--live") {
      liveFlag = true;
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
      typeExplicitlySet = true;
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

  // Mode selection: fail closed. No implicit/default mode ever exists.
  if (dryRunFlag && liveFlag) {
    throw new Error(
      "Cannot pass both --dry-run and --live - exactly one mode flag is required, never both."
    );
  }
  if (!dryRunFlag && !liveFlag) {
    throw new Error(
      "No mode flag supplied - you must pass exactly one of --dry-run (preview only, no upload/DB write) or " +
        "--live (writes to R2 and the DB). There is no default/implicit mode."
    );
  }
  if (liveFlag) {
    if (!typeExplicitlySet) {
      throw new Error(
        "--live requires an explicit --type=payments|wallet|sports - there is no default type for a live run."
      );
    }
    if (type === "all") {
      throw new Error(
        "--live --type=all is not allowed - a live run must migrate exactly one asset class at a time " +
          "(--type=payments|wallet|sports). --type=all is only available with --dry-run."
      );
    }
  }

  if (column && type !== "sports" && type !== "all") {
    throw new Error(`--column is only valid with --type=sports or --type=all (got --type=${type})`);
  }

  return { dryRun: dryRunFlag, limit, type, startId, column };
}

/**
 * Exported for direct testing that argument-validation rejections happen
 * BEFORE runLegacyManusAssetMigrationBatch() (and therefore before any
 * DB/R2 access) is ever called - see server/legacyManusAssetMigrationCli.
 * test.ts, which mocks the service module and asserts it's untouched for
 * every invalid mode-flag combination.
 */
export async function main(): Promise<void> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    // A deliberate, developer-authored usage-validation error - already
    // safe to print as-is (never derived from a DB/driver response, never
    // touches process.env), so it's printed directly rather than through
    // reportCliCrash()'s sanitizer (reserved for genuinely unexpected/
    // opaque failures below). parseArgs() makes no DB/R2/network call, so
    // reaching this catch block means this script refused before any
    // database or R2 access was even attempted.
    console.error(`\n${error instanceof Error ? error.message : String(error)}`);
    console.error("\nRun with --dry-run to preview, or --live --type=payments|wallet|sports to write.");
    process.exit(1);
    return;
  }

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
      `\nNot processed this run: ${result.remainingEligible} more eligible row(s) beyond --limit=${args.limit}. ` +
        `To continue, re-run this EXACT SAME command (same --start-id=${args.startId}) - already-migrated rows are ` +
        "automatically skipped, so the same command naturally picks up where this run left off. Do not advance " +
        "--start-id: a single sports match can have more than one pending column, --type=all spans tables with " +
        "unrelated ids, and a failed row keeps its original id - advancing --start-id past any of them would skip " +
        "them permanently. Alternatively, increase --limit to process more rows in one run."
    );
  }

  if (result.failedCount > 0) {
    console.log("\nFailed rows were left untouched in the DB and still point at the original Manus URL - safe to retry.");
  }
}

/**
 * Top-level crash handler for an UNEXPECTED failure (anything main() itself
 * doesn't already turn into a clean, pre-sanitized message - see the
 * LegacyManusAssetMigrationConfigError/LegacyManusAssetMigrationLockError
 * handling inside main()). A raw DB/network/driver error's `.message` can
 * embed a connection string, credentials, or a full request URL (drizzle in
 * particular echoes bound SQL parameters) - safeErrorSummary() is the same
 * sanitizer server/db.ts and server/_core/trpc.ts already use for exactly
 * this reason, so this is the only place in the whole script a raw
 * `error.message` is ever allowed to reach the console. Exported so its
 * sanitization behavior is directly testable without needing a real crash.
 */
export function reportCliCrash(error: unknown): void {
  console.error("\nMigration script crashed:", safeErrorSummary(error));
  process.exit(1);
}

// Only auto-run when executed directly - not when imported as a module (e.g.
// to unit-test parseArgs above), so importing this file never has the side
// effect of kicking off a real migration run.
const isDirectExecution = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectExecution) {
  main().catch(reportCliCrash);
}
