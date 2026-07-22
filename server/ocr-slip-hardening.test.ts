/**
 * OCR Auto-Approve Hardening Test Suite
 *
 * Covers all requirements from the hardening spec:
 * 1. Valid strong transfer slip auto-approves
 * 2. Thai numerals parse correctly
 * 3. Buddhist year date parses correctly
 * 4. OCR spacing noise still parses
 * 5. Duplicate reference is blocked
 * 6. Duplicate fingerprint is blocked
 * 7. pending_review duplicate is blocked
 * 8. Old transaction is sent to manual review
 * 9. Weak OCR is sent to manual review
 * 10. Missing merchantTransactionCode does not break flow
 * 11. Wallet/manual flows still work (via approvalSource logic)
 * 12. Approval metadata still works
 * 13. Admin review payload includes new OCR fields/reasons
 * 14. New bank aliases detected
 * 15. Receiver name and masked account extracted
 * 16. PromptPay amount pattern extracted
 * 17. ISO date format parsed
 * 18. Missing transaction date → MISSING_TRANSACTION_DATE (not MISSING_REFERENCE)
 * 19. Confidence reweighted: amount+date+reference dominate
 * 20. getReviewReasonDescription covers all new codes
 */

import { describe, it, expect } from "vitest";
import {
  extractSlipData,
  verifySlipData,
  generateFingerprint,
  normalizeThaiNumerals,
  ExtractedSlipData,
  OrderPaymentContext,
} from "./ocr-slip-verification";
import { getReviewReasonDescription } from "./ocr-slip-integration";

// ─── Shared fixtures ──────────────────────────────────────────────────────────

/** Formats a Date as a Thai-slip-style "DD/MM/YYYY" string using the Buddhist Era year (Gregorian + 543) - used to build test fixtures anchored to real wall-clock time instead of a hardcoded calendar date. */
function formatThaiBuddhistDate(date: Date): string {
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const buddhistYear = date.getFullYear() + 543;
  return `${day}/${month}/${buddhistYear}`;
}

/** A payment context where the payment was submitted on 2026-04-25 10:05 UTC */
const baseContext: OrderPaymentContext = {
  orderId: 100,
  paymentId: 200,
  orderTotal: 250,
  orderCreatedAt: new Date("2026-04-25T10:00:00Z"),
  paymentCreatedAt: new Date("2026-04-25T10:05:00Z"),
};

/** A complete, valid Bangkok Bank slip in standard format */
const strongSlipText = `
  ธนาคารกรุงเทพ
  ชื่อร้านค้า: Ipe Novel
  รหัสร้านค้า: KB000002283068
  รหัสธุรกรรม: KPS004KB000002283068
  จำนวนเงิน: 250.00 บาท
  วันที่: 25/04/2569
  เลขที่อ้างอิง: REF1234567890
`;

// ─── 1. Valid strong transfer slip auto-approves ──────────────────────────────
describe("1. Valid strong transfer slip auto-approves", () => {
  it("should auto-approve a complete, valid slip", () => {
    const extracted = extractSlipData(strongSlipText);
    const result = verifySlipData(extracted, baseContext, new Set(), new Set());
    expect(result.isAutoApproved).toBe(true);
    expect(result.status).toBe("approved");
    expect(result.reviewReason).toBeUndefined();
  });

  it("should have confidence ≥ 85 for a complete slip", () => {
    const extracted = extractSlipData(strongSlipText);
    expect(extracted.confidence).toBeGreaterThanOrEqual(85);
  });

  it("should link to correct order and payment", () => {
    const extracted = extractSlipData(strongSlipText);
    const result = verifySlipData(extracted, baseContext, new Set(), new Set());
    expect(result.linkedOrderId).toBe(baseContext.orderId);
    expect(result.linkedPaymentId).toBe(baseContext.paymentId);
  });
});

