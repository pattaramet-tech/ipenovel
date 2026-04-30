import { describe, it, expect } from "vitest";
import {
  generateApprovalNote,
  generateManualReviewNote,
  generateShadowModeNote,
  generateVerificationSummary,
} from "./_core/ocr-order-notes";

describe("OCR Order History Notes", () => {
  describe("generateApprovalNote", () => {
    it("should generate comprehensive approval note with all details", () => {
      const note = generateApprovalNote({
        isAutoApproved: true,
        isShadowMode: false,
        ocrConfidence: 92,
        detectedBank: "Bangkok Bank (BBL)",
        extractedAmount: 299.0,
        orderTotal: 299.0,
        extractedDate: "2026-04-29 14:30",
        breakdown: {
          amountMatched: true,
          datePresent: true,
          dateWithinWindow: true,
          referencePresent: true,
          duplicateReference: false,
          duplicateFingerprint: false,
          bankDetected: true,
          ocrConfidence: 92,
          finalDecision: "approved",
        },
      });

      expect(note).toContain("✅ AUTO-APPROVED via OCR");
      expect(note).toContain("Confidence: 92% (very high)");
      expect(note).toContain("Bank: Bangkok Bank (BBL)");
      expect(note).toContain("Amount: ฿299.00 (matches order exactly)");
      expect(note).toContain("Date: 2026-04-29 14:30 (within 2-hour window)");
      expect(note).toContain("All 12 verification checks passed");
      expect(note).toContain("✓ Customer can now access purchased content");
    });

    it("should show high confidence level for 90%+ confidence", () => {
      const note = generateApprovalNote({
        isAutoApproved: true,
        isShadowMode: false,
        ocrConfidence: 95,
        detectedBank: "BBL",
      });

      expect(note).toContain("Confidence: 95% (very high)");
    });

    it("should show acceptable confidence level for 85-89% confidence", () => {
      const note = generateApprovalNote({
        isAutoApproved: true,
        isShadowMode: false,
        ocrConfidence: 87,
        detectedBank: "BBL",
      });

      expect(note).toContain("Confidence: 87% (high)");
    });
  });

  describe("generateManualReviewNote", () => {
    it("should generate note for LOW_CONFIDENCE failure", () => {
      const note = generateManualReviewNote({
        isAutoApproved: false,
        isShadowMode: false,
        ocrConfidence: 72,
        detectedBank: "Bangkok Bank (BBL)",
        reviewReason: "LOW_CONFIDENCE",
        extractedAmount: 299.0,
        orderTotal: 299.0,
        extractedDate: "2026-04-29",
        breakdown: {
          amountMatched: true,
          datePresent: true,
          dateWithinWindow: true,
          referencePresent: true,
          duplicateReference: false,
          duplicateFingerprint: false,
          bankDetected: true,
          ocrConfidence: 72,
          finalDecision: "pending_review",
        },
      });

      expect(note).toContain("⚠️ MANUAL REVIEW REQUIRED - LOW_CONFIDENCE");
      expect(note).toContain("OCR Confidence: 72% (low)");
      expect(note).toContain(
        "OCR confidence below 85% threshold (slip image quality may be poor)"
      );
      expect(note).toContain(
        "Customer should submit a clearer/higher-quality slip image"
      );
    });

    it("should generate note for AMOUNT_MISMATCH failure", () => {
      const note = generateManualReviewNote({
        isAutoApproved: false,
        isShadowMode: false,
        ocrConfidence: 88,
        detectedBank: "Bangkok Bank (BBL)",
        reviewReason: "AMOUNT_MISMATCH",
        extractedAmount: 250.0,
        orderTotal: 299.0,
        extractedDate: "2026-04-29",
        breakdown: {
          amountMatched: false,
          datePresent: true,
          dateWithinWindow: true,
          referencePresent: true,
          duplicateReference: false,
          duplicateFingerprint: false,
          bankDetected: true,
          ocrConfidence: 88,
          finalDecision: "pending_review",
        },
      });

      expect(note).toContain("⚠️ MANUAL REVIEW REQUIRED - AMOUNT_MISMATCH");
      expect(note).toContain("Amount: ฿250.00 (extracted from slip)");
      expect(note).toContain("Expected: ฿299.00 (order total)");
      expect(note).toContain("Mismatch: ฿49.00 short");
      expect(note).toContain(
        "Slip amount does not match order total (customer may have sent wrong amount)"
      );
    });

    it("should generate note for DUPLICATE_REFERENCE failure", () => {
      const note = generateManualReviewNote({
        isAutoApproved: false,
        isShadowMode: false,
        ocrConfidence: 91,
        detectedBank: "Bangkok Bank (BBL)",
        reviewReason: "DUPLICATE_REFERENCE",
        extractedAmount: 299.0,
        orderTotal: 299.0,
        extractedDate: "2026-04-29 14:30",
        breakdown: {
          amountMatched: true,
          datePresent: true,
          dateWithinWindow: true,
          referencePresent: true,
          duplicateReference: true,
          duplicateFingerprint: false,
          bankDetected: true,
          ocrConfidence: 91,
          finalDecision: "pending_review",
        },
      });

      expect(note).toContain("⚠️ MANUAL REVIEW REQUIRED - DUPLICATE_REFERENCE");
      expect(note).toContain("Reference: DUPLICATE (already used in another payment)");
      expect(note).toContain(
        "Reference number already used in another payment (duplicate slip)"
      );
      expect(note).toContain(
        "Customer must submit a different slip with a new reference number"
      );
    });

    it("should generate note for TRANSACTION_OUTSIDE_TIME_WINDOW failure", () => {
      const note = generateManualReviewNote({
        isAutoApproved: false,
        isShadowMode: false,
        ocrConfidence: 89,
        detectedBank: "Bangkok Bank (BBL)",
        reviewReason: "TRANSACTION_OUTSIDE_TIME_WINDOW",
        extractedAmount: 299.0,
        orderTotal: 299.0,
        extractedDate: "2026-04-28 14:30",
        breakdown: {
          amountMatched: true,
          datePresent: true,
          dateWithinWindow: false,
          referencePresent: true,
          duplicateReference: false,
          duplicateFingerprint: false,
          bankDetected: true,
          ocrConfidence: 89,
          finalDecision: "pending_review",
        },
      });

      expect(note).toContain(
        "⚠️ MANUAL REVIEW REQUIRED - TRANSACTION_OUTSIDE_TIME_WINDOW"
      );
      expect(note).toContain(
        "Slip is older than 2 hours (may be reused slip or wrong slip)"
      );
      expect(note).toContain(
        "Customer must submit a fresh slip (within 2 hours of payment)"
      );
    });
  });

  describe("generateShadowModeNote", () => {
    it("should generate shadow mode note for simulated approval", () => {
      const note = generateShadowModeNote({
        isAutoApproved: true,
        isShadowMode: true,
        ocrConfidence: 92,
        detectedBank: "Bangkok Bank (BBL)",
        extractedAmount: 299.0,
        orderTotal: 299.0,
        extractedDate: "2026-04-29 14:30",
        breakdown: {
          amountMatched: true,
          datePresent: true,
          dateWithinWindow: true,
          referencePresent: true,
          duplicateReference: false,
          duplicateFingerprint: false,
          bankDetected: true,
          ocrConfidence: 92,
          finalDecision: "approved",
        },
      });

      expect(note).toContain("🔍 SHADOW MODE - SIMULATED DECISION");
      expect(note).toContain("Simulated Decision: WOULD BE APPROVED");
      expect(note).toContain("Actual Status: PENDING (shadow mode - not auto-approved)");
      expect(note).toContain(
        "This slip would pass all checks and be auto-approved in production"
      );
      expect(note).toContain(
        "Admin must manually approve to grant customer access"
      );
    });

    it("should generate shadow mode note for simulated rejection", () => {
      const note = generateShadowModeNote({
        isAutoApproved: false,
        isShadowMode: true,
        ocrConfidence: 72,
        detectedBank: "Bangkok Bank (BBL)",
        reviewReason: "LOW_CONFIDENCE",
        extractedAmount: 299.0,
        orderTotal: 299.0,
        extractedDate: "2026-04-29",
        breakdown: {
          amountMatched: true,
          datePresent: true,
          dateWithinWindow: true,
          referencePresent: true,
          duplicateReference: false,
          duplicateFingerprint: false,
          bankDetected: true,
          ocrConfidence: 72,
          finalDecision: "pending_review",
        },
      });

      expect(note).toContain("🔍 SHADOW MODE - SIMULATED DECISION");
      expect(note).toContain("Simulated Decision: WOULD REQUIRE MANUAL REVIEW");
      expect(note).toContain("Reason: LOW_CONFIDENCE");
      expect(note).toContain(
        "This slip would be sent to manual review in production due to:"
      );
    });
  });

  describe("generateVerificationSummary", () => {
    it("should generate verification summary with all checks", () => {
      const summary = generateVerificationSummary({
        isAutoApproved: true,
        isShadowMode: false,
        ocrConfidence: 92,
        breakdown: {
          amountMatched: true,
          datePresent: true,
          dateWithinWindow: true,
          referencePresent: true,
          duplicateReference: false,
          duplicateFingerprint: false,
          bankDetected: true,
          ocrConfidence: 92,
          finalDecision: "approved",
        },
      });

      expect(summary["Amount Matched"]).toBe(true);
      expect(summary["Date Present"]).toBe(true);
      expect(summary["Date Within Window"]).toBe(true);
      expect(summary["Reference Present"]).toBe(true);
      expect(summary["Duplicate Reference"]).toBe(true);
      expect(summary["Duplicate Fingerprint"]).toBe(true);
      expect(summary["Bank Detected"]).toBe(true);
      expect(summary["OCR Confidence"]).toContain("92%");
      expect(summary["OCR Confidence"]).toContain("✓ Pass");
      expect(summary["Final Decision"]).toBe("approved");
    });

    it("should show failed confidence check", () => {
      const summary = generateVerificationSummary({
        isAutoApproved: false,
        isShadowMode: false,
        ocrConfidence: 72,
        breakdown: {
          amountMatched: true,
          datePresent: true,
          dateWithinWindow: true,
          referencePresent: true,
          duplicateReference: false,
          duplicateFingerprint: false,
          bankDetected: true,
          ocrConfidence: 72,
          finalDecision: "pending_review",
        },
      });

      expect(summary["OCR Confidence"]).toContain("72%");
      expect(summary["OCR Confidence"]).toContain("✗ Fail");
    });
  });

  describe("Reason explanations", () => {
    it("should provide explanations for all failure reasons", () => {
      const reasons = [
        "MISSING_AMOUNT",
        "AMOUNT_MISMATCH",
        "MISSING_TRANSACTION_DATE",
        "TRANSACTION_OUTSIDE_TIME_WINDOW",
        "MISSING_REFERENCE",
        "DUPLICATE_REFERENCE",
        "DUPLICATE_FINGERPRINT",
        "LOW_CONFIDENCE",
        "INSUFFICIENT_STRUCTURED_DATA",
        "MERCHANT_CODE_MISMATCH",
        "MERCHANT_TRANSACTION_CODE_MISMATCH",
        "SHOP_NAME_MISMATCH",
      ];

      for (const reason of reasons) {
        const note = generateManualReviewNote({
          isAutoApproved: false,
          isShadowMode: false,
          reviewReason: reason,
        });

        expect(note).toContain(`⚠️ MANUAL REVIEW REQUIRED - ${reason}`);
        expect(note).toContain("→ Reason:");
        expect(note).toContain("→ Action:");
        // Should not contain placeholder text
        expect(note).not.toContain("Unknown reason");
      }
    });
  });

  describe("Edge cases", () => {
    it("should handle missing optional fields gracefully", () => {
      const note = generateApprovalNote({
        isAutoApproved: true,
        isShadowMode: false,
      });

      expect(note).toContain("✅ AUTO-APPROVED via OCR");
      expect(note).toContain("All 12 verification checks passed");
    });

    it("should handle zero confidence", () => {
      const note = generateApprovalNote({
        isAutoApproved: true,
        isShadowMode: false,
        ocrConfidence: 0,
      });

      expect(note).toContain("Confidence: 0%");
    });

    it("should handle 100% confidence", () => {
      const note = generateApprovalNote({
        isAutoApproved: true,
        isShadowMode: false,
        ocrConfidence: 100,
      });

      expect(note).toContain("Confidence: 100% (very high)");
    });

    it("should handle large amount differences", () => {
      const note = generateManualReviewNote({
        isAutoApproved: false,
        isShadowMode: false,
        reviewReason: "AMOUNT_MISMATCH",
        extractedAmount: 100.0,
        orderTotal: 999.99,
      });

      expect(note).toContain("Amount: ฿100.00 (extracted from slip)");
      expect(note).toContain("Expected: ฿999.99 (order total)");
      expect(note).toContain("Mismatch: ฿899.99 short");
    });
  });

  describe("Note formatting", () => {
    it("should use proper Thai currency symbol", () => {
      const note = generateApprovalNote({
        isAutoApproved: true,
        isShadowMode: false,
        extractedAmount: 299.0,
        orderTotal: 299.0,
      });

      expect(note).toContain("฿");
    });

    it("should format amounts with 2 decimal places", () => {
      const note = generateApprovalNote({
        isAutoApproved: true,
        isShadowMode: false,
        extractedAmount: 299.5,
        orderTotal: 299.5,
      });

      expect(note).toContain("฿299.50");
    });

    it("should use proper emoji indicators", () => {
      const approvalNote = generateApprovalNote({
        isAutoApproved: true,
        isShadowMode: false,
      });
      expect(approvalNote).toContain("✅");
      expect(approvalNote).toContain("✓");

      const reviewNote = generateManualReviewNote({
        isAutoApproved: false,
        isShadowMode: false,
        reviewReason: "LOW_CONFIDENCE",
      });
      expect(reviewNote).toContain("⚠️");
      expect(reviewNote).toContain("→");

      const shadowNote = generateShadowModeNote({
        isAutoApproved: true,
        isShadowMode: true,
      });
      expect(shadowNote).toContain("🔍");
    });
  });
});
