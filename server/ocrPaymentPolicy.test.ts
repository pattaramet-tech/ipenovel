import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { verifySlipData, type ExtractedSlipData } from "./ocr-slip-verification-v2";

/**
 * NON-NEGOTIABLE PAYMENT POLICY
 *
 *   OCR may only ever decide AUTO_APPROVE or NEEDS_REVIEW.
 *   REJECT is an admin action. No automated path may reject a payment.
 *
 * These are enforcement tests, not documentation. They combine a behavioral
 * check on the decision function with a structural check that no OCR module
 * calls a rejection API - so a future change that wires rejection into an
 * OCR path fails here rather than in production.
 */

const REPO_ROOT = process.cwd();

/** Modules that make or act on OCR verification decisions. */
const OCR_DECISION_MODULES = [
  "server/ocr-slip-verification-v2.ts",
  "server/ocr-slip-integration.ts",
  "server/ocr-slip-integration-v2.ts",
  "server/ocr-slip-integration-staging.ts",
  "server/services/slipSubmissionService.ts",
  "server/services/walletTopupSubmissionService.ts",
  "server/services/ocrRecheckService.ts",
];

function readIfPresent(relativePath: string): string | null {
  const abs = path.resolve(REPO_ROOT, relativePath);
  return fs.existsSync(abs) ? fs.readFileSync(abs, "utf-8") : null;
}

/** Strips comments so prose about rejection never trips the scan. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

describe("OCR can never auto-reject a payment", () => {
  it.each(OCR_DECISION_MODULES)("%s does not call rejectPayment()", (relativePath) => {
    const source = readIfPresent(relativePath);
    if (source === null) return; // module not present in this build - nothing to assert
    expect(stripComments(source)).not.toMatch(/\brejectPayment\s*\(/);
  });

  it.each(OCR_DECISION_MODULES)(
    "%s does not set a payment/top-up status to 'rejected'",
    (relativePath) => {
      const source = readIfPresent(relativePath);
      if (source === null) return;
      const code = stripComments(source);
      // Catches `status: "rejected"` and `status = "rejected"` in any quoting.
      expect(code).not.toMatch(/status\s*[:=]\s*["'`]rejected["'`]/);
    }
  );

  it.each(OCR_DECISION_MODULES)(
    "%s does not call rejectWalletTopup()",
    (relativePath) => {
      const source = readIfPresent(relativePath);
      if (source === null) return;
      expect(stripComments(source)).not.toMatch(/\brejectWalletTopup\s*\(/);
    }
  );
});

// ─── Behavioral: verifySlipData only ever returns two outcomes ────────────

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
    ...overrides,
  };
}

describe("verifySlipData never returns a rejected status", () => {
  const scenarios: Array<[string, ExtractedSlipData]> = [
    ["missing amount", extracted({ amount: undefined })],
    ["amount mismatch", extracted({ amount: 999 })],
    ["missing date", extracted({ transactionDate: undefined, transactionDateTime: undefined })],
    ["missing reference", extracted({ reference: undefined })],
    ["low confidence", extracted({ confidence: 10 })],
    ["unknown confidence", extracted({ confidence: 0, confidenceKnown: false })],
    ["empty extraction", {} as ExtractedSlipData],
  ];

  it.each(scenarios)("%s -> pending_review, never rejected", (_label, data) => {
    const result = verifySlipData(data, context, new Set(), new Set());
    expect(result.status).toBe("pending_review");
    expect(result.status).not.toBe("rejected" as never);
    expect(result.isAutoApproved).toBe(false);
  });

  it("a duplicate reference routes to review, never rejection", () => {
    const result = verifySlipData(
      extracted(),
      context,
      new Set(["016234222922AQR05745"]),
      new Set()
    );
    expect(result.status).toBe("pending_review");
    expect(result.reviewReason).toBe("DUPLICATE_REFERENCE");
  });
});

describe("unknown confidence must not auto-approve", () => {
  it("an otherwise-perfect slip with unknown confidence goes to review", () => {
    const result = verifySlipData(
      extracted({ confidence: 99, confidenceKnown: false }),
      context,
      new Set(),
      new Set()
    );
    expect(result.isAutoApproved).toBe(false);
    expect(result.reviewReason).toBe("UNKNOWN_CONFIDENCE");
  });

  it("the same slip WITH a known confidence does auto-approve", () => {
    const result = verifySlipData(extracted(), context, new Set(), new Set());
    expect(result.isAutoApproved).toBe(true);
    expect(result.status).toBe("approved");
  });
});

describe("weak duplicate evidence is never a confirmed duplicate", () => {
  it("a fingerprint-only match reports WEAK_DUPLICATE_RISK, not DUPLICATE_FINGERPRINT", () => {
    const data = extracted();
    // Reproduce the legacy fingerprint for this extraction so the weak set hits.
    const probe = verifySlipData(data, context, new Set(), new Set());
    const result = verifySlipData(data, context, new Set(), new Set([probe.fingerprint]));

    expect(result.status).toBe("pending_review");
    expect(result.reviewReason).toBe("WEAK_DUPLICATE_RISK");
    expect(result.breakdown?.duplicateEvidenceStrength).toBe("weak");
    expect(result.breakdown?.failureReason).toMatch(/NOT proof/i);
  });

  it("a reference match is marked STRONG", () => {
    const result = verifySlipData(
      extracted(),
      context,
      new Set(["016234222922AQR05745"]),
      new Set()
    );
    expect(result.breakdown?.duplicateEvidenceStrength).toBe("strong");
  });
});