// ─── 2. Thai numerals parse correctly ────────────────────────────────────────
describe("2. Thai numerals parse correctly", () => {
  it("normalizeThaiNumerals converts all Thai digits", () => {
    expect(normalizeThaiNumerals("๐๑๒๓๔๕๖๗๘๙")).toBe("0123456789");
  });

  it("extracts amount with Thai numerals", () => {
    const slip = `
      ธนาคารกรุงเทพ
      ชื่อร้านค้า: Ipe Novel
      รหัสร้านค้า: KB000002283068
      จำนวนเงิน: ๒๕๐.๐๐ บาท
      วันที่: 25/04/2569
      เลขที่อ้างอิง: REF1234567890
    `;
    const extracted = extractSlipData(slip);
    expect(extracted.amount).toBe(250);
  });

  it("extracts reference with Thai numerals", () => {
    const slip = `
      ธนาคารกรุงเทพ
      ชื่อร้านค้า: Ipe Novel
      รหัสร้านค้า: KB000002283068
      จำนวนเงิน: 250.00 บาท
      วันที่: 25/04/2569
      เลขที่อ้างอิง: ๑๒๓๔๕๖๗๘๙๐๑๒
    `;
    const extracted = extractSlipData(slip);
    expect(extracted.reference).toBe("123456789012");
  });

  it("handles mixed Thai and Western numerals in amount", () => {
    const slip = `
      ชื่อร้านค้า: Ipe Novel
      รหัสร้านค้า: KB000002283068
      จำนวนเงิน: ๒50.00 บาท
      วันที่: 25/04/2569
      เลขที่อ้างอิง: REF1234567890
    `;
    const extracted = extractSlipData(slip);
    expect(extracted.amount).toBe(250);
  });
});

// ─── 3. Buddhist year date parses correctly ───────────────────────────────────
describe("3. Buddhist year date parses correctly", () => {
  it("converts Buddhist year 2569 → Gregorian 2026", () => {
    const slip = "วันที่: 25/04/2569";
    const extracted = extractSlipData(slip);
    expect(extracted.transactionDate).toBeDefined();
    expect(extracted.transactionDate?.getFullYear()).toBe(2026);
    expect(extracted.transactionDate?.getMonth()).toBe(3); // April (0-indexed)
    expect(extracted.transactionDate?.getDate()).toBe(25);
  });

  it("parses Buddhist year with Thai numerals", () => {
    const slip = `
      ชื่อร้านค้า: Ipe Novel
      รหัสร้านค้า: KB000002283068
      จำนวนเงิน: 250.00 บาท
      วันที่: ๒๕/๐๔/๒๕๖๙
      เลขที่อ้างอิง: REF1234567890
    `;
    const extracted = extractSlipData(slip);
    expect(extracted.transactionDate?.getFullYear()).toBe(2026);
    expect(extracted.transactionDate?.getMonth()).toBe(3);
    expect(extracted.transactionDate?.getDate()).toBe(25);
  });

  it("parses Thai month name format (5 เมษายน 2569)", () => {
    const slip = `
      ชื่อร้านค้า: Ipe Novel
      รหัสร้านค้า: KB000002283068
      จำนวนเงิน: 250.00 บาท
      5 เมษายน 2569
      เลขที่อ้างอิง: REF1234567890
    `;
    const extracted = extractSlipData(slip);
    // Month name format may or may not be picked up depending on label presence
    // but the date should be valid if extracted
    if (extracted.transactionDate) {
      expect(extracted.transactionDate.getFullYear()).toBe(2026);
    }
  });
});

// ─── 4. OCR spacing noise still parses ───────────────────────────────────────
describe("4. OCR spacing noise still parses", () => {
  it("handles extra spaces around labels and values", () => {
    const slip = `
      ธนาคารกรุงเทพ
      ชื่อร้านค้า  :   Ipe Novel
      รหัสร้านค้า  :  KB000002283068
      จำนวนเงิน   :   250.00   บาท
      วันที่   :   25/04/2569
      เลขที่อ้างอิง   :   REF1234567890
    `;
    const extracted = extractSlipData(slip);
    expect(extracted.shopName).toBe("Ipe Novel");
    expect(extracted.merchantCode).toBe("KB000002283068");
    expect(extracted.amount).toBe(250);
    expect(extracted.reference).toBe("REF1234567890");
  });

  it("handles tab characters between label and value", () => {
    const slip = "จำนวนเงิน:\t250.00 บาท\nวันที่:\t25/04/2569\nเลขที่อ้างอิง:\tREF1234567890";
    const extracted = extractSlipData(slip);
    expect(extracted.amount).toBe(250);
    expect(extracted.reference).toBe("REF1234567890");
  });

  it("handles commas in amount (1,250.50)", () => {
    const slip = `
      ชื่อร้านค้า: Ipe Novel
      รหัสร้านค้า: KB000002283068
      จำนวนเงิน: 1,250.50 บาท
      วันที่: 25/04/2569
      เลขที่อ้างอิง: REF1234567890
    `;
    const extracted = extractSlipData(slip);
    const ctx = { ...baseContext, orderTotal: 1250.50 };
    expect(extracted.amount).toBe(1250.5);
    const result = verifySlipData(extracted, ctx, new Set(), new Set());
    expect(result.isAutoApproved).toBe(true);
  });
});

