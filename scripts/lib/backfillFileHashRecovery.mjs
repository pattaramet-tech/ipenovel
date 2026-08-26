/**
 * Recovers a strong identifier for an approved historical row whose stored
 * `extractedData` carries none - either because it is NULL entirely (older
 * OCR-disabled / manual-approval flows never wrote it) or because whatever
 * was stored has no reference, file, or QR hash.
 *
 * ── The bug this closes ────────────────────────────────────────────────────
 * The backfill's scan predicate used to require `extractedData IS NOT NULL`,
 * so a legacy approved row with no extraction was invisible to the tool
 * entirely - it was never scanned, never claimed, and the run could still
 * reach EOF and be marked complete while that value-creating slip had no
 * registry protection at all.
 *
 * ── Never trust anything but the row's own stored bytes ────────────────────
 * The only identifier this module can produce is a fileHash, and only from
 * the EXACT bytes already sitting in the private bucket at this row's own
 * `slipImageUrl` - recomputed server-side through the same production
 * primitive new submissions and Recheck use (`computeSlipFileHash`,
 * server/services/slipFileHashService.ts). It never accepts a client hash,
 * the URL text itself, a filename, an object key, or a weak semantic
 * fingerprint - none of those survive a re-encode or prove file identity.
 *
 * `computeSlipFileHash` itself never throws and returns `undefined` on any
 * failure (not a private ref, signed-URL failure, fetch failure/timeout,
 * oversized body, empty body) - this module simply classifies that outcome.
 */

export const UNRESOLVED_NO_SLIP_URL = "no_slip_image_url";
export const UNRESOLVED_HASH_RECOVERY_FAILED = "file_hash_recovery_failed";

/**
 * @param {{ slipImageUrl?: string | null, computeSlipFileHash: (raw: string | null | undefined) => Promise<string | undefined> }} input
 * @returns {Promise<{ fileHash?: string, unresolvedReason?: string }>}
 */
export async function recoverFileHashIdentifier({ slipImageUrl, computeSlipFileHash }) {
  if (!slipImageUrl) {
    return { fileHash: undefined, unresolvedReason: UNRESOLVED_NO_SLIP_URL };
  }

  const fileHash = await computeSlipFileHash(slipImageUrl);
  if (!fileHash) {
    return { fileHash: undefined, unresolvedReason: UNRESOLVED_HASH_RECOVERY_FAILED };
  }

  return { fileHash, unresolvedReason: undefined };
}
