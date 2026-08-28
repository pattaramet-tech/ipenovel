/**
 * Decides whether a historical approved row is already fully covered by the
 * claim registry.
 *
 * ── The bug this replaces ─────────────────────────────────────────────────
 * "Represented" used to mean only: this source already owns every STRONG
 * identifier the row carries. On a database whose claim was written before
 * `legacyReferenceUpperHash` existed, a row whose original casing is
 * unrecoverable therefore counted as fully covered while its claim held no
 * alias at all. A clean rerun could then mark the backfill complete and
 * retire the historical scan - and a mixed-case replay of that reference
 * would match neither the upper-cased hash nor any alias, and could create
 * value again.
 *
 * ── The rule ──────────────────────────────────────────────────────────────
 * The alias is NOT a strong identifier - it can never be claimed, and two
 * historical rows may legitimately share one. It is REQUIRED ADVISORY
 * COVERAGE: when a row's reference evidence is `legacy_uppercase`, its
 * same-source claim must carry the expected alias before that row can be
 * considered protected.
 *
 * Extracted from the script so the matrix can be unit tested without a
 * database.
 */

export const STRONG_FIELDS = [
  ["reference", "referenceHash"],
  ["file", "fileHash"],
  ["qr", "qrPayloadHash"],
];

/**
 * @param ids               strong identifiers derived from the historical row
 * @param current           { sourceType, sourceId } of the historical row
 * @param claimRows         every claim matching any of those identifiers
 * @param expectedAliasHash the alias this row REQUIRES, or undefined when its
 *                          casing is recoverable and no alias is needed
 *
 * Returns one of:
 *   undefined                                   nothing matched; claimable
 *   { kind: "represented" }                     fully covered, alias included
 *   { kind: "needs_alias", claim, expected }    strong IDs covered, alias absent
 *   { kind: "needs_strong_identifier", claim, missing: [{ kind, field, value }] }
 *                                               same-source claim covered by at
 *                                               least one strong identifier, but
 *                                               missing one or more OTHER strong
 *                                               identifiers (reference / file /
 *                                               qr) this row carries, none of
 *                                               which is owned by anyone else -
 *                                               repairable by enriching the SAME
 *                                               claim in place
 *   { kind: "alias_inconsistent", claim, expected, existing }
 *   { kind: "collision", findings: [...], residual: [{ kind, field, value }] }
 *                                               `residual` (IPE-004-C05) lists
 *                                               every OTHER present strong
 *                                               identifier this row carries
 *                                               that is owned by NOBODY - not
 *                                               a foreign source (already in
 *                                               `findings`) and not this same
 *                                               source either (silently fine,
 *                                               omitted). A collision on ONE
 *                                               axis must never leave a
 *                                               present sibling axis
 *                                               unprotected; the caller must
 *                                               durably claim or fail every
 *                                               entry in `residual`. Empty on
 *                                               a rerun once those axes are
 *                                               already same-source-owned
 *                                               (e.g. via a split claim row
 *                                               from an earlier run) - never
 *                                               redundantly reported then.
 *
 * ── Why a missing sibling identifier is a repair, not a collision report ──
 * A row already owning its claim via ONE strong identifier, but whose
 * extractedData carried no value for another axis at the time an EARLIER
 * backfill run wrote the claim (or whose OCR could not recover it then), is
 * not a foreign or partial-ownership problem - nobody else owns that hash, it
 * simply was never captured. Reporting it as a generic "(unclaimed)"
 * collision would force manual review for something mechanically repairable,
 * and worse, a rerun that never repairs it would happily consider the row
 * "represented" via its other identifiers forever, silently leaving that axis
 * with no replay coverage at all - exactly the gap that let a same-image (or
 * same-reference) replay through when OCR could not recover the other axis.
 * So ANY strong identifier (reference, file or qr) that is unclaimed
 * ANYWHERE, while every OTHER present identifier this row carries is already
 * owned by THIS source, is classified as a repair, not a collision -
 * mirroring `needs_alias` below. The same hash claimed by a DIFFERENT source
 * is still a genuine collision. reference and qr are UNIQUE columns exactly
 * like fileHash, so the enrichment (UPDATE the same claim, re-read to
 * confirm, treat a duplicate-key rejection as a real collision) is identical
 * for all three - see the `needs_strong_identifier` handler in the script.
 */