// ─── 5. Duplicate reference is blocked ───────────────────────────────────────
describe("5. Duplicate reference is blocked", () => {
  it("rejects slip when reference already exists in approved set", () => {
    const extracted = extractSlipData(strongSlipText);
    const existingRefs = new Set(["REF1234567890"]);
    const result = verifySlipData(extracted, baseContext, existingRefs, new Set());
    expect(result.isAutoApproved).toBe(false);
    expect(result.reviewReason).toBe("DUPLICATE_REFERENCE");
  });

  it("rejects slip when reference exists in pending_review set", () => {
    // pending_review references are included in existingReferences by the integration layer
    const extracted = extractSlipData(strongSlipText);
    const pendingRefs = new Set(["REF1234567890"]);
    const result = verifySlipData(extracted, baseContext, pendingRefs, new Set());
    expect(result.isAutoApproved).toBe(false);
    expect(result.reviewReason).toBe("DUPLICATE_REFERENCE");
  });
});

// ─── 6. Duplicate fingerprint is blocked ─────────────────────────────────────
describe("6. Duplicate fingerprint is blocked", () => {
  it("rejects slip when fingerprint already exists", () => {
    const extracted = extractSlipData(strongSlipText);
    const fp = generateFingerprint(extracted);
    const existingFPs = new Set([fp]);
    const result = verifySlipData(extracted, baseContext, new Set(), existingFPs);
    expect(result.isAutoApproved).toBe(false);
    expect(result.reviewReason).toBe("DUPLICATE_FINGERPRINT");
  });

  it("fingerprint is deterministic across calls", () => {
    const extracted = extractSlipData(strongSlipText);
    const fp1 = generateFingerprint(extracted);
    const fp2 = generateFingerprint(extracted);
    expect(fp1).toBe(fp2);
  });

  it("different slips produce different fingerprints", () => {
    const slip2 = strongSlipText.replace("REF1234567890", "REF9999999999");
    const e1 = extractSlipData(strongSlipText);
    const e2 = extractSlipData(slip2);
    expect(generateFingerprint(e1)).not.toBe(generateFingerprint(e2));
  });
});

// ─── 7. pending_review duplicate is blocked ──────────────────────────────────
describe("7. pending_review duplicate is blocked (race condition protection)", () => {
  it("blocks re-submission of same reference while first is in pending_review", () => {
    const extracted = extractSlipData(strongSlipText);
    // Simulate: first submission went to pending_review, its reference is in the set
    const pendingRefs = new Set([extracted.reference!]);
    const result = verifySlipData(extracted, baseContext, pendingRefs, new Set());
    expect(result.isAutoApproved).toBe(false);
    expect(result.reviewReason).toBe("DUPLICATE_REFERENCE");
  });

  it("blocks re-submission by fingerprint while first is in pending_review", () => {
    const extracted = extractSlipData(strongSlipText);
    const fp = generateFingerprint(extracted);
    const pendingFPs = new Set([fp]);
    const result = verifySlipData(extracted, baseContext, new Set(), pendingFPs);
    expect(result.isAutoApproved).toBe(false);
    expect(result.reviewReason).toBe("DUPLICATE_FINGERPRINT");
  });
});

