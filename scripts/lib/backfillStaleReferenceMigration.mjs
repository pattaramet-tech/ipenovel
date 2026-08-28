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
 * `detectStaleReferenceClaims` only ever reports a match when TODAY's
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
 * @param {Array<{ referenceHash?: string | null }> | undefined} sameSourceClaims
 *   EVERY claim row this source owns, looked up by (sourceType, sourceId) -
 *   never by hash, since the value we are looking for has already been
 *   stripped from today's derived `ids`.
 * @param {string | undefined} expectedAlias the lossy alias hash TODAY's
 *   derivation computes for this row - truthy only for legacy_uppercase
 *   evidence (see deriveIdentifiers). Undefined for every other row: those
 *   rows have nothing for this module to migrate.
 * @returns EVERY claim row that is provably the stale artifact - an empty
 *   array when there is none, including when the source owns claims whose
 *   referenceHash is a genuine, different exact value.
 *
 * IPE-004-C08 P2: this deliberately inspects ALL same-source rows rather
 * than one. A source can legitimately own several claim rows (the C04/C05
 * residual-axis rows, and the C06 alias-only row), and the previous
 * single-row lookup read ONE of them in unspecified order. A residual or
 * alias-only row returned first made stale detection answer
 * "nothing stale here" while the obsolete lossy exact `referenceHash` sat
 * untouched on a sibling row - surviving the rerun AND letting
 * --mark-complete pass. Order must never decide whether a replay hole is
 * found, so every row is examined.
 *
 * `paymentSlipClaims.referenceHash` is UNIQUE, so a healthy database can
 * hold at most one row per value; the array return is what keeps this
 * honest on a database where that index is missing or was dropped, instead
 * of silently repairing one row and declaring the source clean.
 */
export function detectStaleReferenceClaims(sameSourceClaims, expectedAlias) {
  if (!expectedAlias) return [];
  if (!Array.isArray(sameSourceClaims)) return [];
  return sameSourceClaims.filter(
    (claim) => claim && claim.referenceHash === expectedAlias
  );
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

/**
 * Turns every stale claim this source owns into the ordered list of in-place
 * UPDATEs that repairs them - one entry per stale row, each with its own
 * patch.
 *
 * The one thing this adds over calling `buildStaleReferenceMigrationPatch`
 * per row: the freshly recovered `ids.fileHash` is offered to AT MOST ONE
 * row. `paymentSlipClaims.fileHash` is UNIQUE, so writing the same recovered
 * hash into two rows of the SAME source would raise ER_DUP_ENTRY on the
 * second - which the caller's duplicate-key handler would then record as a
 * genuine file-axis collision between this source and itself, fabricating a
 * finding out of nothing and needlessly blocking that hash. The hash is
 * therefore consumed by the first row that can take it (or by a row that
 * already holds it), and every later row gets a fileHash-free patch that
 * still clears the obsolete exact `referenceHash` and ensures the alias.
 *
 * @param {Array<{ legacyReferenceUpperHash?: string | null, fileHash?: string | null }>} staleClaims
 * @param {{ fileHash?: string }} ids
 * @param {string} expectedAlias
 * @returns {Array<{ claim: object, patch: object }>} in the same order as
 *   `staleClaims`.
 */
export function planStaleReferenceMigrations(staleClaims, ids, expectedAlias) {
  let unclaimedFileHash = ids?.fileHash;
  const plans = [];

  for (const claim of staleClaims ?? []) {
    const patch = buildStaleReferenceMigrationPatch(
      claim,
      unclaimedFileHash ? { fileHash: unclaimedFileHash } : {},
      expectedAlias
    );
    // Consumed either by this patch, or by a row that already owns exactly
    // this hash - both mean no LATER row may write it again.
    if (unclaimedFileHash && (patch.fileHash || claim.fileHash === unclaimedFileHash)) {
      unclaimedFileHash = undefined;
    }
    plans.push({ claim, patch });
  }

  return plans;
}

/**
 * The post-repair PROOF, as a pure decision (IPE-004-C08 P2 acceptance H).
 *
 * A repair that "succeeded" per row is not the same as a source that no
 * longer holds obsolete lossy exact ownership. After repairing, the caller
 * re-reads every claim the source owns and hands the result here; this
 * decides whether that read actually proves the source clean.
 *
 * Three outcomes, and only one of them is "clean":
 *  - The read came back SATURATED (as many rows as the bound allows). Rows
 *    beyond the bound were never examined, so this read cannot speak for
 *    them. Unproven is not clean - it is reported uncovered.
 *  - Some row still carries `referenceHash === expectedAlias`. The replay
 *    hole is still open; rows the per-claim repair ALREADY counted as
 *    uncovered are excluded so one failure is never counted twice, but any
 *    row not already accounted for is reported now.
 *  - Nothing stale remains within a non-saturated read: clean, uncovered 0.
 *
 * @param {{ afterClaims?: Array<{ id?: number, referenceHash?: string | null }>,
 *           expectedAlias?: string,
 *           failedClaimIds?: Set<number> | Array<number>,
 *           readLimit: number }} input
 * @returns {{ uncovered: number, error?: string }}
 */
export function evaluateStaleRepairOutcome({
  afterClaims,
  expectedAlias,
  failedClaimIds,
  readLimit,
}) {
  const rows = Array.isArray(afterClaims) ? afterClaims : [];

  if (rows.length >= readLimit) {
    return {
      uncovered: 1,
      error: "same-source claim read hit its bound - stale ownership unproven",
    };
  }

  const alreadyCounted =
    failedClaimIds instanceof Set ? failedClaimIds : new Set(failedClaimIds ?? []);
  const unaccounted = detectStaleReferenceClaims(rows, expectedAlias).filter(
    (claim) => !alreadyCounted.has(claim.id)
  );

  if (unaccounted.length === 0) return { uncovered: 0 };

  return {
    uncovered: unaccounted.length,
    error: `${unaccounted.length} same-source claim(s) still hold the obsolete lossy referenceHash`,
  };
}
