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
 *   { kind: "alias_inconsistent", claim, expected, existing }
 *   { kind: "collision", findings: [...] }
 */
export function classifyRepresentation(ids, current, claimRows, expectedAliasHash) {
  const present = STRONG_FIELDS.filter(([, field]) => Boolean(ids[field]));
  if (present.length === 0) return undefined;

  const rows = claimRows ?? [];
  if (rows.length === 0) return undefined;

  const findings = [];
  let ownedByThisSourceCount = 0;
  let sameSourceClaim;

  for (const [kind, field] of present) {
    const owner = rows.find((r) => r[field] && r[field] === ids[field]);

    if (!owner) {
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
      ownedByThisSourceCount += 1;
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

  if (findings.length > 0 || ownedByThisSourceCount !== present.length) {
    return { kind: "collision", findings };
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
