/**
 * IPE-001 P1: "Legacy uppercase must not become exact ownership"
 * (scripts/lib/backfillIdentifierDerivation.mjs).
 *
 * ── The bug ────────────────────────────────────────────────────────────────
 * For a historical row whose ONLY surviving reference evidence was the old
 * upper-cased `reference` field (referenceEvidence === "legacy_uppercase"),
 * `deriveIdentifiers` returned `identifiers.referenceHash` computed as
 * `hashSlipReference(parsed.reference)` - the SAME lossy, upper-cased value
 * as the advisory `legacyReferenceUpperHash` alongside it. The backfill then
 * claimed that value as EXACT, case-preserving reference authority
 * (`paymentSlipClaims.referenceHash`), even though the row's true original
 * casing was never actually known. A genuinely NEW transaction whose real
 * (correctly-cased) reference merely folds to the same upper-cased string
 * would then be hard-blocked as a proven duplicate of a row that may never
 * have held that exact reference at all.
 *
 * ── The fix ────────────────────────────────────────────────────────────────
 * For `legacy_uppercase` evidence, `identifiers.referenceHash` is stripped.
 * Only a genuinely exact identifier (fileHash/qrPayloadHash, unaffected by
 * casing) may still authorize a claim for the row; if none is present, the
 * backfill's existing fileHash-recovery-or-unresolved path takes over.
 */
import { describe, expect, it, vi } from "vitest";
import { deriveIdentifiers } from "../scripts/lib/backfillIdentifierDerivation.mjs";
import { recoverFileHashIdentifier } from "../scripts/lib/backfillFileHashRecovery.mjs";
import {
  deriveStrongIdentifiersFromExtractedData,
  getRawReferenceForLegacyLookup,
  hashSlipReference,
  hasStrongIdentifier,
} from "./services/slipIdentifierService";
import { extractSlipData } from "./ocr-slip-verification-v2";

const deps = {
  deriveStrongIdentifiersFromExtractedData,
  getRawReferenceForLegacyLookup,
  hashSlipReference,
  hasStrongIdentifier,
  extractSlipData,
};

const UPPER_REF = "ABC123DEF456";
const UPPER_HASH = hashSlipReference(UPPER_REF)!;

function fileRecoveryDeps(computeSlipFileHash: ReturnType<typeof vi.fn>) {
  return {
    computeSlipFileHash,
    computeTrustedLegacySlipFileHash: vi.fn(),
    isPrivateObjectRef: (raw: string | null | undefined) =>
      typeof raw === "string" && raw.startsWith("r2p:"),
    isTrustedLegacySlipUrl: () => false,
  };
}

describe("H. legacy_uppercase evidence: no exact referenceHash written from lossy evidence", () => {
  it("identifiers.referenceHash is undefined when only the upper-cased legacy field survives", () => {
    const json = JSON.stringify({ reference: UPPER_REF, amount: 100 });
    const derived = deriveIdentifiers(json, deps);

    expect(derived.referenceEvidence).toBe("legacy_uppercase");
    expect(derived.identifiers.referenceHash).toBeUndefined();
    expect(derived.legacyReferenceUpperHash).toBe(UPPER_HASH);
  });

  it("the stripped referenceHash is NOT silently equal to the advisory alias by accident - it is genuinely absent", () => {
    const json = JSON.stringify({ reference: UPPER_REF });
    const derived = deriveIdentifiers(json, deps);
    expect(Object.prototype.hasOwnProperty.call(derived.identifiers, "referenceHash")).toBe(true);
    expect(derived.identifiers.referenceHash).toBe(undefined);
  });

  it("a row with NO strong identifier after stripping correctly reports so", () => {
    const json = JSON.stringify({ reference: UPPER_REF });
    const derived = deriveIdentifiers(json, deps);
    expect(hasStrongIdentifier(derived.identifiers)).toBe(false);
  });

  it("discrimination target: hashing the raw uppercase reference directly must NOT equal identifiers.referenceHash", () => {
    // This is exactly the value the old buggy code carried through into the
    // exact claim field - proving it is genuinely gone, not just happening
    // to differ by construction of the test fixture.
    const json = JSON.stringify({ reference: UPPER_REF });
    const derived = deriveIdentifiers(json, deps);
    expect(derived.identifiers.referenceHash).not.toBe(hashSlipReference(UPPER_REF));
  });
});

describe("a genuinely new transaction is not hard-blocked by a lossy historical fold", () => {
  it("a fresh mixed-case reference that folds to the SAME uppercase value never collides via referenceHash", () => {
    // The historical row only ever proves the FOLD (ABC123def456 -> the
    // same uppercase string some other row also folds to), never the exact
    // original casing.
    const historicalJson = JSON.stringify({ reference: UPPER_REF });
    const historical = deriveIdentifiers(historicalJson, deps);

    // A brand-new transaction's real reference happens to be genuinely
    // different in casing.
    const freshMixedCase = "AbC123dEf456";
    const freshHash = hashSlipReference(freshMixedCase)!;

    // The historical row's claimable identifiers carry no referenceHash at
    // all, so an exact-match lookup against the fresh transaction's hash can
    // never find it there.
    expect(historical.identifiers.referenceHash).not.toBe(freshHash);
    expect(historical.identifiers.referenceHash).toBeUndefined();

    // The only avenue by which the fresh transaction could ever be linked to
    // this historical row is the ADVISORY alias - folding the fresh
    // reference's uppercase form and comparing against legacyReferenceUpperHash,
    // which is exactly the lossy, non-blocking ambiguity path.
    expect(hashSlipReference(freshMixedCase.toUpperCase())).toBe(historical.legacyReferenceUpperHash);
  });
});

