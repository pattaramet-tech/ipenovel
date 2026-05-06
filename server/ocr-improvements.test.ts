import { describe, it, expect, beforeEach } from "vitest";
import { verifySlipDataImproved, getRejectionMetrics, resetRejectionMetrics } from "./ocr-slip-verification-improved";

describe("OCR Improvements - Rejection Reason Analysis", () => {
  beforeEach(() => {
    resetRejectionMetrics();
  });

  const mockContext = {
    orderId: 123,
    paymentId: 456,
    orderTotal: 299.00,
    paymentCreatedAt: new Date("2026-04-29T14:30:00Z"),
  };

  const mockMerchantConfig = {
    merchantCode: "KB000002283068",
    merchantTransactionCode: "TXN123",
    shopNameAliases: ["Ipe Novel", "Ipenovel", "ipe-novel"],
  };

  // ─── Test 1: Strong valid slip with all signals ────────────────────────────
  it("should AUTO-APPROVE strong valid slip with all signals", () => {
    const extracted = {
      amount: 299.00,
      transactionDate: new Date("2026-04-29T14:00:00Z"),
      transactionDateTime: true,
      reference: "TXN123456",
      detectedBank: "BBL",
      shopName: "Ipe Novel",
      merchantCode: "KB000002283068",
      receiverName: "Ipenovel Store",
      confidence: 92,
    };

    const result = verifySlipDataImproved(
      extracted as any,
      mockContext,
      new Set(),
      new Set(),
      mockMerchantConfig
    );

    expect(result.isAutoApproved).toBe(true);
    expect(result.reviewReason).toBeUndefined();
    expect(getRejectionMetrics().AUTO_APPROVED).toBe(1);
  });

  // ─── Test 2: Valid slip without merchant code (should now pass) ────────────
  it("should AUTO-APPROVE valid slip without merchant code (IMPROVEMENT)", () => {
    const extracted = {
      amount: 299.00,
      transactionDate: new Date("2026-04-29T14:00:00Z"),
      transactionDateTime: true,
      reference: "TXN123456",
      detectedBank: "BBL",
      shopName: "Ipe Novel",
      receiverName: "Ipenovel Store",
      confidence: 88,
    };

    const result = verifySlipDataImproved(
      extracted as any,
      mockContext,
      new Set(),
      new Set(),
      mockMerchantConfig
    );

    expect(result.isAutoApproved).toBe(true);
    expect(result.reviewReason).toBeUndefined();
  });

  // ─── Test 3: Valid slip with wrong merchant code (should now pass) ────────
  it("should AUTO-APPROVE valid slip with wrong merchant code (IMPROVEMENT)", () => {
    const extracted = {
      amount: 299.00,
      transactionDate: new Date("2026-04-29T14:00:00Z"),
      transactionDateTime: true,
      reference: "TXN123456",
      detectedBank: "BBL",
      shopName: "Ipe Novel",
      merchantCode: "KB999999999999", // Wrong code
      receiverName: "Ipenovel Store",
      confidence: 88,
    };

    const result = verifySlipDataImproved(
      extracted as any,
      mockContext,
      new Set(),
      new Set(),
      mockMerchantConfig
    );

    expect(result.isAutoApproved).toBe(true);
    expect(result.reviewReason).toBeUndefined();
  });

  // ─── Test 4: Valid slip with wrong shop name (should now pass) ────────────
  it("should AUTO-APPROVE valid slip with wrong shop name (IMPROVEMENT)", () => {
    const extracted = {
      amount: 299.00,
      transactionDate: new Date("2026-04-29T14:00:00Z"),
      transactionDateTime: true,
      reference: "TXN123456",
      detectedBank: "BBL",
      shopName: "Wrong Shop Name",
      merchantCode: "KB000002283068",
      receiverName: "Ipenovel Store",
      confidence: 88,
    };

    const result = verifySlipDataImproved(
      extracted as any,
      mockContext,
      new Set(),
      new Set(),
      mockMerchantConfig
    );

    expect(result.isAutoApproved).toBe(true);
    expect(result.reviewReason).toBeUndefined();
  });

  // ─── Test 5: Valid date-only slip within 48h window (IMPROVEMENT) ────────
  it("should AUTO-APPROVE valid date-only slip within 48h window (IMPROVEMENT)", () => {
    const extracted = {
      amount: 299.00,
      transactionDate: new Date("2026-04-28T14:00:00Z"), // 2 days old
      transactionDateTime: false, // Date-only
      reference: "TXN123456",
      detectedBank: "BBL",
      shopName: "Ipe Novel",
      confidence: 85,
    };

    const result = verifySlipDataImproved(
      extracted as any,
      mockContext,
      new Set(),
      new Set(),
      mockMerchantConfig
    );

    expect(result.isAutoApproved).toBe(true);
    expect(result.reviewReason).toBeUndefined();
  });

  // ─── Test 6: Slip with confidence 80% (IMPROVEMENT: was 85%) ──────────────
  it("should AUTO-APPROVE slip with 80% confidence (IMPROVEMENT from 85%)", () => {
    const extracted = {
      amount: 299.00,
      transactionDate: new Date("2026-04-29T14:00:00Z"),
      transactionDateTime: true,
      reference: "TXN123456",
      detectedBank: "BBL",
      shopName: "Ipe Novel",
      confidence: 80, // Exactly 80%
    };

    const result = verifySlipDataImproved(
      extracted as any,
      mockContext,
      new Set(),
      new Set(),
      mockMerchantConfig
    );

    expect(result.isAutoApproved).toBe(true);
    expect(result.reviewReason).toBeUndefined();
  });

  // ─── Test 7: Slip with only 2 structured fields (IMPROVEMENT: was 3) ──────
  it("should AUTO-APPROVE slip with 2 structured fields (IMPROVEMENT from 3)", () => {
    const extracted = {
      amount: 299.00,
      transactionDate: new Date("2026-04-29T14:00:00Z"),
      transactionDateTime: true,
      reference: "TXN123456",
      detectedBank: null,
      shopName: null,
      confidence: 85,
    };

    const result = verifySlipDataImproved(
      extracted as any,
      mockContext,
      new Set(),
      new Set(),
      mockMerchantConfig
    );

    expect(result.isAutoApproved).toBe(true);
    expect(result.reviewReason).toBeUndefined();
  });

  // ─── Test 8: Slip without reference but strong bank signal (IMPROVEMENT) ──
  it("should AUTO-APPROVE slip without reference but strong bank signal (IMPROVEMENT)", () => {
    const extracted = {
      amount: 299.00,
      transactionDate: new Date("2026-04-29T14:00:00Z"),
      transactionDateTime: true,
      reference: null, // No reference
      detectedBank: "BBL", // Strong bank signal
      shopName: "Ipe Novel",
      confidence: 88,
    };

    const result = verifySlipDataImproved(
      extracted as any,
      mockContext,
      new Set(),
      new Set(),
      mockMerchantConfig
    );

    expect(result.isAutoApproved).toBe(true);
    expect(result.reviewReason).toBeUndefined();
  });

  // ─── Test 9: Slip with too low confidence (should still fail) ─────────────
  it("should REJECT slip with confidence < 80%", () => {
    const extracted = {
      amount: 299.00,
      transactionDate: new Date("2026-04-29T14:00:00Z"),
      transactionDateTime: true,
      reference: "TXN123456",
      detectedBank: "BBL",
      shopName: "Ipe Novel",
      confidence: 79, // Just below 80%
    };

    const result = verifySlipDataImproved(
      extracted as any,
      mockContext,
      new Set(),
      new Set(),
      mockMerchantConfig
    );

    expect(result.isAutoApproved).toBe(false);
    expect(result.reviewReason).toBe("LOW_CONFIDENCE");
    expect(getRejectionMetrics().LOW_CONFIDENCE).toBe(1);
  });

  // ─── Test 10: Slip with amount mismatch (should still fail) ──────────────
  it("should REJECT slip with amount mismatch", () => {
    const extracted = {
      amount: 300.00, // Wrong amount
      transactionDate: new Date("2026-04-29T14:00:00Z"),
      transactionDateTime: true,
      reference: "TXN123456",
      detectedBank: "BBL",
      shopName: "Ipe Novel",
      confidence: 88,
    };

    const result = verifySlipDataImproved(
      extracted as any,
      mockContext,
      new Set(),
      new Set(),
      mockMerchantConfig
    );

    expect(result.isAutoApproved).toBe(false);
    expect(result.reviewReason).toBe("AMOUNT_MISMATCH");
    expect(getRejectionMetrics().AMOUNT_MISMATCH).toBe(1);
  });

  // ─── Test 11: Slip with duplicate reference (should still fail) ──────────
  it("should REJECT slip with duplicate reference", () => {
    const extracted = {
      amount: 299.00,
      transactionDate: new Date("2026-04-29T14:00:00Z"),
      transactionDateTime: true,
      reference: "TXN123456",
      detectedBank: "BBL",
      shopName: "Ipe Novel",
      confidence: 88,
    };

    const existingReferences = new Set(["TXN123456"]);

    const result = verifySlipDataImproved(
      extracted as any,
      mockContext,
      existingReferences,
      new Set(),
      mockMerchantConfig
    );

    expect(result.isAutoApproved).toBe(false);
    expect(result.reviewReason).toBe("DUPLICATE_REFERENCE");
    expect(getRejectionMetrics().DUPLICATE_REFERENCE).toBe(1);
  });

  // ─── Test 12: Slip outside time window (should still fail) ──────────────
  it("should REJECT slip outside time window", () => {
    const extracted = {
      amount: 299.00,
      transactionDate: new Date("2026-04-26T14:00:00Z"), // 3+ days old
      transactionDateTime: false, // Date-only
      reference: "TXN123456",
      detectedBank: "BBL",
      shopName: "Ipe Novel",
      confidence: 88,
    };

    const result = verifySlipDataImproved(
      extracted as any,
      mockContext,
      new Set(),
      new Set(),
      mockMerchantConfig
    );

    expect(result.isAutoApproved).toBe(false);
    expect(result.reviewReason).toBe("TRANSACTION_OUTSIDE_TIME_WINDOW");
    expect(getRejectionMetrics().TRANSACTION_OUTSIDE_TIME_WINDOW).toBe(1);
  });

  // ─── Test 13: Metrics summary ──────────────────────────────────────────────
  it("should track rejection metrics correctly", () => {
    resetRejectionMetrics();

    // Run multiple tests
    const validSlip = {
      amount: 299.00,
      transactionDate: new Date("2026-04-29T14:00:00Z"),
      transactionDateTime: true,
      reference: "TXN123456",
      detectedBank: "BBL",
      confidence: 88,
    };

    verifySlipDataImproved(validSlip as any, mockContext, new Set(), new Set(), mockMerchantConfig);
    verifySlipDataImproved(validSlip as any, mockContext, new Set(), new Set(), mockMerchantConfig);

    const invalidSlip = { ...validSlip, confidence: 75 };
    verifySlipDataImproved(invalidSlip as any, mockContext, new Set(), new Set(), mockMerchantConfig);

    const metrics = getRejectionMetrics();
    expect(metrics.AUTO_APPROVED).toBe(2);
    expect(metrics.LOW_CONFIDENCE).toBe(1);
  });
});
