/**
 * Detects and repairs a claim written by an OLDER backfill version that
 * stored lossy legacy-uppercase evidence as EXACT `referenceHash` ownership -
 * the bug `scripts/lib/backfillIdentifierDerivation.mjs` closed for new
 * backfill runs (IPE-001, round "legacy uppercase must not become exact
 * ownership"). That fix stops NEW runs from writing the bad value; it does
 * nothing for a bad value an OLD run already wrote and committed.
 *
 * ── The bug this closes ────────────────────────────────────────────────────
 * A stale claim's wrong exact `referenceHash` hard-blocks any future,
 * genuinely distinct transaction that happens to fold to the same
 * upper-cased value - forever, since nothing ever revisits it. Worse: once
 * current derivation correctly strips that value from `ids`, the stale claim
 * becomes invisible to the hash-based registry lookup entirely (it only
 * queries by values `ids` currently holds), so a rerun that recovers this
 * row's fileHash sees "nothing claimed" and INSERTs a SECOND claim for the
 * same source - two claims, one of them permanently wrong.
 *
 * ── Provenance, not a guess ─────────────────────────────────────────────────
 * `detectStaleReferenceClaim` only ever reports a match when TODAY's
 * derivation, run against this row's OWN stored `extractedData`, produces the
 * IDENTICAL lossy hash as the claim's stored `referenceHash`. That value
 * could only ever have come from this exact row's own upper-cased reference
 * field via the old buggy code path - a legitimate exact reference is
 * case-preserving and would hash to something else entirely. A claim whose
 * `referenceHash` does not match this exact value is left completely
 * untouched; this module never overwrites a genuine exact reference claim.
 *
 * ── What changes ──────────────────────────────────────────────────────────
 * `buildStaleReferenceMigrationPatch` migrates the SAME claim row in place -
 * the caller must never insert a second one for this source. The obsolete
 * exact `referenceHash` is cleared (it was never legitimate authority), the
 * required advisory alias is ensured, and a freshly recovered exact fileHash
 * is folded in ONLY into an empty slot - an existing fileHash already on the
 * claim is never overwritten by this repair.
 */

/**
 * @param {{ referenceHash?: string | null } | undefined} sameSourceClaim the
 *   one existing claim for this source, looked up by (sourceType, sourceId) -
 *   never by hash, since the value we are looking for has already been
 *   stripped from today's derived `ids`.
 * @param {string | undefined} expectedAlias the lossy alias hash TODAY's
 *   derivation computes for this row - truthy only for legacy_uppercase
 *   evidence (see deriveIdentifiers). Undefined for every other row: those
 *   rows have nothing for this module to migrate.
 * @returns the same claim object when it is provably the stale artifact,
 *   otherwise `undefined` - including when there is no claim at all, or the
 *   existing claim's referenceHash is a genuine, different exact value.
 */
export function detectStaleReferenceClaim(sameSourceClaim, expectedAlias) {
  if (!expectedAlias) return undefined;
  if (!sameSourceClaim) return undefined;
  if (sameSourceClaim.referenceHash !== expectedAlias) return undefined;
  return sameSourceClaim;
}

/**
 * @param {{ legacyReferenceUpperHash?: string | null, fileHash?: string | null }} staleClaim
 * @param {{ fileHash?: string }} ids this row's freshly derived identifiers -
 *   `ids.fileHash` may be undefined (recovery failed or was never needed).
 * @param {string} expectedAlias
 * @returns the exact UPDATE payload - always clears `referenceHash`; sets
 *   `legacyReferenceUpperHash` only when it does not already hold this exact
 *   value; sets `fileHash` only when the claim's own slot is empty AND a
 *   fresh one is available - it is never a place to overwrite an existing
 *   fileHash, which could silently discard a distinct, already-verified one.
 */
export function buildStaleReferenceMigrationPatch(staleClaim, ids, expectedAlias) {
  const patch = { referenceHash: null };

  if (staleClaim.legacyReferenceUpperHash !== expectedAlias) {
    patch.legacyReferenceUpperHash = expectedAlias;
  }

  if (!staleClaim.fileHash && ids.fileHash) {
    patch.fileHash = ids.fileHash;
  }

  return patch;
}
