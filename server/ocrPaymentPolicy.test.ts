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
    // Recipient evidence is part of a COMPLETE slip: verifySlipData now
    // refuses to auto-approve without proof the money reached IpeNovel, so a
    // fixture lacking it is not a "good slip" any more.
    merchantCode: "KB000002283068",
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

// ─── Server-side recipient gate ───────────────────────────────────────────

describe("recipient verification is a SERVER gate, not just a UI label", () => {
  it("an exact SCB merchant/biller slip passes", () => {
    const result = verifySlipData(
      extracted({
        merchantCode: undefined,
        merchantTransactionCode: "KPS004KB000002283068",
        receiverAccountOrId: "010753600031501",
      }),
      context,
      new Set(),
      new Set()
    );
    expect(result.breakdown?.recipientVerified).toBe(true);
    expect(result.breakdown?.recipientEvidenceStrength).toBe("strong");
    expect(result.isAutoApproved).toBe(true);
  });

  it("an exact KTB merchant code passes", () => {
    const result = verifySlipData(
      extracted({ detectedBank: "KTB", merchantCode: "KB000002283068" }),
      context,
      new Set(),
      new Set()
    );
    expect(result.breakdown?.recipientEvidenceType).toBe("merchant_code");
    expect(result.isAutoApproved).toBe(true);
  });

  it("a biller ID alone is strong evidence - bill-payment slips print no merchant code", () => {
    const result = verifySlipData(
      extracted({ merchantCode: undefined, receiverAccountOrId: "010753600031501" }),
      context,
      new Set(),
      new Set()
    );
    expect(result.breakdown?.recipientEvidenceType).toBe("biller_id");
    expect(result.isAutoApproved).toBe(true);
  });

  it("a KBank transfer with the Ipe Novel alias and NO merchant code is a valid fallback", () => {
    const result = verifySlipData(
      extracted({ merchantCode: undefined, shopName: "Ipe Novel" }),
      context,
      new Set(),
      new Set()
    );
    expect(result.breakdown?.recipientVerified).toBe(true);
    expect(result.breakdown?.recipientEvidenceStrength).toBe("fallback");
    expect(result.isAutoApproved).toBe(true);
  });

  it("a receiver name alias also qualifies as the documented fallback", () => {
    const result = verifySlipData(
      extracted({ merchantCode: undefined, receiverName: "IPENOVEL" }),
      context,
      new Set(),
      new Set()
    );
    expect(result.breakdown?.recipientEvidenceType).toBe("receiver_name");
    expect(result.isAutoApproved).toBe(true);
  });

  it("an UNRELATED receiver can never auto-approve", () => {
    const result = verifySlipData(
      extracted({ merchantCode: undefined, shopName: "Some Other Shop", receiverName: "นาย ก" }),
      context,
      new Set(),
      new Set()
    );
    expect(result.isAutoApproved).toBe(false);
    expect(result.reviewReason).toBe("RECIPIENT_NOT_VERIFIED");
    expect(result.status).toBe("pending_review");
  });

  it("a WRONG merchant code is not accepted as evidence", () => {
    const result = verifySlipData(
      extracted({ merchantCode: "KB999999999999" }),
      context,
      new Set(),
      new Set()
    );
    expect(result.isAutoApproved).toBe(false);
    expect(result.reviewReason).toBe("RECIPIENT_NOT_VERIFIED");
  });

  it("missing recipient evidence entirely -> needs review, never rejection", () => {
    const result = verifySlipData(
      extracted({ merchantCode: undefined }),
      context,
      new Set(),
      new Set()
    );
    expect(result.reviewReason).toBe("RECIPIENT_NOT_VERIFIED");
    expect(result.status).toBe("pending_review");
    expect(result.status).not.toBe("rejected" as never);
  });

  it("exposes the graded evidence fields for the UI to render", () => {
    const result = verifySlipData(extracted(), context, new Set(), new Set());
    expect(result.breakdown?.recipientEvidenceType).toBeDefined();
    expect(result.breakdown?.recipientEvidenceStrength).toBeDefined();
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

// ─── Manual approval may not silently bypass anti-replay ─────────────────

describe("normal Admin Approve refuses a payment with NO strong identifier", () => {
  const orderCode = fs
    .readFileSync(path.resolve(REPO_ROOT, "server/services/orderService.ts"), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ 	]*\/\/.*$/gm, "");

  it("throws NO_STRONG_IDENTIFIER instead of proceeding", () => {
    expect(orderCode).toMatch(/hasStrongIdentifier\(identifiers\)/);
    expect(orderCode).toMatch(/NO_STRONG_IDENTIFIER/);
  });

  it("the claim is no longer conditional on an identifier existing", () => {
    // Previously the whole claim block was wrapped in `if (hasStrongIdentifier)`,
    // so a payment without one approved with no anti-replay check at all.
    expect(orderCode).not.toMatch(/if \(hasStrongIdentifier\(identifiers\)\) \{[\s\S]*claimSlip/);
  });

  it("still claims atomically when an identifier IS present", () => {
    expect(orderCode).toMatch(/claimSlip\s*\(/);
    expect(orderCode).toMatch(/SLIP_ALREADY_CLAIMED/);
  });

  it("points the admin at recheck / the legacy override rather than approving", () => {
    expect(orderCode).toMatch(/Recheck OCR/i);
    expect(orderCode).toMatch(/legacy override/i);
  });
});

describe("wallet manual approval applies the same policy", () => {
  const dbCode = fs
    .readFileSync(path.resolve(REPO_ROOT, "server/db.ts"), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ 	]*\/\/.*$/gm, "");

  it("throws NO_STRONG_IDENTIFIER for an unprotectable top-up", () => {
    expect(dbCode).toMatch(/NO_STRONG_IDENTIFIER/);
  });

  it("never silently approves without a claim attempt", () => {
    expect(dbCode).toMatch(/claimSlip\s*\(/);
  });
});
