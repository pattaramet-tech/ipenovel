/**
 * CLI option parsing for scripts/backfill-slip-claims.mjs.
 *
 * Extracted so it can be unit tested without opening DATABASE_URL or touching
 * a database - the previous inline parsing shipped a version that referenced
 * an undeclared `pageSize`, which meant BOTH dry-run and live mode threw on
 * the first page query and no backfill was possible at all. A pure,
 * directly-testable parser makes that class of regression visible.
 *
 * Page size bounds MEMORY only. It is never a cap on how many rows are
 * scanned: the caller pages until both sources are exhausted.
 */

export const DEFAULT_PAGE_SIZE = 500;
export const MAX_PAGE_SIZE = 5000;

export class BackfillOptionError extends Error {
  constructor(message) {
    super(message);
    this.name = "BackfillOptionError";
  }
}

/**
 * Parses `--page-size`.
 *
 * An operator who explicitly passes a value gets an explicit answer: an
 * invalid one is REJECTED rather than silently replaced by the default,
 * because quietly substituting 500 for a typo'd `--page-size 0` would hide
 * the mistake behind a run that looks fine.
 */
export function parsePageSize(args) {
  const idx = args.indexOf("--page-size");
  if (idx === -1) return DEFAULT_PAGE_SIZE;

  const raw = args[idx + 1];
  if (raw === undefined || raw.startsWith("--")) {
    throw new BackfillOptionError("--page-size requires a value, e.g. --page-size 500");
  }

  // Number() would accept "500abc" as NaN but also " 500 " and "5e2"; a strict
  // digit check keeps the accepted set obvious.
  if (!/^\d+$/.test(raw)) {
    throw new BackfillOptionError(`--page-size must be a positive integer, got: ${raw}`);
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new BackfillOptionError(`--page-size must be a finite integer, got: ${raw}`);
  }
  if (value <= 0) {
    throw new BackfillOptionError(`--page-size must be greater than 0, got: ${raw}`);
  }
  if (value > MAX_PAGE_SIZE) {
    throw new BackfillOptionError(
      `--page-size must be <= ${MAX_PAGE_SIZE}, got: ${raw}. This bounds memory per page; ` +
        `it does not limit how many rows are scanned.`
    );
  }

  return value;
}

/**
 * Full option set.
 *
 * `--mark-complete` requires `--live`: a dry run inspects, it never asserts
 * that history is now protected. Allowing it on a dry run would let an
 * operator disable the legacy safety scan without ever having written a
 * single claim.
 */
export function parseBackfillOptions(args) {
  const has = (flag) => args.includes(flag);

  const isLive = has("--live");
  const isDryRun = has("--dry-run");
  const markComplete = has("--mark-complete");

  if (isLive && isDryRun) {
    throw new BackfillOptionError("--dry-run and --live are mutually exclusive.");
  }

  if (markComplete && !isLive) {
    throw new BackfillOptionError(
      "--mark-complete requires --live. A dry run never marks the backfill complete."
    );
  }

  return {
    // Dry-run is the DEFAULT: writing requires an explicit --live.
    isLive,
    isDryRun: !isLive,
    markComplete,
    pageSize: parsePageSize(args),
    allowProductionLookingUrl: has("--i-understand-this-is-not-production"),
  };
}
