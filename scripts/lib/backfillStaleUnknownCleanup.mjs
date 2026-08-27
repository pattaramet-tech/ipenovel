/**
 * Clears a stale `paymentSlipLegacyUnknown` record for a row this run
 * resolved after all (its file identity became recoverable - a fresh claim
 * insert, `needs_strong_identifier` enrichment, or a stale-claim migration
 * that recovered its fileHash), and verifies the clear actually took.
 *
 * ── The bug this closes (IPE-004-C03) ─────────────────────────────────────
 * `clearStaleUnknownRow` was previously called from only ONE resolution
 * path (`registry.kind === "represented"`) and its failure was silently
 * swallowed - "best-effort, never a completion blocker" - because the row's
 * OWN classification had already succeeded via a different write. But that
 * reasoning misses the point: a `--mark-complete` flag asserts an EXACT
 * durable classification/provenance state (every row is protected,
 * collision, or unknown - never more than one, never a stale leftover). A
 * row that is now claimed/protected but STILL carries an unknown record
 * contradicts that assertion, even though the row's own coverage is fine.
 *
 * The fix: call this on EVERY successful file-axis resolution path, re-read
 * to CONFIRM the row is actually gone, and treat a failure to clear it as a
 * completion blocker - not a note.
 *
 * Pure logic, no direct DB access: `deleteRow` and `checkStillPresent` are
 * the only I/O, injected so this can be tested without a real database.
 */

/**
 * @param {{
 *   deleteRow: () => Promise<void>,
 *   checkStillPresent: () => Promise<boolean>,
 * }} input
 * @returns {Promise<{ cleared: boolean, error?: string }>}
 */
export async function clearAndVerifyStaleUnknownRow({ deleteRow, checkStillPresent }) {
  try {
    await deleteRow();
    const stillPresent = await checkStillPresent();
    if (stillPresent) {
      return { cleared: false, error: "row still present after delete" };
    }
    return { cleared: true };
  } catch (error) {
    return { cleared: false, error: error?.code ?? error?.message ?? "unknown" };
  }
}