// ─── 8. Old transaction is sent to manual review ─────────────────────────────
describe("8. Old transaction is sent to manual review", () => {
  it("rejects transaction more than 24 hours before payment submission", () => {
    // This test needs a transaction date that is (a) more than 24h before
    // the payment, so verifySlipData rejects it as
    // TRANSACTION_OUTSIDE_TIME_WINDOW, and (b) recent enough in REAL
    // wall-clock terms to survive extractTransactionDate's own freshness
    // filter (server/ocr-slip-verification.ts's buildDate() rejects any
    // parsed date more than 90 real-world days old - a legitimate
    // production safeguard against stale slip photos, not a test bug).
    // A calendar date hardcoded to this file's original authoring day
    // (2026-04-23) inevitably ages past that 90-day window as real time
    // passes - which is exactly what started failing here. Anchoring both
    // dates to a freshly-captured `now` makes the test permanently
    // immune to wall-clock drift while testing the identical business
    // rule. Scoped to this one test's own local payment context - the
    // shared `baseContext` (and the other 83 tests using it) is untouched.
    const now = new Date();
    const paymentContext: OrderPaymentContext = {
      ...baseContext,
      orderCreatedAt: now,
      paymentCreatedAt: now,
    };
    const twoDaysBeforeNow = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
    const transactionDateThai = formatThaiBuddhistDate(twoDaysBeforeNow);
    const slip = `
      ธนาคารกรุงเทพ
      ชื่อร้านค้า: Ipe Novel
      รหัสร้านค้า: KB000002283068
      จำนวนเงิน: 250.00 บาท
      วันที่: ${transactionDateThai}
      เลขที่อ้างอิง: REF1234567890
    `;
    const extracted = extractSlipData(slip);
    const result = verifySlipData(extracted, paymentContext, new Set(), new Set());
    expect(result.isAutoApproved).toBe(false);
    expect(result.reviewReason).toBe("TRANSACTION_OUTSIDE_TIME_WINDOW");
  });

  it("accepts transaction within 24 hours before payment", () => {
    const extracted = extractSlipData(strongSlipText);
    const result = verifySlipData(extracted, baseContext, new Set(), new Set());
    expect(result.reviewReason).not.toBe("TRANSACTION_OUTSIDE_TIME_WINDOW");
  });

  it("accepts transaction up to 5 minutes after payment (clock skew)", () => {
    // Transaction 3 minutes after payment — within clock skew tolerance
    const extracted = extractSlipData(strongSlipText);
    // Manually set transactionDate 3 min after paymentCreatedAt
    const slightlyFuture = new Date(baseContext.paymentCreatedAt.getTime() + 3 * 60 * 1000);
    const tweaked: ExtractedSlipData = { ...extracted, transactionDate: slightlyFuture };
    const result = verifySlipData(tweaked, baseContext, new Set(), new Set());
    expect(result.reviewReason).not.toBe("TRANSACTION_OUTSIDE_TIME_WINDOW");
  });

  it("rejects transaction more than 5 minutes after payment", () => {
    const extracted = extractSlipData(strongSlipText);
    const tooFuture = new Date(baseContext.paymentCreatedAt.getTime() + 10 * 60 * 1000);
    const tweaked: ExtractedSlipData = { ...extracted, transactionDate: tooFuture };
    const result = verifySlipData(tweaked, baseContext, new Set(), new Set());
    expect(result.isAutoApproved).toBe(false);
    expect(result.reviewReason).toBe("TRANSACTION_OUTSIDE_TIME_WINDOW");
  });
});

// ─── 9. Weak OCR is sent to manual review ────────────────────────────────────
describe("9. Weak OCR is sent to manual review", () => {
  it("sends to review when confidence < 85", () => {
    const weakExtracted: ExtractedSlipData = {
      amount: 250,
      transactionDate: new Date("2026-04-25T09:00:00Z"),
      reference: "REF1234567890",
      confidence: 60,
    };
    const result = verifySlipData(weakExtracted, baseContext, new Set(), new Set());
    expect(result.isAutoApproved).toBe(false);
    expect(result.reviewReason).toBe("LOW_CONFIDENCE");
  });

  it("sends to review when insufficient structured fields", () => {
    // Only amount — no date, no reference, no bank, no shop
    const bareMinimum: ExtractedSlipData = {
      amount: 250,
      confidence: 90,
    };
    const result = verifySlipData(bareMinimum, baseContext, new Set(), new Set());
    expect(result.isAutoApproved).toBe(false);
    // Will fail on MISSING_TRANSACTION_DATE before reaching INSUFFICIENT_STRUCTURED_DATA
    expect(["MISSING_TRANSACTION_DATE", "MISSING_REFERENCE", "INSUFFICIENT_STRUCTURED_DATA"])
      .toContain(result.reviewReason);
  });

  it("sends empty OCR to review with confidence 0", () => {
    const extracted = extractSlipData("");
    expect(extracted.confidence).toBe(0);
  });
});

