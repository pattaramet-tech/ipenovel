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
 *   { kind: "needs_file_hash", claim, expected } same-source claim covered by
 *                                                 another strong identifier,
 *                                                 but is missing this row's
 *                                                 exact fileHash - repairable
 *   { kind: "alias_inconsistent", claim, expected, existing }
 *   { kind: "collision", findings: [...] }
 *
 * ── Why fileHash gets its own repair path, not a collision report ─────────
 * A row already owning its claim via referenceHash/qrPayloadHash, but whose
 * extractedData carried no fileHash at the time an EARLIER backfill run
 * wrote the claim, is not a foreign or partial-ownership problem - nobody
 * else owns that fileHash, it simply was never captured. Reporting it as a
 * generic "(unclaimed)" collision would force manual review for something
 * mechanically repairable, and worse, a rerun that never repairs it would
 * happily consider the row "represented" via its other identifiers forever,
 * silently leaving the file axis with no replay coverage at all - exactly
 * the gap that let a same-image replay through when OCR could not recover a
 * reference. So a fileHash that is unclaimed ANYWHERE, while every OTHER
 * present identifier this row carries is already owned by THIS source, is
 * classified as a repair, not a collision - mirroring `needs_alias` below.
 * A fileHash claimed by a DIFFERENT source is still a genuine collision.
 */
export function classifyRepresentation(ids, current, claimRows, expectedAliasHash) {
  const present = STRONG_FIELDS.filter(([, field]) => Boolean(ids[field]));
  if (present.length === 0) return undefined;

  const rows = claimRows ?? [];
  if (rows.length === 0) return undefined;

  const findings = [];
  let sameSourceClaim;
  let missingFileHashOnSameSource = false;

  for (const [kind, field] of present) {
    const owner = rows.find((r) => r[field] && r[field] === ids[field]);

    if (!owner) {
      if (field === "fileHash") {
        // Deferred: only a genuine repair if every OTHER present identifier
        // resolves to this same source - decided once the loop completes.
        missingFileHashOnSameSource = true;
        continue;
      }
      // This identifier is NOT in the registry while a sibling identifier is.
      // Marking the row represented here would leave this hash unclaimed.
      findings.push({
        kind,
        identifier: `${String(ids[field]).slice(0, 12)}...`,
        first: "(unclaimed)",
        second: `${current.sourceType}#${current.sourceId}`,
        detail: "partial: a sibling identifier is claimed but this one is not",
      });
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
        first: `${owner.sourceType}#${owner.sourceId}`,
        second: `${current.sourceType}#${current.sourceId}`,
        detail: "claimed by a DIFFERENT source",
      });
    }
  }

  if (findings.length > 0) {
    return { kind: "collision", findings };
  }

  if (missingFileHashOnSameSource) {
    if (!sameSourceClaim) {
      // No other present identifier resolved to a same-source claim either -
      // this row is not represented by anything yet; the normal insert path
      // (which already carries fileHash) claims it fresh.
      return undefined;
    }
    return { kind: "needs_file_hash", claim: sameSourceClaim, expected: ids.fileHash };
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
