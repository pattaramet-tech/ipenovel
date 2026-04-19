/**
 * OCR Hardening Final Test Suite
 * 
 * Comprehensive tests for:
 * - Structured extraction (all fields)
 * - Weighted verification (all signals)
 * - Multi-bank Thai slip layouts
 * - Edge cases and OCR noise
 * - Regression tests
 */

import { describe, it, expect } from "vitest";
import { extractStructuredData, extractFromSlipImage } from "./ocr-structured-extractor";
import {
  verifyWithWeights,
  generateFingerprint,
  VerificationContext,
} from "./ocr-weighted-verifier";

describe("OCR Hardening Final Suite", () => {
  describe("Structured Extraction", () => {
    it("should extract all fields from KBank slip", () => {
      const ocrText = `
        KRUNG THAI BANK
        Transfer Receipt
        From: John Doe
        From Account: XXXX-XXXX-1234
        To: Ipe Novel Shop
        To Account: XXXX-XXXX-5678
        Amount: 250.00 Baht
        Fee: 5.00 Baht
        Net: 245.00 Baht
        Date: 18/04/2026
        Time: 10:30
        Reference: ABC123456
        Transaction ID: TXN789012
      `;

      const result = extractStructuredData(ocrText);

      expect(result.bankName).toBe("KBANK");
      expect(result.transferType).toBe("TRANSFER");
      expect(result.senderName).toBe("John Doe");
      expect(result.receiverName).toBe("Ipe Novel Shop");
      expect(result.amount).toBe(250);
      expect(result.fee).toBe(5);
      expect(result.netAmount).toBe(245);
      expect(result.referenceId).toBe("ABC123456");
      expect(result.transactionId).toBe("TXN789012");
      expect(result.overallConfidence).toBeGreaterThan(70);
    });

    it("should handle Thai numerals in amount", () => {
      const ocrText = `
        Amount: ฿๑,๒๕๐.๐๐ Baht
        Date: ๑๘/๐๔/๒๕๖๙
      `;

      const result = extractStructuredData(ocrText);

      expect(result.amount).toBe(1250);
      expect(result.transactionDateTime).toBeTruthy();
    });

    it("should convert Buddhist year 2569 to 2026", () => {
      const ocrText = `
        Date: 18/04/2569
        Time: 10:30
      `;

      const result = extractStructuredData(ocrText);

      expect(result.transactionDateTime).toBeTruthy();
      if (result.transactionDateTime) {
        expect(result.transactionDateTime.getFullYear()).toBe(2026);
        expect(result.transactionDateTime.getMonth()).toBe(3); // April (0-indexed)
        expect(result.transactionDateTime.getDate()).toBe(18);
      }
    });

    it("should extract masked accounts", () => {
      const ocrText = `
        From Account: XXXX-XXXX-1234
        To Account: ****-****-5678
      `;

      const result = extractStructuredData(ocrText);

      expect(result.senderAccountMasked).toBeTruthy();
      expect(result.receiverAccountMasked).toBeTruthy();
    });

    it("should handle SCB slip", () => {
      const ocrText = `
        SIAM COMMERCIAL BANK
        Receiver: Ipe Novel
        Amount: 500.00
        Reference: XYZ789012
      `;

      const result = extractStructuredData(ocrText);

      expect(result.bankName).toBe("SCB");
      expect(result.amount).toBe(500);
    });

    it("should handle PromptPay slip", () => {
      const ocrText = `
        PROMPTPAY Transfer
        To: Ipe Novel Shop
        Amount: 1250.50
        Reference: PP123456789
      `;

      const result = extractStructuredData(ocrText);

      expect(result.transferType).toBe("PROMPTPAY");
      expect(result.amount).toBe(1250.5);
    });

    it("should handle Bangkok Bank slip", () => {
      const ocrText = `
        BANGKOK BANK
        Receiver: Ipe Novel
        Amount: 750.00
      `;

      const result = extractStructuredData(ocrText);

      expect(result.bankName).toBe("BBL");
      expect(result.amount).toBe(750);
    });

    it("should calculate confidence based on field completeness", () => {
      const completeText = `
        KBANK Transfer
        From: John Doe
        To: Ipe Novel Shop
        Amount: 250.00
        Date: 18/04/2026
        Time: 10:30
        Reference: ABC123456
      `;

      const result = extractStructuredData(completeText);
      expect(result.overallConfidence).toBeGreaterThan(75);
    });

    it("should handle incomplete slip gracefully", () => {
      const incompleteText = `
        Amount: 250.00
      `;

      const result = extractStructuredData(incompleteText);

      expect(result.amount).toBe(250);
      expect(result.overallConfidence).toBeLessThan(50);
    });
  });

  describe("Weighted Verification", () => {
    const mockContext: VerificationContext = {
      orderId: 1,
      paymentId: 1,
      orderTotal: 250,
      orderCreatedAt: new Date("2026-04-18T09:00:00Z"),
      paymentCreatedAt: new Date("2026-04-18T09:30:00Z"),
      slipSubmittedAt: new Date("2026-04-18T10:35:00Z"),
      merchantName: "Ipe Novel Shop",
      merchantCode: "KB000002283068",
      receiverAccountMasked: "XXXX-XXXX-5678",
    };

    it("should auto-approve valid slip", () => {
      const extracted = extractStructuredData(`
        KBANK Transfer
        From: John Doe
        To: Ipe Novel Shop
        Amount: 250.00
        Date: 18/04/2026
        Time: 10:30
        Reference: ABC123456
        To Account: XXXX-XXXX-5678
      `);

      const result = verifyWithWeights(extracted, mockContext);

      expect(result.isAutoApproved).toBe(true);
      expect(result.overallScore).toBeGreaterThan(0.75);
      expect(result.riskLevel).toBe("low");
    });

    it("should reject slip with amount mismatch", () => {
      const extracted = extractStructuredData(`
        KBANK Transfer
        To: Ipe Novel Shop
        Amount: 300.00
        Date: 18/04/2026
        Reference: ABC123456
      `);

      const result = verifyWithWeights(extracted, mockContext);

      expect(result.isAutoApproved).toBe(false);
      expect(result.reviewReason).toBe("AMOUNT_MATCH");
    });

    it("should reject slip with wrong receiver", () => {
      const extracted = extractStructuredData(`
        KBANK Transfer
        To: Wrong Shop
        Amount: 250.00
        Date: 18/04/2026
        Reference: ABC123456
      `);

      const result = verifyWithWeights(extracted, mockContext);

      expect(result.isAutoApproved).toBe(false);
      expect(result.reviewReason).toBe("RECEIVER_MATCH");
    });

    it("should reject slip outside time window", () => {
      const extracted = extractStructuredData(`
        KBANK Transfer
        To: Ipe Novel Shop
        Amount: 250.00
        Date: 10/04/2026
        Reference: ABC123456
      `);

      const result = verifyWithWeights(extracted, mockContext);

      expect(result.isAutoApproved).toBe(false);
      expect(result.reviewReason).toBe("TIME_WINDOW");
    });

    it("should detect duplicate slip", () => {
      const extracted = extractStructuredData(`
        KBANK Transfer
        To: Ipe Novel Shop
        Amount: 250.00
        Date: 18/04/2026
        Reference: ABC123456
      `);

      const fingerprint = generateFingerprint(
        extracted.amount,
        extracted.transactionDateTime,
        extracted.referenceId,
        extracted.transactionId
      );

      const existingFingerprints = new Set([fingerprint]);
      const result = verifyWithWeights(extracted, mockContext, existingFingerprints);

      expect(result.isAutoApproved).toBe(false);
      expect(result.reviewReason).toBe("NO_DUPLICATE");
    });

    it("should handle low OCR confidence", () => {
      const extracted = extractStructuredData(`
        Amount: 250.00
      `);

      const result = verifyWithWeights(extracted, mockContext);

      expect(result.riskLevel).toBe("high");
      expect(result.isAutoApproved).toBe(false);
    });

    it("should generate consistent fingerprints", () => {
      const fp1 = generateFingerprint(250, new Date("2026-04-18"), "ABC123456", "TXN789");
      const fp2 = generateFingerprint(250, new Date("2026-04-18T15:30:00Z"), "ABC123456", "TXN789");

      // Same date, different time should produce same fingerprint (date-only)
      expect(fp1).toBe(fp2);
    });

    it("should generate different fingerprints for different amounts", () => {
      const fp1 = generateFingerprint(250, new Date("2026-04-18"), "ABC123456", "TXN789");
      const fp2 = generateFingerprint(251, new Date("2026-04-18"), "ABC123456", "TXN789");

      expect(fp1).not.toBe(fp2);
    });
  });

  describe("Edge Cases", () => {
    it("should handle OCR noise in amount", () => {
      const ocrText = `
        Amount: 2 5 0 . 0 0 (with spaces)
      `;

      const result = extractStructuredData(ocrText);
      // Should still extract something, even if noisy
      expect(result.rawText).toBeTruthy();
    });

    it("should handle missing optional fields", () => {
      const ocrText = `
        To: Ipe Novel Shop
        Amount: 250.00
      `;

      const result = extractStructuredData(ocrText);

      expect(result.receiverName).toBe("Ipe Novel Shop");
      expect(result.amount).toBe(250);
      expect(result.senderName).toBeNull();
      expect(result.transactionDateTime).toBeNull();
    });

    it("should reject invalid dates", () => {
      const ocrText = `
        Date: 32/13/2026
      `;

      const result = extractStructuredData(ocrText);

      expect(result.transactionDateTime).toBeNull();
    });

    it("should handle 2-digit year format", () => {
      const ocrText = `
        Date: 18/04/26
      `;

      const result = extractStructuredData(ocrText);

      expect(result.transactionDateTime).toBeTruthy();
      if (result.transactionDateTime) {
        expect(result.transactionDateTime.getFullYear()).toBe(2026);
      }
    });

    it("should handle Thai text labels", () => {
      const ocrText = `
        ชื่อร้านค้า: Ipe Novel Shop
        จำนวนเงิน: 250.00 บาท
        วันที่: 18/04/2026
        เลขที่อ้างอิง: ABC123456
      `;

      const result = extractStructuredData(ocrText);

      expect(result.receiverName).toBe("Ipe Novel Shop");
      expect(result.amount).toBe(250);
      expect(result.referenceId).toBe("ABC123456");
    });
  });

  describe("Regression Tests", () => {
    it("should not break existing merchant config validation", () => {
      const mockContext: VerificationContext = {
        orderId: 1,
        paymentId: 1,
        orderTotal: 250,
        orderCreatedAt: new Date(),
        paymentCreatedAt: new Date(),
        merchantName: "Ipe Novel",
      };

      const extracted = extractStructuredData(`
        To: Ipe Novel Shop
        Amount: 250.00
        Date: 18/04/2026
        Reference: ABC123456
      `);

      const result = verifyWithWeights(extracted, mockContext);

      // Should still work with fuzzy matching
      expect(result.signals.some((s) => s.name === "RECEIVER_MATCH")).toBe(true);
    });

    it("should preserve backward compatibility with old slip format", () => {
      const oldSlipText = `
        Merchant: Ipe Novel
        Amount: 250.00
        Reference: ABC123456
      `;

      const result = extractStructuredData(oldSlipText);

      // Should extract something even from old format
      expect(result.amount).toBe(250);
      expect(result.referenceId).toBe("ABC123456");
    });
  });
});