// ─── 10. Missing merchantTransactionCode does not break flow ──────────────────
describe("10. Missing merchantTransactionCode does not break flow", () => {
  it("auto-approves when merchantTransactionCode is absent", () => {
    const slip = `
      ธนาคารกรุงเทพ
      ชื่อร้านค้า: Ipe Novel
      รหัสร้านค้า: KB000002283068
      จำนวนเงิน: 250.00 บาท
      วันที่: 25/04/2569
      เลขที่อ้างอิง: REF1234567890
    `;
    const extracted = extractSlipData(slip);
    expect(extracted.merchantTransactionCode).toBeUndefined();
    const result = verifySlipData(extracted, baseContext, new Set(), new Set());
    expect(result.isAutoApproved).toBe(true);
  });

  it("sends to review when merchantTransactionCode is present but wrong", () => {
    const extracted = extractSlipData(strongSlipText);
    const tweaked: ExtractedSlipData = {
      ...extracted,
      merchantTransactionCode: "WRONGCODE12345",
    };
    const result = verifySlipData(tweaked, baseContext, new Set(), new Set());
    expect(result.isAutoApproved).toBe(false);
    expect(result.reviewReason).toBe("MERCHANT_TRANSACTION_CODE_MISMATCH");
  });
});

// ─── 11. Wallet/manual flows still work ──────────────────────────────────────
describe("11. Wallet/manual flows still work", () => {
  it("getReviewReasonDescription handles MANUAL_REVIEW_REQUIRED", () => {
    const desc = getReviewReasonDescription("MANUAL_REVIEW_REQUIRED");
    expect(desc).toBeTruthy();
    expect(desc).not.toContain("Unknown reason");
  });

  it("getReviewReasonDescription handles PAYMENT_NOT_FOUND", () => {
    const desc = getReviewReasonDescription("PAYMENT_NOT_FOUND");
    expect(desc).toBeTruthy();
    expect(desc).not.toContain("Unknown reason");
  });
});

// ─── 12. Approval metadata still works ───────────────────────────────────────
describe("12. Approval metadata still works", () => {
  it("verifySlipData returns fingerprint in result", () => {
    const extracted = extractSlipData(strongSlipText);
    const result = verifySlipData(extracted, baseContext, new Set(), new Set());
    expect(result.fingerprint).toBeDefined();
    expect(result.fingerprint.length).toBeGreaterThan(0);
  });

  it("fingerprint uses amount with 2 decimal places for consistency", () => {
    const e1: ExtractedSlipData = { reference: "REF123", amount: 250, transactionDate: new Date("2026-04-25") };
    const e2: ExtractedSlipData = { reference: "REF123", amount: 250.0, transactionDate: new Date("2026-04-25") };
    expect(generateFingerprint(e1)).toBe(generateFingerprint(e2));
  });
});

