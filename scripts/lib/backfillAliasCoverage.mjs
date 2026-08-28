/**
 * IPE-004-C06 P1: the required ADVISORY alias must be durably indexed for a
 * legacy_uppercase historical row NO MATTER which strong bucket that row
 * lands in.
 *
 * ── The gap this closes ───────────────────────────────────────────────────
 * `legacyReferenceUpperHash` is required coverage whenever derivation yields
 * `legacy_uppercase` evidence: the row's original reference casing is
 * unrecoverable, so a later mixed-case read of the SAME transaction can
 * never be matched by `referenceHash`, and only the indexed alias stops it
 * from being credited a second time after the O(N) scan retires.
 *
 * That was enforced only on the paths that end in a same-source claim
 * (`needs_alias`, `represented`, the stale-claim migration). Two buckets
 * escaped it entirely:
 *
 *   UNKNOWN-ONLY - a row with no strong identifier at all and no recoverable
 *   file bytes records `paymentSlipLegacyUnknown` and continues. Its
 *   `expectedAlias` was never persisted and `aliasUncovered` was never
 *   incremented, so `--mark-complete` happily retired the scan. A later
 *   submission presenting the case-preserving reference plus a fresh file
 *   hash then matched nothing - not the (empty) claim registry, and not the
 *   file-only unknown sufficiency check, which by design only fires for
 *   fileHash-ONLY submissions - and could create value again.
 *
 *   COLLISION - `classifyRepresentation` returns `kind: "collision"` before
 *   advisory alias coverage is ever evaluated, and the residual-axis claim
 *   only attaches the alias when `referenceHash` itself is among the
 *   inserted fields. A `legacy_uppercase` row has no case-preserving
 *   `referenceHash` by design, so a row whose file or QR axis collided kept
 *   its strong axes protected while its required alias was silently dropped.
 *
 * ── The rule ──────────────────────────────────────────────────────────────
 * The alias is ADVISORY and NON-UNIQUE - never ownership, never a claim on
 * an exact identifier. Two genuinely different case-sensitive references
 * legitimately fold to the same value, so a hit stops auto-approval for
 * manual review; it never proves a duplicate. Recording it therefore costs
 * nothing in correctness and is the only thing standing between a
 * permanently-unidentifiable historical row and a mixed-case replay.
 *
 * Decision order, given EVERY claim row this source owns (a source may own
 * more than one - see the residual/split claim rows from C04/C05):
 *
 *   1. any same-source claim already carries this exact alias -> covered.
 *      This is what makes reruns idempotent: no second row, no churn, no
 *      false "uncovered".
 *   2. some same-source claim has an EMPTY alias slot -> enrich that one in
 *      place. Reuses the existing claim rather than adding a row.
 *   3. no same-source claim exists at all -> insert an ALIAS-ONLY claim row
 *      (every exact identifier column left NULL). paymentSlipClaims has no
 *      unique constraint on (sourceType, sourceId) and the alias column is
 *      deliberately non-unique, so this is a supported shape. Crucially it
 *      fabricates NO exact coverage: an unknown-only row still owns no
 *      reference, file or QR hash, and is still correctly counted unknown on
 *      the file axis.
 *   4. every same-source claim already holds a DIFFERENT alias -> never
 *      guess. Overwriting could erase coverage for a fold that claim is
 *      currently protecting, so this is reported as an alias inconsistency
 *      for an operator to adjudicate, exactly as classifyRepresentation
 *      already does for the represented bucket. Completion stays refused.
 *
 * Pure logic, no I/O - the caller performs the read/write/verify.
 */

/**
 * @param {string | undefined} expectedAlias the alias this row REQUIRES;
 *   falsy for every row whose casing was recoverable (no coverage needed).
 * @param {Array<{ id: number, legacyReferenceUpperHash?: string | null }>} sameSourceClaims
 *   EVERY claim row owned by this source, not just the first.
 * @returns {{ action: "none" }
 *          | { action: "already_covered", claimId: number }
 *          | { action: "enrich", claimId: number }
 *          | { action: "insert_alias_only" }
 *          | { action: "inconsistent", claimId: number, existing: string }}
 */
export function decideAliasCoverage(expectedAlias, sameSourceClaims) {
  if (!expectedAlias) return { action: "none" };

  const claims = sameSourceClaims ?? [];

  const covered = claims.find((c) => c.legacyReferenceUpperHash === expectedAlias);
  if (covered) return { action: "already_covered", claimId: covered.id };

  const empty = claims.find(
    (c) => c.legacyReferenceUpperHash === null || c.legacyReferenceUpperHash === undefined
  );
  if (empty) return { action: "enrich", claimId: empty.id };

  if (claims.length === 0) return { action: "insert_alias_only" };

  // Every claim this source owns holds some OTHER alias. Never overwrite.
  const conflicting = claims[0];
  return {
    action: "inconsistent",
    claimId: conflicting.id,
    existing: conflicting.legacyReferenceUpperHash,
  };
}
