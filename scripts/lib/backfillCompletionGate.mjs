/**
 * Decides whether a backfill run may be marked COMPLETE.
 *
 * ── The incident this replaces (IPE-004) ──────────────────────────────────
 * The previous gate required `stats.noIdentifier === 0` and
 * `collisions.length === 0` before completion could ever be marked. A
 * production dry-run found 915 historical rows (out of 4,147) whose file
 * identity can NEVER be recovered (`no_slip_image_url` - the row has no slip
 * image URL at all, so its bytes are permanently gone) and 114 genuine
 * strong-identifier collisions among historical rows. Neither fact can ever
 * change no matter how many times the backfill re-runs, so the OLD gate could
 * never be satisfied - `--mark-complete` could never succeed, the legacy O(N)
 * historical scan stayed enabled FOREVER, and every new approval kept paying
 * its cost (and kept failing closed on rows that have nothing to do with it).
 *
 * ── The fix ────────────────────────────────────────────────────────────────
 * Completion no longer requires zero unresolved rows or zero collisions. It
 * requires every one of them to be DURABLY CLASSIFIED - a collision written
 * to paymentSlipLegacyCollisions, an unresolvable row written to
 * paymentSlipLegacyUnknown - so nothing is silently skipped. What still
 * blocks completion is a row landing in NONE of the three buckets (protected
 * / collision / unknown): a processing failure, an alias inconsistency an
 * operator must adjudicate by hand, or a durable-write failure for a
 * collision/unknown record that was supposed to succeed.
 *
 * Extracted as a pure function (no DB, no I/O) so the exact gate can be unit
 * tested against every combination directly.
 */

/**
 * @param {{
 *   failures: unknown[],
 *   aliasUncovered: number,
 *   aliasInconsistencies: unknown[],
 *   fileHashUncovered: number,
 *   staleClaimsUncovered: number,
 *   unknownRowsFailed: number,
 *   collisionMembersFailed: number,
 * }} stats
 * @param {{ payments: boolean, walletTopups: boolean }} reachedEof
 */
export function evaluateBackfillCompletion(stats, reachedEof) {
  const aliasCoverageComplete = stats.aliasUncovered === 0 && stats.aliasInconsistencies.length === 0;
  const fileHashCoverageComplete = stats.fileHashUncovered === 0;
  const staleClaimsCoverageComplete = stats.staleClaimsUncovered === 0;
  // Every UNRESOLVED row must have been durably recorded as "unknown" -
  // NOT that there were zero unresolved rows. A permanently unrecoverable
  // row (no_slip_image_url) can never satisfy "zero unresolved"; it CAN
  // always satisfy "durably classified as unknown".
  const unknownRowsClassified = stats.unknownRowsFailed === 0;
  // Every COLLISION finding must have been durably recorded - NOT that there
  // were zero collisions. Two historical rows sharing an identifier is a
  // permanent fact about financial history; it can be recorded, never erased.
  const collisionsClassified = stats.collisionMembersFailed === 0;

  const reasons = [];
  if (stats.failures.length > 0) reasons.push(`failures=${stats.failures.length}`);
  if (!aliasCoverageComplete) {
    reasons.push(
      `aliasUncovered=${stats.aliasUncovered} aliasInconsistencies=${stats.aliasInconsistencies.length}`
    );
  }
  if (!fileHashCoverageComplete) reasons.push(`fileHashUncovered=${stats.fileHashUncovered}`);
  if (!staleClaimsCoverageComplete) reasons.push(`staleClaimsUncovered=${stats.staleClaimsUncovered}`);
  if (!unknownRowsClassified) reasons.push(`unknownRowsFailed=${stats.unknownRowsFailed}`);
  if (!collisionsClassified) reasons.push(`collisionMembersFailed=${stats.collisionMembersFailed}`);
  if (!reachedEof.payments) reasons.push("paymentsEOF=false");
  if (!reachedEof.walletTopups) reasons.push("topupsEOF=false");

  const cleanRun =
    stats.failures.length === 0 &&
    aliasCoverageComplete &&
    fileHashCoverageComplete &&
    staleClaimsCoverageComplete &&
    unknownRowsClassified &&
    collisionsClassified &&
    reachedEof.payments &&
    reachedEof.walletTopups;

  return {
    cleanRun,
    aliasCoverageComplete,
    fileHashCoverageComplete,
    staleClaimsCoverageComplete,
    unknownRowsClassified,
    collisionsClassified,
    reasons,
  };
}