describe("legacy_uppercase evidence alongside a genuine exact identifier", () => {
  it("a persisted fileHash survives untouched - it is unaffected by casing and may still authorize a claim normally", () => {
    const fileHash = "f".repeat(64);
    const json = JSON.stringify({ reference: UPPER_REF, fileHash });
    const derived = deriveIdentifiers(json, deps);

    expect(derived.referenceEvidence).toBe("legacy_uppercase");
    expect(derived.identifiers.referenceHash).toBeUndefined();
    expect(derived.identifiers.fileHash).toBe(fileHash);
    expect(derived.legacyReferenceUpperHash).toBe(UPPER_HASH);
    expect(hasStrongIdentifier(derived.identifiers)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════
// I/J: integration with the backfill's existing fileHash-recovery path,
// mirroring exactly what scripts/backfill-slip-claims.mjs's processRows does
// once deriveIdentifiers returns a row with no strong identifier.
// ════════════════════════════════════════════════════════════════════════

describe("I. legacy_uppercase with no persisted fileHash but a recoverable one: fileHash becomes exact authority, alias stays advisory", () => {
  it("recovery succeeds -> strong identifier is fileHash only, never the lossy reference", async () => {
    const json = JSON.stringify({ reference: UPPER_REF });
    const derived = deriveIdentifiers(json, deps);
    expect(hasStrongIdentifier(derived.identifiers)).toBe(false);

    const recoveredHash = "c".repeat(64);
    const computeSlipFileHash = vi.fn().mockResolvedValue(recoveredHash);
    const recovery = await recoverFileHashIdentifier({
      slipImageUrl: "r2p:payment-slips/legacy-row",
      ...fileRecoveryDeps(computeSlipFileHash),
    });

    expect(recovery.fileHash).toBe(recoveredHash);
    const finalIds = { ...derived.identifiers, fileHash: recovery.fileHash };
    expect(finalIds.referenceHash).toBeUndefined();
    expect(finalIds.fileHash).toBe(recoveredHash);
    expect(hasStrongIdentifier(finalIds)).toBe(true);
    // The advisory alias is unaffected by the recovery - still present,
    // still non-authoritative.
    expect(derived.legacyReferenceUpperHash).toBe(UPPER_HASH);
  });
});

describe("J. legacy_uppercase with no strong identifier recoverable at all: unresolved", () => {
  it("recovery fails -> still no strong identifier, row must be treated as unresolved (blocks completion)", async () => {
    const json = JSON.stringify({ reference: UPPER_REF });
    const derived = deriveIdentifiers(json, deps);
    expect(hasStrongIdentifier(derived.identifiers)).toBe(false);

    const computeSlipFileHash = vi.fn().mockResolvedValue(undefined);
    const recovery = await recoverFileHashIdentifier({
      slipImageUrl: "r2p:payment-slips/legacy-row",
      ...fileRecoveryDeps(computeSlipFileHash),
    });

    expect(recovery.fileHash).toBeUndefined();
    const finalIds = { ...derived.identifiers, ...(recovery.fileHash ? { fileHash: recovery.fileHash } : {}) };
    expect(hasStrongIdentifier(finalIds)).toBe(false);
  });

  it("no slipImageUrl at all -> unresolved without attempting recovery", async () => {
    const json = JSON.stringify({ reference: UPPER_REF });
    const derived = deriveIdentifiers(json, deps);

    const computeSlipFileHash = vi.fn();
    const recovery = await recoverFileHashIdentifier({
      slipImageUrl: null,
      ...fileRecoveryDeps(computeSlipFileHash),
    });

    expect(recovery.fileHash).toBeUndefined();
    expect(computeSlipFileHash).not.toHaveBeenCalled();
    expect(hasStrongIdentifier(derived.identifiers)).toBe(false);
  });
});

// ─── Recoverable-casing rows are unaffected (regression) ──────────────────

describe("rows whose casing IS recoverable are unaffected by this fix", () => {
  it("a stored referenceHash still authorizes an exact claim directly", () => {
    const stored = "d".repeat(64);
    const derived = deriveIdentifiers(JSON.stringify({ referenceHash: stored }), deps);
    expect(derived.identifiers.referenceHash).toBe(stored);
    expect(derived.legacyReferenceUpperHash).toBeUndefined();
    expect(derived.referenceEvidence).toBe("stored_hash");
  });

  it("a referenceRaw still authorizes an exact claim directly", () => {
    const mixed = "AbC123dEf456";
    const derived = deriveIdentifiers(
      JSON.stringify({ reference: mixed.toUpperCase(), referenceRaw: mixed }),
      deps
    );
    expect(derived.identifiers.referenceHash).toBe(hashSlipReference(mixed));
    expect(derived.legacyReferenceUpperHash).toBeUndefined();
    expect(derived.referenceEvidence).toBe("reference_raw");
  });

  it("reparsable rawText recovers the true casing and authorizes an exact claim", () => {
    const rawText = `ธนาคารกสิกรไทย\nเลขที่รายการ: 016234222922AQR05745\nจำนวน: 100.00 บาท`;
    const derived = deriveIdentifiers(
      JSON.stringify({ reference: "016234222922AQR05745", rawText }),
      deps
    );
    expect(derived.referenceEvidence).toBe("reparsed_raw_text");
    expect(derived.identifiers.referenceHash).toBe(hashSlipReference("016234222922AQR05745"));
    expect(derived.legacyReferenceUpperHash).toBeUndefined();
  });

  it("no reference evidence at all -> identifiers empty, no alias", () => {
    const derived = deriveIdentifiers(JSON.stringify({ amount: 100 }), deps);
    expect(derived.identifiers.referenceHash).toBeUndefined();
    expect(derived.legacyReferenceUpperHash).toBeUndefined();
    expect(derived.referenceEvidence).toBe("none");
  });
});