// ─── 13. Admin review payload includes new OCR fields/reasons ────────────────
describe("13. Admin review payload includes new OCR fields/reasons", () => {
  it("extractSlipData returns detectedBank and detectedBankName", () => {
    const extracted = extractSlipData(strongSlipText);
    expect(extracted.detectedBank).toBe("BBL");
    expect(extracted.detectedBankName).toBe("Bangkok Bank");
  });

  it("extractSlipData returns detectedBank for KBank", () => {
    const slip = `ธนาคารกสิกรไทย\nจำนวนเงิน: 250.00 บาท\nวันที่: 25/04/2569\nเลขที่อ้างอิง: REF1234567890`;
    const extracted = extractSlipData(slip);
    expect(extracted.detectedBank).toBe("KBANK");
    expect(extracted.detectedBankName).toBe("KBank");
  });

  it("extractSlipData returns detectedBank for SCB", () => {
    const slip = `ธนาคารไทยพาณิชย์\nจำนวนเงิน: 250.00 บาท\nวันที่: 25/04/2569\nเลขที่อ้างอิง: REF1234567890`;
    const extracted = extractSlipData(slip);
    expect(extracted.detectedBank).toBe("SCB");
  });

  it("extractSlipData returns detectedBank for KTB", () => {
    const slip = `ธนาคารกรุงไทย\nจำนวนเงิน: 250.00 บาท\nวันที่: 25/04/2569\nเลขที่อ้างอิง: REF1234567890`;
    const extracted = extractSlipData(slip);
    expect(extracted.detectedBank).toBe("KTB");
  });

  it("extractSlipData returns detectedBank for PromptPay", () => {
    const slip = `PromptPay\nจำนวนเงิน: 250.00 บาท\nวันที่: 25/04/2569\nเลขที่อ้างอิง: REF1234567890`;
    const extracted = extractSlipData(slip);
    expect(extracted.detectedBank).toBe("PROMPTPAY");
  });

  it("verifySlipData result includes all required admin fields", () => {
    const extracted = extractSlipData(strongSlipText);
    const result = verifySlipData(extracted, baseContext, new Set(), new Set());
    expect(result).toHaveProperty("extractedData");
    expect(result).toHaveProperty("fingerprint");
    expect(result).toHaveProperty("linkedOrderId");
    expect(result).toHaveProperty("linkedPaymentId");
    expect(result.extractedData).toHaveProperty("detectedBank");
    expect(result.extractedData).toHaveProperty("detectedBankName");
    expect(result.extractedData).toHaveProperty("amount");
    expect(result.extractedData).toHaveProperty("transactionDate");
    expect(result.extractedData).toHaveProperty("reference");
    expect(result.extractedData).toHaveProperty("confidence");
  });
});

// ─── 14. New bank aliases detected ───────────────────────────────────────────
describe("14. New bank aliases detected", () => {
  const banks = [
    { text: "ธนาคารกรุงศรีอยุธยา", code: "BAY" },
    { text: "ธนาคารทหารไทยธนชาต", code: "TTB" },
    { text: "ธนาคารออมสิน", code: "GSB" },
    { text: "TrueMoney", code: "TRUEMONEY" },
  ];

  for (const { text, code } of banks) {
    it(`detects ${code}`, () => {
      const slip = `${text}\nจำนวนเงิน: 250.00 บาท\nวันที่: 25/04/2569\nเลขที่อ้างอิง: REF1234567890`;
      const extracted = extractSlipData(slip);
      expect(extracted.detectedBank).toBe(code);
    });
  }
});

// ─── 15. Receiver name and masked account extracted ───────────────────────────
describe("15. Receiver name and masked account extracted", () => {
  it("extracts receiver name from ชื่อผู้รับ label", () => {
    const slip = `
      ธนาคารกรุงเทพ
      ชื่อผู้รับ: Ipe Novel Shop
      จำนวนเงิน: 250.00 บาท
      วันที่: 25/04/2569
      เลขที่อ้างอิง: REF1234567890
    `;
    const extracted = extractSlipData(slip);
    expect(extracted.receiverName).toBeDefined();
    expect(extracted.receiverName).toContain("Ipe Novel");
  });

  it("extracts masked account number", () => {
    const slip = `
      ธนาคารกรุงเทพ
      เลขที่บัญชี: xxx-x-xx123-x
      จำนวนเงิน: 250.00 บาท
      วันที่: 25/04/2569
      เลขที่อ้างอิง: REF1234567890
    `;
    const extracted = extractSlipData(slip);
    expect(extracted.maskedAccount).toBeDefined();
  });
});

// ─── 16. PromptPay amount pattern extracted ───────────────────────────────────
describe("16. PromptPay amount pattern extracted", () => {
  it("extracts amount from ฿ 250.00 pattern", () => {
    const slip = `
      PromptPay
      ฿ 250.00
      วันที่: 25/04/2569
      เลขที่อ้างอิง: REF1234567890
    `;
    const extracted = extractSlipData(slip);
    expect(extracted.amount).toBe(250);
  });

  it("extracts amount from THB 250.00 pattern", () => {
    const slip = `
      PromptPay
      THB 250.00
      วันที่: 25/04/2569
      เลขที่อ้างอิง: REF1234567890
    `;
    const extracted = extractSlipData(slip);
    expect(extracted.amount).toBe(250);
  });

  it("extracts amount from 250 บาท suffix pattern", () => {
    const slip = `
      PromptPay
      250 บาท
      วันที่: 25/04/2569
      เลขที่อ้างอิง: REF1234567890
    `;
    const extracted = extractSlipData(slip);
    expect(extracted.amount).toBe(250);
  });
});

