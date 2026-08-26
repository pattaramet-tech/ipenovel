/**
 * IPE-001-C05 P2: "A reviewable payment with a stored slip but no OCR
 * metadata must still expose Recheck OCR."
 *
 * OCRResultPanel.tsx renders no DOM in this test - this repo's unit test
 * project has no jsdom/React Testing Library (matching the ocrVerdictModel
 * pattern). This file pins the SOURCE gate that decides whether the panel
 * renders at all, since that gate is what silently hid Recheck for a
 * metadata-less payment.
 *
 * ── The bug ────────────────────────────────────────────────────────────────
 * The panel returned `null` whenever extractedData, ocrDecision,
 * reviewReason AND approvalSource were all absent - a real, legitimate shape
 * for a payment whose slip was uploaded but OCR never ran or crashed before
 * writing anything. Recheck (`canRecheckOcr`) only requires the payment to
 * be pending/pending_review - it never needed any of those four fields - but
 * the panel never reached far enough to render it.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

function readCode(relativePath: string): string {
  return fs
    .readFileSync(path.resolve(process.cwd(), relativePath), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

describe("OCRResultPanel renders (and so can offer Recheck) for a reviewable payment with a stored slip and zero OCR metadata", () => {
  const code = readCode("client/src/components/OCRResultPanel.tsx");

  it("declares slipImageUrl on the payment prop", () => {
    expect(code).toMatch(/slipImageUrl\?: string \| null;/);
  });

  it("the early-return null gate is widened by a reviewable+stored-slip escape hatch", () => {
    const idx = code.indexOf("const isReviewablePaymentStatus =");
    expect(idx).toBeGreaterThan(-1);
    const body = code.slice(idx, idx + 700);
    expect(body).toMatch(
      /payment\.status === "pending_review" \|\| payment\.status === "pending"/
    );
    expect(body).toMatch(/Boolean\(payment\.slipImageUrl\)/);

    const gateIdx = code.indexOf("if (\n    !extracted &&");
    expect(gateIdx).toBeGreaterThan(-1);
    const gateBody = code.slice(gateIdx, gateIdx + 250);
    expect(gateBody).toMatch(/!hasStoredSlipWithNoMetadata/);
  });

  it("a finalized (non-reviewable) payment with no metadata still returns null - the escape hatch is not unconditional", () => {
    const idx = code.indexOf("const isReviewablePaymentStatus =");
    const body = code.slice(idx, idx + 300);
    // Only pending/pending_review qualifies - approved/rejected/cancelled do
    // not, so a finalized payment with nothing to show still renders nothing.
    expect(body).not.toMatch(/"approved"|"rejected"|"cancelled"/);
  });

  it("canRecheckOcr itself never required any OCR metadata field - only the payment status", () => {
    const model = readCode("client/src/components/ocrVerdictModel.ts");
    const idx = model.indexOf("export function canRecheckOcr(");
    const body = model.slice(idx, idx + 300);
    expect(body).toMatch(/status === "pending_review" \|\| status === "pending"/);
    expect(body).not.toMatch(/ocrDecision|reviewReason|approvalSource|extracted/);
  });

  it("the verdict is never manufactured for absent metadata - deriveVerdict falls through to 'unknown'", () => {
    const model = readCode("client/src/components/ocrVerdictModel.ts");
    const idx = model.indexOf("export function deriveVerdict(");
    const body = model.slice(idx, idx + 700);
    expect(body).toMatch(/return "unknown";/);
  });
});
