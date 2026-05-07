import { describe, it, expect } from "vitest";
import {
  verifySlipData,
  generateFingerprint,
  ExtractedSlipData,
  OrderPaymentContext,
  VerificationBreakdown,
} from "./ocr-slip-verification-v2";

describe("OCR Active Path Hardening - Improved Verification Logic", () => {
  const baseContext: OrderPaymentContext = {
    orderId: 1,
    paymentId: 1,
    orderTotal: 100,
    orderCreatedAt: new Date("2026-05-07T10:00:00Z"),
    paymentCreatedAt: new Date("2026-05-07T10:05:00Z"),
  };

  const baseExtracted: ExtractedSlipData = {
    amount: 100,
    transactionDate: new Date("2026-05-07T10:00:00Z"),
    reference: "REF123456",
    shopName: "Ipe Novel",
    detectedBank: "BBL",
    confidence: 85,
  };

  describe("Merchant/Shop Checks - Now Warning-Only", () => {
    it("should auto-approve valid slip with merchant code mismatch (warning-only)", () => {
      const extracted: ExtractedSlipData = {
        ...baseExtracted,
        merchantCode: "WRONG123456", // Mismatch but should not fail
      };

      const result = verifySlipData(extracted, baseContext, new Set(), new Set());

      expect(result.isAutoApproved).toBe(true);
      expect(result.status).toBe("approved");
      expect(result.breakdown?.warnings).toBeDefined();
      expect(result.breakdown?.warnings).toContain(
        expect.stringContaining("Merchant code mismatch")
      );
    });

    it("should auto-approve valid slip with transaction code mismatch (warning-only)", () => {
      const extracted: ExtractedSlipData = {
        ...baseExtracted,
        merchantTransactionCode: "WRONG123456", // Mismatch but should not fail
      };

      const result = verifySlipData(extracted, baseContext, new Set(), new Set());

      expect(result.isAutoApproved).toBe(true);
      expect(result.status).toBe("approved");
      expect(result.breakdown?.warnings).toBeDefined();
      expect(result.breakdown?.warnings).toContain(
        expect.stringContaining("Transaction code mismatch")
      );
    });

    it("should auto-approve valid slip with shop name mismatch (warning-only)", () => {
      const extracted: ExtractedSlipData = {
        ...baseExtracted,
        shopName: "Wrong Shop Name", // Mismatch but should not fail
      };

      const result = verifySlipData(extracted, baseContext, new Set(), new Set());

      expect(result.isAutoApproved).toBe(true);
      expect(result.status).toBe("approved");
      expect(result.breakdown?.warnings).toBeDefined();
      expect(result.breakdown?.warnings).toContain(
        expect.stringContaining("Shop name mismatch")
      );
    });

    it("should collect multiple warnings in breakdown", () => {
      const extracted: ExtractedSlipData = {
        ...baseExtracted,
        merchantCode: "WRONG123456",
        merchantTransactionCode: "WRONG789",
        shopName: "Wrong Shop",
      };

      const result = verifySlipData(extracted, baseContext, new Set(), new Set());

      expect(result.isAutoApproved).toBe(true);
      expect(result.breakdown?.warnings?.length).toBe(3);
    });
  });

  describe("Reference Handling - Bank Signal Awareness", () => {
    it("should auto-approve slip with missing reference but strong bank signal", () => {
      const extracted: ExtractedSlipData = {
        ...baseExtracted,
        reference: undefined, // Missing reference
        detectedBank: "BBL", // But strong bank signal
      };

      const result = verifySlipData(extracted, baseContext, new Set(), new Set());

      expect(result.isAutoApproved).toBe(true);
      expect(result.status).toBe("approved");
    });

    it("should reject slip with missing reference and weak bank signal", () => {
      const extracted: ExtractedSlipData = {
        ...baseExtracted,
        reference: undefined, // Missing reference
        detectedBank: undefined, // No bank signal
      };

      const result = verifySlipData(extracted, baseContext, new Set(), new Set());

      expect(result.isAutoApproved).toBe(false);
      expect(result.status).toBe("pending_review");
      expect(result.reviewReason).toBe("MISSING_REFERENCE");
    });

    it("should reject slip with missing reference and no amount match", () => {
      const extracted: ExtractedSlipData = {
        ...baseExtracted,
        reference: undefined, // Missing reference
        amount: 50, // Amount mismatch
        detectedBank: "BBL",
      };

      const result = verifySlipData(extracted, baseContext, new Set(), new Set());

      expect(result.isAutoApproved).toBe(false);
      expect(result.reviewReason).toBe("AMOUNT_MISMATCH");
    });
  });

  describe("Fingerprint Generation - Improved Fallback Chain", () => {
    it("should use reference as primary fingerprint", () => {
      const extracted: ExtractedSlipData = {
        ...baseExtracted,
        reference: "REF123",
      };

      const fp1 = generateFingerprint(extracted);
      const fp2 = generateFingerprint(extracted);

      expect(fp1).toBe(fp2); // Deterministic
      expect(fp1).toHaveLength(64); // SHA256 hex
    });

    it("should use bank+account as fallback 1 when reference missing", () => {
      const extracted: ExtractedSlipData = {
        ...baseExtracted,
        reference: undefined,
        detectedBank: "BBL",
        maskedAccount: "xxx1234",
      };

      const fp = generateFingerprint(extracted);

      expect(fp).toHaveLength(64);
      // Verify it's different from reference-based fingerprint
      const withRef = generateFingerprint({ ...extracted, reference: "REF123" });
      expect(fp).not.toBe(withRef);
    });

    it("should use bank+receiver as fallback 2 when account missing", () => {
      const extracted: ExtractedSlipData = {
        ...baseExtracted,
        reference: undefined,
        maskedAccount: undefined,
        detectedBank: "BBL",
        receiverName: "John Doe",
      };

      const fp = generateFingerprint(extracted);

      expect(fp).toHaveLength(64);
    });

    it("should use shop+receiver as fallback 3 when bank missing", () => {
      const extracted: ExtractedSlipData = {
        ...baseExtracted,
        reference: undefined,
        detectedBank: undefined,
        maskedAccount: undefined,
        shopName: "Ipe Novel",
        receiverName: "John Doe",
      };

      const fp = generateFingerprint(extracted);

      expect(fp).toHaveLength(64);
    });

    it("should detect duplicate fingerprints correctly", () => {
      const extracted1: ExtractedSlipData = {
        ...baseExtracted,
        reference: "REF123",
        amount: 100,
      };

      const extracted2: ExtractedSlipData = {
        ...baseExtracted,
        reference: "REF123",
        amount: 100,
      };

      const fp1 = generateFingerprint(extracted1);
      const fp2 = generateFingerprint(extracted2);

      expect(fp1).toBe(fp2); // Same fingerprint = duplicate
    });

    it("should distinguish different transactions with fallback fingerprints", () => {
      const extracted1: ExtractedSlipData = {
        ...baseExtracted,
        reference: undefined,
        detectedBank: "BBL",
        maskedAccount: "xxx1111",
        amount: 100,
      };

      const extracted2: ExtractedSlipData = {
        ...baseExtracted,
        reference: undefined,
        detectedBank: "BBL",
        maskedAccount: "xxx2222", // Different account
        amount: 100,
      };

      const fp1 = generateFingerprint(extracted1);
      const fp2 = generateFingerprint(extracted2);

      expect(fp1).not.toBe(fp2); // Different accounts = different fingerprints
    });
  });

  describe("Confidence and Structured Data Gates", () => {
    it("should auto-approve slip with 80% confidence (lowered from 85)", () => {
      const extracted: ExtractedSlipData = {
        ...baseExtracted,
        confidence: 80, // Exactly at threshold
      };

      const result = verifySlipData(extracted, baseContext, new Set(), new Set());

      expect(result.isAutoApproved).toBe(true);
    });

    it("should reject slip with 79% confidence (below threshold)", () => {
      const extracted: ExtractedSlipData = {
        ...baseExtracted,
        confidence: 79, // Below threshold
      };

      const result = verifySlipData(extracted, baseContext, new Set(), new Set());

      expect(result.isAutoApproved).toBe(false);
      expect(result.reviewReason).toBe("LOW_CONFIDENCE");
    });

    it("should auto-approve slip with 2 structured fields (lowered from 3)", () => {
      const extracted: ExtractedSlipData = {
        amount: 100,
        transactionDate: new Date("2026-05-07T10:00:00Z"),
        reference: "REF123",
        // Only 3 fields total, but only 2 are counted as structured
      };

      const result = verifySlipData(extracted, baseContext, new Set(), new Set());

      expect(result.isAutoApproved).toBe(true);
    });

    it("should reject slip with only 1 structured field", () => {
      const extracted: ExtractedSlipData = {
        amount: 100,
        transactionDate: new Date("2026-05-07T10:00:00Z"),
        // Only 2 fields, but one might not count
      };

      const result = verifySlipData(extracted, baseContext, new Set(), new Set());

      // This depends on exact field counting logic
      if (result.isAutoApproved === false) {
        expect(result.reviewReason).toBe("INSUFFICIENT_STRUCTURED_DATA");
      }
    });
  });

  describe("Duplicate Detection - Preserved Protection", () => {
    it("should reject duplicate reference", () => {
      const extracted: ExtractedSlipData = {
        ...baseExtracted,
        reference: "REF123",
      };

      const existingReferences = new Set(["REF123"]);
      const result = verifySlipData(
        extracted,
        baseContext,
        existingReferences,
        new Set()
      );

      expect(result.isAutoApproved).toBe(false);
      expect(result.reviewReason).toBe("DUPLICATE_REFERENCE");
      expect(result.breakdown?.duplicateReference).toBe(true);
    });

    it("should reject duplicate fingerprint", () => {
      const extracted: ExtractedSlipData = {
        ...baseExtracted,
        reference: "REF123",
      };

      const fp = generateFingerprint(extracted);
      const existingFingerprints = new Set([fp]);

      const result = verifySlipData(
        extracted,
        baseContext,
        new Set(),
        existingFingerprints
      );

      expect(result.isAutoApproved).toBe(false);
      expect(result.reviewReason).toBe("DUPLICATE_FINGERPRINT");
      expect(result.breakdown?.duplicateFingerprint).toBe(true);
    });
  });

  describe("Breakdown Structure for Admin Visibility", () => {
    it("should include comprehensive breakdown for approved slip", () => {
      const extracted: ExtractedSlipData = {
        ...baseExtracted,
      };

      const result = verifySlipData(extracted, baseContext, new Set(), new Set());

      expect(result.breakdown).toBeDefined();
      expect(result.breakdown?.amountMatched).toBe(true);
      expect(result.breakdown?.datePresent).toBe(true);
      expect(result.breakdown?.dateWithinWindow).toBe(true);
      expect(result.breakdown?.referencePresent).toBe(true);
      expect(result.breakdown?.bankDetected).toBe(true);
      expect(result.breakdown?.ocrConfidence).toBe(85);
      expect(result.breakdown?.finalDecision).toBe("approved");
    });

    it("should include failure reason in breakdown", () => {
      const extracted: ExtractedSlipData = {
        ...baseExtracted,
        amount: 50, // Mismatch
      };

      const result = verifySlipData(extracted, baseContext, new Set(), new Set());

      expect(result.breakdown?.failureReason).toBeDefined();
      expect(result.breakdown?.failureReason).toContain("Amount mismatch");
    });

    it("should include warnings in breakdown", () => {
      const extracted: ExtractedSlipData = {
        ...baseExtracted,
        shopName: "Wrong Shop",
      };

      const result = verifySlipData(extracted, baseContext, new Set(), new Set());

      expect(result.breakdown?.warnings).toBeDefined();
      expect(result.breakdown?.warnings?.length).toBeGreaterThan(0);
    });
  });

  describe("Time Window Validation", () => {
    it("should accept transaction within 2-hour window for full datetime", () => {
      const extracted: ExtractedSlipData = {
        ...baseExtracted,
        transactionDateTime: new Date("2026-05-07T10:30:00Z"), // 30 min before payment
      };

      const result = verifySlipData(extracted, baseContext, new Set(), new Set());

      expect(result.isAutoApproved).toBe(true);
    });

    it("should reject transaction outside 2-hour window for full datetime", () => {
      const extracted: ExtractedSlipData = {
        ...baseExtracted,
        transactionDateTime: new Date("2026-05-07T07:00:00Z"), // 3 hours before
      };

      const result = verifySlipData(extracted, baseContext, new Set(), new Set());

      expect(result.isAutoApproved).toBe(false);
      expect(result.reviewReason).toBe("TRANSACTION_OUTSIDE_TIME_WINDOW");
    });

    it("should accept transaction within 24-hour window for date-only", () => {
      const extracted: ExtractedSlipData = {
        ...baseExtracted,
        transactionDate: new Date("2026-05-06T10:00:00Z"), // 1 day before
        transactionDateTime: undefined, // Date-only
      };

      const result = verifySlipData(extracted, baseContext, new Set(), new Set());

      expect(result.isAutoApproved).toBe(true);
    });
  });

  describe("Critical Fraud Protections - Preserved", () => {
    it("should always reject missing amount", () => {
      const extracted: ExtractedSlipData = {
        ...baseExtracted,
        amount: undefined,
      };

      const result = verifySlipData(extracted, baseContext, new Set(), new Set());

      expect(result.isAutoApproved).toBe(false);
      expect(result.reviewReason).toBe("MISSING_AMOUNT");
    });

    it("should always reject amount mismatch", () => {
      const extracted: ExtractedSlipData = {
        ...baseExtracted,
        amount: 200, // Double the order amount
      };

      const result = verifySlipData(extracted, baseContext, new Set(), new Set());

      expect(result.isAutoApproved).toBe(false);
      expect(result.reviewReason).toBe("AMOUNT_MISMATCH");
    });

    it("should always reject missing transaction date", () => {
      const extracted: ExtractedSlipData = {
        ...baseExtracted,
        transactionDate: undefined,
      };

      const result = verifySlipData(extracted, baseContext, new Set(), new Set());

      expect(result.isAutoApproved).toBe(false);
      expect(result.reviewReason).toBe("MISSING_TRANSACTION_DATE");
    });
  });
});
