/**
 * Derives strong identifiers from a stored historical row, for the backfill.
 *
 * Extracted from scripts/backfill-slip-claims.mjs so this decision - which
 * is purely a function of the persisted extractedData JSON plus a handful of
 * pure helper functions - can be unit tested without a database, mirroring
 * backfillRepresentation.mjs / backfillFileHashRecovery.mjs.
 *
 * CASING ORDER MATTERS. hashSlipReference is case-preserving, but
 * pre-migration rows stored only the OLD upper-cased `reference`; hashing
 * that produces a value a fresh mixed-case read can never match. So a stored
 * hash or referenceRaw is used when present, otherwise the stored rawText is
 * re-parsed with the LOCAL parser (recovering the original casing from the
 * OCR evidence), and only then the upper-cased field.
 *
 * ── legacy_uppercase evidence is NEVER exact authority ─────────────────────
 * When the ONLY surviving evidence is the old upper-cased `reference` field,
 * that value is LOSSY - the true original casing is unknown, and two
 * genuinely different case-sensitive references can fold to the same
 * upper-cased string. `deriveStrongIdentifiersFromExtractedData` (the
 * general-purpose derivation `direct` below) does not know this distinction
 * and simply hashes whatever reference field it finds - including this
 * lossy one - into `identifiers.referenceHash`, the same field an EXACT,
 * case-preserving claim uses.
 *
 * Returning that value as this row's `identifiers.referenceHash` would
 * manufacture EXACT ownership from evidence that only ever proves a FOLD: a
 * genuinely new transaction whose real (correctly-cased) reference merely
 * folds to the same upper-cased string would then be hard-blocked as a
 * proven duplicate of a row that may never have held that exact reference at
 * all. It must only ever encounter the advisory `legacyReferenceUpperHash`
 * ambiguity instead. So for this evidence class specifically,
 * `identifiers.referenceHash` is stripped; only a genuinely exact identifier
 * (fileHash / qrPayloadHash, both unaffected by casing) may still authorize
 * a claim for the row. If neither is present, the caller's existing
 * fileHash-recovery-or-unresolved path takes over, exactly as it already
 * does for a row with no identifier in extractedData at all.
 */

/**
 * @param {string | null | undefined} extractedDataJson
 * @param {{
 *   deriveStrongIdentifiersFromExtractedData: (json: string | null | undefined) => { identifiers: object, semanticFingerprint?: string },
 *   getRawReferenceForLegacyLookup: (json: string | null | undefined) => string | undefined,
 *   hashSlipReference: (raw: string | null | undefined) => string | undefined,
 *   hasStrongIdentifier: (identifiers: object) => boolean,
 *   extractSlipData: (rawText: string) => { referenceRaw?: string, reference?: string, semanticFingerprint?: string },
 * }} deps
 */
export function deriveIdentifiers(extractedDataJson, deps) {
  const {
    deriveStrongIdentifiersFromExtractedData,
    getRawReferenceForLegacyLookup,
    hashSlipReference,
    hasStrongIdentifier,
    extractSlipData,
  } = deps;

  const direct = deriveStrongIdentifiersFromExtractedData(extractedDataJson);

  let parsed;
  try {
    parsed = extractedDataJson ? JSON.parse(extractedDataJson) : null;
  } catch {
    parsed = null;
  }

  // The advisory legacy alias is ONLY for rows whose original casing is
  // unrecoverable - persisted with just an upper-cased `reference`, no
  // referenceRaw, no stored hash, no reparsable rawText. Those are the only
  // rows a mixed-case replay cannot be matched against by exact hash.
  //
  // It is deliberately NOT computed for every row: writing it where casing IS
  // recoverable would manufacture ambiguity that does not exist and drag
  // unrelated future payments into manual review.
  const rawReference = getRawReferenceForLegacyLookup(extractedDataJson);
  const aliasIfUnrecoverable = () =>
    rawReference ? hashSlipReference(rawReference.toUpperCase()) : undefined;

  const hasCasePreservingEvidence =
    (typeof parsed?.referenceHash === "string" && parsed.referenceHash.length === 64) ||
    Boolean(parsed?.referenceRaw);

  if (hasCasePreservingEvidence && hasStrongIdentifier(direct.identifiers)) {
    // Casing survived - no ambiguity, so no alias.
    return {
      ...direct,
      legacyReferenceUpperHash: undefined,
      referenceEvidence: parsed?.referenceHash ? "stored_hash" : "reference_raw",
      recoveredByReparse: false,
    };
  }

  const rawText = parsed?.rawText;
  if (typeof rawText === "string" && rawText.trim().length > 0) {
    try {
      const reExtracted = extractSlipData(rawText);
      const reHash = hashSlipReference(reExtracted.referenceRaw ?? reExtracted.reference);
      if (reHash) {
        // Reparsing recovered the TRUE casing, so this row is no longer
        // ambiguous and must not carry an alias.
        return {
          identifiers: { ...direct.identifiers, referenceHash: reHash },
          semanticFingerprint: direct.semanticFingerprint ?? reExtracted.semanticFingerprint,
          legacyReferenceUpperHash: undefined,
          referenceEvidence: "reparsed_raw_text",
          recoveredByReparse: true,
        };
      }
    } catch {
      // Fall through - a parser failure loses only the best-quality evidence.
    }
  }

  // Last resort: only the upper-cased legacy field survives. THIS is the
  // ambiguous case, and the ONLY one that receives an advisory alias.
  const isLegacyUppercaseOnly = Boolean(rawReference) && !hasCasePreservingEvidence;

  if (isLegacyUppercaseOnly) {
    // See module doc: referenceHash is stripped, never carried through from
    // `direct` - it would equal the same lossy value as the alias below.
    return {
      identifiers: { ...direct.identifiers, referenceHash: undefined },
      semanticFingerprint: direct.semanticFingerprint,
      legacyReferenceUpperHash: aliasIfUnrecoverable(),
      referenceEvidence: "legacy_uppercase",
      recoveredByReparse: false,
    };
  }

  return {
    ...direct,
    legacyReferenceUpperHash: undefined,
    referenceEvidence: "none",
    recoveredByReparse: false,
  };
}