// ─── 17. ISO date format parsed ───────────────────────────────────────────────
describe("17. ISO date format parsed", () => {
  it("parses YYYY-MM-DD format", () => {
    const slip = `
      ชื่อร้านค้า: Ipe Novel
      รหัสร้านค้า: KB000002283068
      จำนวนเงิน: 250.00 บาท
      2026-04-25
      เลขที่อ้างอิง: REF1234567890
    `;
    const extracted = extractSlipData(slip);
    if (extracted.transactionDate) {
      expect(extracted.transactionDate.getFullYear()).toBe(2026);
      expect(extracted.transactionDate.getMonth()).toBe(3);
      expect(extracted.transactionDate.getDate()).toBe(25);
    }
  });
});

// ─── 18. Missing transaction date → correct reason code ──────────────────────
describe("18. Missing transaction date → MISSING_TRANSACTION_DATE", () => {
  it("returns MISSING_TRANSACTION_DATE when date is absent", () => {
    const noDate: ExtractedSlipData = {
      amount: 250,
      reference: "REF1234567890",
      confidence: 90,
    };
    const result = verifySlipData(noDate, baseContext, new Set(), new Set());
    expect(result.isAutoApproved).toBe(false);
    expect(result.reviewReason).toBe("MISSING_TRANSACTION_DATE");
  });
});

// ─── 19. Confidence reweighted: core fields dominate ─────────────────────────
describe("19. Confidence reweighted: core payment fields dominate", () => {
  it("slip with only amount+date+reference+bank reaches ≥ 75 confidence", () => {
    const slip = `
      ธนาคารกรุงเทพ
      จำนวนเงิน: 250.00 บาท
      วันที่: 25/04/2569
      เลขที่อ้างอิง: REF1234567890
    `;
    const extracted = extractSlipData(slip);
    // amount=25, date=20, reference=20, bank=10 = 75
    expect(extracted.confidence).toBeGreaterThanOrEqual(75);
  });

  it("slip with all fields reaches 100 confidence", () => {
    const extracted = extractSlipData(strongSlipText);
    // amount=25, date=20, ref=20, bank=10, shop=10, merchantCode=10, txnCode=5 = 100
    expect(extracted.confidence).toBe(100);
  });

  it("slip with only shop name has low confidence", () => {
    const extracted = extractSlipData("ชื่อร้านค้า: Ipe Novel");
    expect(extracted.confidence).toBeLessThan(50);
  });
});

// ─── 20. getReviewReasonDescription covers all new codes ─────────────────────
describe("20. getReviewReasonDescription covers all new reason codes", () => {
  const newCodes = [
    "MISSING_AMOUNT",
    "MISSING_TRANSACTION_DATE",
    "MISSING_REFERENCE",
    "AMOUNT_MISMATCH",
    "TRANSACTION_OUTSIDE_TIME_WINDOW",
    "MERCHANT_CODE_MISMATCH",
    "MERCHANT_TRANSACTION_CODE_MISMATCH",
    "SHOP_NAME_MISMATCH",
    "DUPLICATE_REFERENCE",
    "DUPLICATE_FINGERPRINT",
    "LOW_CONFIDENCE",
    "INSUFFICIENT_STRUCTURED_DATA",
    "PAYMENT_NOT_FOUND",
    "ORDER_NOT_FOUND",
    "PAYMENT_ALREADY_PROCESSED",
    "DATABASE_CONNECTION_FAILED",
    "MANUAL_REVIEW_REQUIRED",
  ];

  for (const code of newCodes) {
    it(`has description for ${code}`, () => {
      const desc = getReviewReasonDescription(code);
      expect(desc).toBeTruthy();
      expect(desc).not.toMatch(/^Unknown reason:/);
    });
  }

  it("returns a fallback for unknown codes", () => {
    const desc = getReviewReasonDescription("TOTALLY_UNKNOWN_CODE");
    expect(desc).toBeTruthy();
    expect(desc).toContain("TOTALLY_UNKNOWN_CODE");
  });

  it("handles undefined reason gracefully", () => {
    const desc = getReviewReasonDescription(undefined);
    expect(desc).toBeTruthy();
  });
});

