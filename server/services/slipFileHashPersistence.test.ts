import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  deriveStrongIdentifiersFromExtractedData,
  hasStrongIdentifier,
} from "./slipIdentifierService";
import { hashSlipBytes } from "./slipFileHashService";

/**
 * P1: the exact-file identifier must survive OCR being bypassed or failing.
 *
 * Manual approval now REFUSES a record with no strong identifier. So if a
 * submission path fails to persist the server-derived fileHash - because OCR
 * was disabled, the provider broke, or image preparation failed - that record
 * becomes permanently unapprovable. These tests pin every such path.
 *
 * Structural assertions are used for the persistence wiring because the
 * guarantee is that a specific value reaches a specific write; a behavioral
 * test would need a live database, which this sandbox does not have. The
 * derivation half is asserted behaviorally below.
 */

function readCode(relativePath: string): string {
  return fs
    .readFileSync(path.resolve(process.cwd(), relativePath), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

describe("ORDER path persists the file identifier on every outcome", () => {
  const code = readCode("server/services/slipSubmissionService.ts");

  it("computes the hash BEFORE the OCR-enabled check", () => {
    const hashIdx = code.indexOf("computeSlipFileHash(input.slipImageUrl)");
    const ocrIdx = code.indexOf("if (ocrEnabled)");
    expect(hashIdx).toBeGreaterThan(-1);
    expect(ocrIdx).toBeGreaterThan(-1);
    expect(hashIdx).toBeLessThan(ocrIdx);
  });

  it("OCR DISABLED still stores { fileHash } rather than null", () => {
    const idx = code.indexOf('reviewReason: "OCR_DISABLED"');
    expect(idx).toBeGreaterThan(-1);
    const block = code.slice(idx, idx + 500);
    expect(block).toMatch(/extractedData: slipFileHash \? \{ fileHash: slipFileHash \} : null/);
    expect(block).not.toMatch(/extractedData: null,/);
  });

  it("a provider technical failure still stores { fileHash }", () => {
    // Both the inline technicalError branch and the outer catch.
    const occurrences = code.match(
      /extractedData: slipFileHash \? \{ fileHash: slipFileHash \} : null/g
    );
    expect(occurrences?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it("attaches the hash even when staging produced no extraction at all", () => {
    // The guard is on slipFileHash alone, not on extractedData being present.
    expect(code).toMatch(/if \(slipFileHash\) \{\s*\n\s*verificationResult\.extractedData = \{/);
    expect(code).toMatch(/\.\.\.\(verificationResult\.extractedData \?\? \{\}\)/);
  });

  it("never reads a hash from client input", () => {
    expect(code).not.toMatch(/input\.fileHash/);
    expect(code).toMatch(/computeSlipFileHash\(input\.slipImageUrl\)/);
  });
});

describe("WALLET path persists the file identifier on every outcome", () => {
  const code = readCode("server/services/walletTopupSubmissionService.ts");

  it("computes the hash BEFORE the OCR-disabled early return", () => {
    const hashIdx = code.indexOf("computeSlipFileHash(slipImageUrl)");
    const disabledIdx = code.indexOf("if (!ocrConfig.enabled)");
    expect(hashIdx).toBeGreaterThan(-1);
    expect(disabledIdx).toBeGreaterThan(-1);
    // This ordering is the whole fix: the early return used to happen first.
    expect(hashIdx).toBeLessThan(disabledIdx);
  });

  it("is computed outside the try block, so a throw cannot skip it", () => {
    const hashIdx = code.indexOf("computeSlipFileHash(slipImageUrl)");
    const tryIdx = code.indexOf("\n  try {");
    expect(hashIdx).toBeLessThan(tryIdx);
  });

  it("OCR DISABLED passes the file identifier into the review record", () => {
    const idx = code.indexOf('"OCR_DISABLED"');
    const block = code.slice(idx, idx + 400);
    expect(block).toMatch(/fileHashOnlyExtraction/);
  });

  it("SHADOW MODE passes the file identifier too", () => {
    const idx = code.indexOf('"SHADOW_MODE"');
    const block = code.slice(idx, idx + 400);
    expect(block).toMatch(/fileHashOnlyExtraction/);
  });

  it("both technical-failure returns pass the file identifier", () => {
    const matches = code.match(/handleOCRError\([\s\S]{0,400}?fileHashOnlyExtraction/g);
    expect(matches?.length ?? 0).toBe(2);
  });

  it("handleOCRError actually persists what it is given", () => {
    const idx = code.indexOf("async function handleOCRError");
    const block = code.slice(idx, idx + 900);
    // IPE-001-C07: this write is now unconditional (extractedData ? ... :
    // null) rather than behind `if (extractedData)`, so a falsy value
    // durably clears any stale extraction instead of leaving the row's
    // prior value untouched - see walletIntegrityMismatchDurability.test.ts.
    expect(block).toMatch(
      /updateData\.extractedData = extractedData \? JSON\.stringify\(extractedData\) : null;/
    );
  });

  it("never reads a hash from client input", () => {
    expect(code).not.toMatch(/input\.fileHash/);
  });
});

// ─── Behavioral: a file-hash-only record IS approvable ───────────────────

describe("a slip whose OCR produced nothing is still anti-replay protected", () => {
  const bytes = Buffer.from("a-real-slip-that-ocr-could-not-read");
  const fileHash = hashSlipBytes(bytes);

  it("derives a strong identifier from a fileHash-only extraction", () => {
    const stored = JSON.stringify({ fileHash });
    const { identifiers } = deriveStrongIdentifiersFromExtractedData(stored);
    expect(identifiers.fileHash).toBe(fileHash);
    // This is what lets manual approval proceed for such a record.
    expect(hasStrongIdentifier(identifiers)).toBe(true);
  });

  it("without the fileHash the same record would be unapprovable", () => {
    const { identifiers } = deriveStrongIdentifiersFromExtractedData(JSON.stringify({}));
    expect(hasStrongIdentifier(identifiers)).toBe(false);
  });

  it("the same bytes remain detectable as a replay even though OCR never succeeded", () => {
    const first = deriveStrongIdentifiersFromExtractedData(JSON.stringify({ fileHash }));
    const replay = deriveStrongIdentifiersFromExtractedData(
      JSON.stringify({ fileHash: hashSlipBytes(Buffer.from("a-real-slip-that-ocr-could-not-read")) })
    );
    expect(replay.identifiers.fileHash).toBe(first.identifiers.fileHash);
  });

  it("different bytes remain distinguishable", () => {
    const a = hashSlipBytes(Buffer.from("slip-a"));
    const b = hashSlipBytes(Buffer.from("slip-b"));
    expect(a).not.toBe(b);
  });

  it("a fileHash-only record combined with a later reference keeps both", () => {
    const stored = JSON.stringify({ fileHash, reference: "016234222922AQR05745" });
    const { identifiers } = deriveStrongIdentifiersFromExtractedData(stored);
    expect(identifiers.fileHash).toBe(fileHash);
    expect(identifiers.referenceHash).toBeDefined();
  });
});
