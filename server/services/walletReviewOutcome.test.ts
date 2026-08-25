import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { verifySlipData, type ExtractedSlipData } from "../ocr-slip-verification-v2";

/**
 * P2s on the wallet submission path:
 *   - a verifier failure must keep ITS OWN reason, never be relabelled
 *     AUTO_APPROVE_DISABLED (which blames operator config for a data problem)
 *   - the `auto_approved` history row must describe COMMITTED reality, so it
 *     is written only after the claim and the wallet credit succeed
 *   - a claim conflict is a DATA outcome, not an OCR/provider failure
 */

const code = fs
  .readFileSync(path.resolve(process.cwd(), "server/services/walletTopupSubmissionService.ts"), "utf-8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^[ \t]*\/\/.*$/gm, "");

describe("the verifier's real review reason is preserved", () => {
  it("AUTO_APPROVE_DISABLED is used only when verification actually PASSED", () => {
    expect(code).toMatch(/const verificationPassed = verificationResult\.status === "approved"/);
    expect(code).toMatch(
      /verificationPassed\s*\n?\s*\?\s*"AUTO_APPROVE_DISABLED"\s*\n?\s*:\s*\(verificationResult\.reviewReason/
    );
  });

  it("a failed verification falls back to the verifier's reason, not a config label", () => {
    expect(code).toMatch(/verificationResult\.reviewReason \?\? "MANUAL_REVIEW_REQUIRED"/);
  });

  it("the recorded category follows suit - CONFIG only when config is the cause", () => {
    expect(code).toMatch(/const step9Category = verificationPassed \? "CONFIG" : "DATA"/);
  });

  it("the hard-coded AUTO_APPROVE_DISABLED literal no longer reaches the review record", () => {
    // It may only appear via the conditional above.
    expect(code).not.toMatch(/recordWalletAttempt\("needs_review", "AUTO_APPROVE_DISABLED"/);
    expect(code).not.toMatch(/handlePendingReview\(\s*\n\s*topupId,\s*\n\s*userId,\s*\n\s*"AUTO_APPROVE_DISABLED"/);
  });
});

// The reasons that must survive are produced by the verifier itself, so the
// verifier is exercised directly to prove each one is a distinct value that
// the wallet path can pass through.
const context = {
  orderId: 1,
  paymentId: 1,
  orderTotal: 100,
  orderCreatedAt: new Date(),
  paymentCreatedAt: new Date(),
  slipSubmittedAt: new Date(),
};

function extracted(overrides: Partial<ExtractedSlipData> = {}): ExtractedSlipData {
  return {
    amount: 100,
    transactionDate: new Date(),
    transactionDateTime: new Date(),
    reference: "016234222922AQR05745",
    detectedBank: "KBANK",
    confidence: 99,
    confidenceKnown: true,
    merchantCode: "KB000002283068",
    ...overrides,
  };
}

describe("each preserved reason is a real, distinct verifier verdict", () => {
  it("a wrong recipient yields RECIPIENT_NOT_VERIFIED", () => {
    const r = verifySlipData(
      extracted({ merchantCode: undefined, shopName: "Someone Else" }),
      context,
      new Set(),
      new Set()
    );
    expect(r.reviewReason).toBe("RECIPIENT_NOT_VERIFIED");
    expect(r.reviewReason).not.toBe("AUTO_APPROVE_DISABLED");
  });

  it("a stale slip yields TRANSACTION_OUTSIDE_TIME_WINDOW", () => {
    const old = new Date(Date.now() - 10 * 60 * 60 * 1000); // 10h ago, with a time
    const r = verifySlipData(
      extracted({ transactionDate: old, transactionDateTime: old }),
      context,
      new Set(),
      new Set(),
      120
    );
    expect(r.reviewReason).toBe("TRANSACTION_OUTSIDE_TIME_WINDOW");
    expect(r.reviewReason).not.toBe("AUTO_APPROVE_DISABLED");
  });

  it("a missing date yields MISSING_TRANSACTION_DATE", () => {
    const r = verifySlipData(
      extracted({ transactionDate: undefined, transactionDateTime: undefined }),
      context,
      new Set(),
      new Set()
    );
    expect(r.reviewReason).toBe("MISSING_TRANSACTION_DATE");
    expect(r.reviewReason).not.toBe("AUTO_APPROVE_DISABLED");
  });

  it("a missing reference yields MISSING_REFERENCE", () => {
    const r = verifySlipData(extracted({ reference: undefined }), context, new Set(), new Set());
    expect(r.reviewReason).toBe("MISSING_REFERENCE");
  });

  it("unknown confidence yields UNKNOWN_CONFIDENCE", () => {
    const r = verifySlipData(
      extracted({ confidenceKnown: false }),
      context,
      new Set(),
      new Set()
    );
    expect(r.reviewReason).toBe("UNKNOWN_CONFIDENCE");
  });

  it("none of these is ever the string AUTO_APPROVE_DISABLED", () => {
    const cases = [
      extracted({ merchantCode: undefined, shopName: "Nope" }),
      extracted({ transactionDate: undefined, transactionDateTime: undefined }),
      extracted({ reference: undefined }),
      extracted({ confidenceKnown: false }),
      extracted({ amount: 999 }),
    ];
    for (const c of cases) {
      const r = verifySlipData(c, context, new Set(), new Set());
      expect(r.reviewReason).not.toBe("AUTO_APPROVE_DISABLED");
    }
  });
});

describe("auto_approved history is written only after the money commits", () => {
  it("the approval call happens BEFORE the history record", () => {
    const approveIdx = code.indexOf("const approved = await autoApproveWalletTopup(");
    const recordIdx = code.indexOf('await recordWalletAttempt("auto_approved"');
    expect(approveIdx).toBeGreaterThan(-1);
    expect(recordIdx).toBeGreaterThan(-1);
    // Ordering is the entire fix: recording first left history asserting an
    // approval that a claim conflict or a failed transaction had prevented.
    expect(approveIdx).toBeLessThan(recordIdx);
  });

  it("there is exactly one auto_approved recording site", () => {
    const matches = code.match(/recordWalletAttempt\("auto_approved"/g);
    expect(matches?.length ?? 0).toBe(1);
  });

  it("a claim conflict is classified as DATA, not TECHNICAL", () => {
    expect(code).toMatch(/instanceof db\.WalletSlipClaimError/);
    // The intended (result, category) for this outcome are passed into
    // handlePendingReview, which records them itself only once its guarded
    // write's outcome is known (IPE-001 P2) - never recorded directly here.
    const idx = code.indexOf("if (claimCode) {");
    const block = code.slice(idx, idx + 600);
    expect(block).toMatch(/handlePendingReview\(/);
    expect(block).toMatch(/duplicateReason,/);
    expect(block).toMatch(/recordWalletAttempt,\s*\n\s*"needs_review",\s*\n\s*"DATA"/);
  });

  it("a claim conflict does NOT record a technical/provider failure", () => {
    const idx = code.indexOf("instanceof db.WalletSlipClaimError");
    const block = code.slice(idx, idx + 900);
    expect(block).not.toMatch(/"technical_failure"/);
    expect(block).not.toMatch(/OCR_PROCESSING_ERROR/);
  });

  it("NO_STRONG_IDENTIFIER is mapped through as its own data reason", () => {
    expect(code).toMatch(/claimCode === "NO_STRONG_IDENTIFIER" \? "NO_STRONG_IDENTIFIER" : claimCode/);
  });

  it("a non-claim approval failure is rethrown, leaving no auto_approved row", () => {
    const idx = code.indexOf("instanceof db.WalletSlipClaimError");
    const block = code.slice(idx, idx + 1400);
    expect(block).toMatch(/throw approvalError/);
  });

  it("the claim-conflict path routes to pending review, never a rejection", () => {
    const idx = code.indexOf("instanceof db.WalletSlipClaimError");
    const block = code.slice(idx, idx + 1200);
    expect(block).toMatch(/handlePendingReview\(/);
    expect(block).not.toMatch(/reject/i);
  });
});
