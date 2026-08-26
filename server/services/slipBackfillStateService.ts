/**
 * Durable "has the claim backfill finished?" switch.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 * The legacy compatibility scan is a TEMPORARY correctness fallback for rows
 * approved before paymentSlipClaims existed. While it is enabled, every new
 * unique slip pages through every approved order payment AND every approved
 * wallet top-up before inserting its claim - inside the financial
 * transaction. That is O(N) per approval, grows forever, and holds the
 * transaction open across the whole scan.
 *
 * Once the backfill has demonstrably written a claim for every historical
 * approval, the UNIQUE registry alone is sufficient and the scan is pure
 * waste. This module records that fact.
 *
 * ── Why the `settings` table ──────────────────────────────────────────────
 * The repo already has a durable, DB-backed key/value store (drizzle
 * `settings`, with getSetting/setSetting). Reusing it satisfies the hard
 * requirement that completion survive a restart, and avoids amending
 * migration 0037 or adding a table for a single boolean plus provenance.
 *
 * The state MUST come from the database. Process memory, an env var, a local
 * file, a client flag or a constant would all either forget completion on
 * restart or let a non-operator flip a financial safety control.
 *
 * ── Failing safe ──────────────────────────────────────────────────────────
 * Every ambiguity resolves to NOT complete, which means the scan stays on.
 * An unreadable database, a malformed value, a missing row: all keep the
 * slower but correct behavior. The only way to disable the scan is an
 * explicit, well-formed completion record.
 */

import { getSetting, setSetting } from "../db";

export const SLIP_BACKFILL_STATE_KEY = "paymentSlipClaims.backfillState";

export interface SlipBackfillState {
  /** True only when a live backfill ran to completion with no failures. */
  complete: boolean;
  /** ISO timestamp of completion, for operator audit. */
  completedAt?: string;
  /** Which tool version wrote it, so a future format change is detectable. */
  toolVersion?: string;
  /** Highest ids covered, so a later audit can see what was in scope. */
  paymentMaxId?: number;
  walletTopupMaxId?: number;
  /** Counters from the completing run, for the record. */
  claimsInserted?: number;
}

const INCOMPLETE: SlipBackfillState = { complete: false };

/**
 * Reads the durable state.
 *
 * Never throws: a read failure is reported as NOT complete so the caller
 * keeps the safe (scanning) behavior rather than silently skipping the
 * historical check because the database hiccuped.
 */
export async function getSlipBackfillState(): Promise<SlipBackfillState> {
  try {
    const row = await getSetting(SLIP_BACKFILL_STATE_KEY);
    if (!row?.value) return INCOMPLETE;

    const parsed = JSON.parse(row.value);
    if (!parsed || typeof parsed !== "object") return INCOMPLETE;

    // Only an explicit boolean true counts. A truthy string, a 1, or a
    // partially-written object all mean "not proven complete".
    if (parsed.complete !== true) return INCOMPLETE;

    return {
      complete: true,
      completedAt: typeof parsed.completedAt === "string" ? parsed.completedAt : undefined,
      toolVersion: typeof parsed.toolVersion === "string" ? parsed.toolVersion : undefined,
      paymentMaxId: Number.isInteger(parsed.paymentMaxId) ? parsed.paymentMaxId : undefined,
      walletTopupMaxId: Number.isInteger(parsed.walletTopupMaxId)
        ? parsed.walletTopupMaxId
        : undefined,
      claimsInserted: Number.isInteger(parsed.claimsInserted) ? parsed.claimsInserted : undefined,
    };
  } catch {
    return INCOMPLETE;
  }
}

/**
 * True when the legacy historical scan must still run.
 *
 * This is the single question the claim path asks. Phrased positively around
 * the SAFE outcome so that every failure mode above returns `true`.
 */
export async function isLegacyScanRequired(): Promise<boolean> {
  const state = await getSlipBackfillState();
  return !state.complete;
}

/**
 * Records completion. Only the backfill tool calls this, and only after a
 * fully successful live run - see the guards in the CLI, which refuse to mark
 * complete on a dry run, after any failure, or with unresolved collisions.
 *
 * ── Concurrency note ──────────────────────────────────────────────────────
 * There is no window in which a slip is unprotected. Any approval running
 * under this code - before, during, or after the backfill - already inserts
 * its own paymentSlipClaims row atomically as part of its financial
 * transaction. So the registry covers every NEW approval regardless of
 * backfill progress, and the backfill only adds rows for OLD approvals that
 * predate the registry. Flipping this switch therefore removes a redundant
 * scan, not a live protection.
 *
 * The backfill deliberately does not hold one transaction over the whole run;
 * it commits page by page, so a crash mid-run leaves the state incomplete and
 * the scan enabled, which is the safe direction.
 */
export async function markSlipBackfillComplete(details: {
  toolVersion: string;
  paymentMaxId?: number;
  walletTopupMaxId?: number;
  claimsInserted?: number;
}): Promise<void> {
  const state: SlipBackfillState = {
    complete: true,
    completedAt: new Date().toISOString(),
    toolVersion: details.toolVersion,
    paymentMaxId: details.paymentMaxId,
    walletTopupMaxId: details.walletTopupMaxId,
    claimsInserted: details.claimsInserted,
  };

  await setSetting(
    SLIP_BACKFILL_STATE_KEY,
    JSON.stringify(state),
    "Set by scripts/backfill-slip-claims.mjs --live --mark-complete. When complete, " +
      "the legacy historical replay scan is skipped and paymentSlipClaims is the sole " +
      "authority. Delete or set complete=false to re-enable the scan."
  );
}

/**
 * Clears completion, re-enabling the scan. Provided so an operator can revert
 * without hand-editing JSON if a backfill is later found to be incomplete.
 */
export async function clearSlipBackfillComplete(): Promise<void> {
  await setSetting(
    SLIP_BACKFILL_STATE_KEY,
    JSON.stringify({ complete: false, clearedAt: new Date().toISOString() }),
    "Legacy historical replay scan re-enabled."
  );
}