export function classifyRepresentation(ids, current, claimRows, expectedAliasHash) {
  const present = STRONG_FIELDS.filter(([, field]) => Boolean(ids[field]));
  if (present.length === 0) return undefined;

  const rows = claimRows ?? [];
  if (rows.length === 0) return undefined;

  const findings = [];
  let sameSourceClaim;
  // Strong identifiers this row carries that are owned by NOBODY yet. Each is
  // only a genuine same-source repair if every OTHER present identifier
  // resolves to this same source - decided once the loop completes.
  const missingStrong = [];

  for (const [kind, field] of present) {
    const owner = rows.find((r) => r[field] && r[field] === ids[field]);

    if (!owner) {
      // Unclaimed anywhere. Deferred (reference, file AND qr alike): a
      // sibling identifier being claimed by THIS source makes this a
      // mechanical enrichment, not a "(unclaimed)" collision. If instead a
      // sibling turns out foreign-owned, the finding pushed below wins and
      // this becomes a collision after all.
      missingStrong.push({ kind, field, value: ids[field] });
      continue;
    }

    const sameSource =
      owner.sourceType === current.sourceType && owner.sourceId === current.sourceId;

    if (sameSource) {
      sameSourceClaim = owner;
    } else {
      findings.push({
        kind,
        identifier: `${String(ids[field]).slice(0, 12)}...`,
        hash: ids[field],
        first: `${owner.sourceType}#${owner.sourceId}`,
        second: `${current.sourceType}#${current.sourceId}`,
        firstSource: { sourceType: owner.sourceType, sourceId: owner.sourceId },
        secondSource: { sourceType: current.sourceType, sourceId: current.sourceId },
        detail: "claimed by a DIFFERENT source",
      });
    }
  }

  if (findings.length > 0) {
    // IPE-004-C05: a collision on one axis must not silently drop coverage
    // accounting for a SIBLING axis this row also carries but that nobody
    // (not a foreign source, not this same source) owns yet - `missingStrong`
    // already excludes both the just-recorded collision axes (they matched
    // an owner, so never entered `missingStrong`) and any axis already
    // resolved to `sameSourceClaim` above, so it is exactly the residual
    // coverage the caller must still durably claim or fail.
    return { kind: "collision", findings, residual: missingStrong };
  }

  if (missingStrong.length > 0) {
    if (!sameSourceClaim) {
      // No present identifier resolved to a same-source claim - this row is
      // not represented by anything yet; the normal insert path (which
      // carries every identifier `ids` holds) claims it fresh.
      return undefined;
    }
    return { kind: "needs_strong_identifier", claim: sameSourceClaim, missing: missingStrong };
  }

  // Strong coverage is complete. Now the ADVISORY coverage.
  if (!expectedAliasHash) return { kind: "represented" };

  const existing = sameSourceClaim?.legacyReferenceUpperHash ?? null;

  if (existing === expectedAliasHash) return { kind: "represented" };

  if (existing === null || existing === undefined) {
    // Repairable: the claim predates the alias column, or predates this rule.
    return { kind: "needs_alias", claim: sameSourceClaim, expected: expectedAliasHash };
  }

  // A DIFFERENT alias is already recorded for this source. Overwriting could
  // erase coverage for a fold this claim is currently protecting, so the tool
  // never guesses - an operator decides.
  return {
    kind: "alias_inconsistent",
    claim: sameSourceClaim,
    expected: expectedAliasHash,
    existing,
  };
}