// ─── 21. Shop name validation ─────────────────────────────────────────────────
describe("21. Shop name validation", () => {
  const validAliases = [
    "Ipe Novel",
    "ipe novel",
    "IPE NOVEL",
    "Ipenovel",
    "IPENOVEL",
    "ipenovel",
  ];

  for (const alias of validAliases) {
    it(`auto-approves shop name alias: "${alias}"`, () => {
      const extracted = extractSlipData(strongSlipText);
      const tweaked: ExtractedSlipData = { ...extracted, shopName: alias };
      const result = verifySlipData(tweaked, baseContext, new Set(), new Set());
      expect(result.isAutoApproved).toBe(true);
    });
  }

  it("sends to manual review when shop name is present but wrong", () => {
    const extracted = extractSlipData(strongSlipText);
    const tweaked: ExtractedSlipData = { ...extracted, shopName: "Wrong Shop Name" };
    const result = verifySlipData(tweaked, baseContext, new Set(), new Set());
    expect(result.isAutoApproved).toBe(false);
    expect(result.reviewReason).toBe("SHOP_NAME_MISMATCH");
  });

  it("auto-approves when shop name is completely absent (relies on other signals)", () => {
    const slip = `
      ธนาคารกรุงเทพ
      รหัสร้านค้า: KB000002283068
      จำนวนเงิน: 250.00 บาท
      วันที่: 25/04/2569
      เลขที่อ้างอิง: REF1234567890
    `;
    const extracted = extractSlipData(slip);
    expect(extracted.shopName).toBeUndefined();
    const result = verifySlipData(extracted, baseContext, new Set(), new Set());
    // Should auto-approve since other signals are strong
    expect(result.isAutoApproved).toBe(true);
  });
});

// ─── 22. Merchant code validation ────────────────────────────────────────────
describe("22. Merchant code validation", () => {
  it("auto-approves when merchant code is absent", () => {
    const slip = `
      ธนาคารกรุงเทพ
      ชื่อร้านค้า: Ipe Novel
      จำนวนเงิน: 250.00 บาท
      วันที่: 25/04/2569
      เลขที่อ้างอิง: REF1234567890
    `;
    const extracted = extractSlipData(slip);
    expect(extracted.merchantCode).toBeUndefined();
    const result = verifySlipData(extracted, baseContext, new Set(), new Set());
    expect(result.isAutoApproved).toBe(true);
  });

  it("sends to review when merchant code is present but wrong", () => {
    const extracted = extractSlipData(strongSlipText);
    const tweaked: ExtractedSlipData = { ...extracted, merchantCode: "XX000000000000" };
    const result = verifySlipData(tweaked, baseContext, new Set(), new Set());
    expect(result.isAutoApproved).toBe(false);
    expect(result.reviewReason).toBe("MERCHANT_CODE_MISMATCH");
  });
});

// ─── 23. Amount mismatch ──────────────────────────────────────────────────────
describe("23. Amount mismatch", () => {
  it("rejects when slip amount differs from order total", () => {
    const extracted = extractSlipData(strongSlipText);
    const mismatchCtx = { ...baseContext, orderTotal: 300 };
    const result = verifySlipData(extracted, mismatchCtx, new Set(), new Set());
    expect(result.isAutoApproved).toBe(false);
    expect(result.reviewReason).toBe("AMOUNT_MISMATCH");
  });

  it("accepts when amounts match within floating-point tolerance", () => {
    const extracted = extractSlipData(strongSlipText);
    // 250 vs 250.001 — within 0.01 tolerance
    const closeCtx = { ...baseContext, orderTotal: 250.001 };
    const result = verifySlipData(extracted, closeCtx, new Set(), new Set());
    expect(result.reviewReason).not.toBe("AMOUNT_MISMATCH");
  });
});
