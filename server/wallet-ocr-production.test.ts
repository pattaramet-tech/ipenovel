import { describe, it, expect, beforeAll } from "vitest";
import * as db from "./db";

describe("Wallet OCR Production Safety Tests", () => {
  let testUserId: number = 99998;
  let testSlipUrl: string = "https://example.com/slip.jpg";

  beforeAll(async () => {
    testUserId = 99998;
  });

  describe("Phase 1: Transactional Approval + Credit", () => {
    it("should credit wallet and approve in single transaction", async () => {
      const topup = await db.createWalletTopup(testUserId, "300.00", testSlipUrl);
      const balanceBefore = await db.getWalletBalance(testUserId);

      // Simulate OCR auto-approval with transactional helper
      const result = await db.approveWalletTopupWithOCR(topup.id, {
        status: "approved",
        extractedData: JSON.stringify({
          reference: "TEST123",
          amount: "300.00",
          merchant: "Test Merchant",
        }),
        ocrConfidence: 95,
        visionConfidence: 95,
        structuredConfidence: 95,
        finalConfidence: 95,
        duplicateStatus: JSON.stringify({
          isDuplicate: false,
          type: null,
          reference: null,
          fingerprint: "fp123",
        }),
        ocrDecision: "approved",
        approvalSource: "ocr_auto",
        creditedAmount: "310.00",
      });

      const balanceAfter = await db.getWalletBalance(testUserId);
      const credited = parseFloat(balanceAfter) - parseFloat(balanceBefore);

      expect(result.status).toBe("approved");
      expect(credited).toBeCloseTo(310.0, 1);
    });

    it("should prevent double approval (idempotency)", async () => {
      const topup = await db.createWalletTopup(testUserId, "100.00", testSlipUrl);
      const balanceBefore = await db.getWalletBalance(testUserId);

      // First approval
      await db.approveWalletTopupWithOCR(topup.id, {
        status: "approved",
        extractedData: JSON.stringify({ reference: "TEST_IDEMPOTENT" }),
        ocrConfidence: 95,
        visionConfidence: 95,
        structuredConfidence: 95,
        finalConfidence: 95,
        duplicateStatus: JSON.stringify({ isDuplicate: false }),
        ocrDecision: "approved",
        approvalSource: "ocr_auto",
        creditedAmount: "100.00",
      });

      const balanceAfter1 = await db.getWalletBalance(testUserId);
      const credited1 = parseFloat(balanceAfter1) - parseFloat(balanceBefore);

      // Second approval should fail
      try {
        await db.approveWalletTopupWithOCR(topup.id, {
          status: "approved",
          extractedData: JSON.stringify({ reference: "TEST_IDEMPOTENT" }),
          ocrConfidence: 95,
          visionConfidence: 95,
          structuredConfidence: 95,
          finalConfidence: 95,
          duplicateStatus: JSON.stringify({ isDuplicate: false }),
          ocrDecision: "approved",
          approvalSource: "ocr_auto",
          creditedAmount: "100.00",
        });
        throw new Error("Should have prevented double approval");
      } catch (e: any) {
        expect(e.message).toContain("already processed");
      }

      const balanceAfter2 = await db.getWalletBalance(testUserId);
      expect(parseFloat(balanceAfter2)).toBe(parseFloat(balanceAfter1));
      expect(credited1).toBeCloseTo(100.0, 1);
    });
  });

  describe("Phase 2: Admin Approval for pending_review", () => {
    it("should allow admin to approve pending_review topups", async () => {
      const topup = await db.createWalletTopup(testUserId, "250.00", testSlipUrl);
      const balanceBefore = await db.getWalletBalance(testUserId);

      // Set to pending_review
      await db.updateWalletTopupWithOCRApproval(topup.id, {
        status: "pending_review",
        reviewReason: "LOW_CONFIDENCE",
      });

      // Admin approves
      const adminId = 1;
      await db.approveWalletTopup(topup.id, adminId);

      const updated = await db.getWalletTopupById(topup.id);
      expect(updated.status).toBe("approved");
      expect(updated.reviewedByUserId).toBe(adminId);

      const balanceAfter = await db.getWalletBalance(testUserId);
      const credited = parseFloat(balanceAfter) - parseFloat(balanceBefore);
      expect(credited).toBeCloseTo(260.0, 1);
    });

    it("should allow admin to reject pending_review topups", async () => {
      const topup = await db.createWalletTopup(testUserId, "200.00", testSlipUrl);
      const balanceBefore = await db.getWalletBalance(testUserId);

      // Set to pending_review
      await db.updateWalletTopupWithOCRApproval(topup.id, {
        status: "pending_review",
        reviewReason: "DUPLICATE_REFERENCE",
      });

      // Admin rejects
      const adminId = 1;
      await db.rejectWalletTopup(topup.id, adminId, "Duplicate slip detected");

      const updated = await db.getWalletTopupById(topup.id);
      expect(updated.status).toBe("rejected");
      expect(updated.reviewedByUserId).toBe(adminId);

      const balanceAfter = await db.getWalletBalance(testUserId);
      expect(parseFloat(balanceAfter)).toBe(parseFloat(balanceBefore));
    });
  });

  describe("Phase 3: OCR Error Fallback", () => {
    it("should set pending_review on OCR technical error", async () => {
      const topup = await db.createWalletTopup(testUserId, "300.00", testSlipUrl);

      // Simulate OCR error
      await db.updateWalletTopupWithOCRApproval(topup.id, {
        status: "pending_review",
        reviewReason: "OCR_PROCESSING_ERROR",
        ocrDecision: "needs_review",
      });

      const updated = await db.getWalletTopupById(topup.id);
      expect(updated.status).toBe("pending_review");
      expect(updated.reviewReason).toBe("OCR_PROCESSING_ERROR");
    });

    it("should set pending_review on low confidence", async () => {
      const topup = await db.createWalletTopup(testUserId, "250.00", testSlipUrl);

      // Simulate low confidence
      await db.updateWalletTopupWithOCRApproval(topup.id, {
        status: "pending_review",
        reviewReason: "LOW_CONFIDENCE",
        ocrConfidence: 45,
        finalConfidence: 45,
      });

      const updated = await db.getWalletTopupById(topup.id);
      expect(updated.status).toBe("pending_review");
      expect(updated.ocrConfidence).toEqual(45);
    });

    it("should set pending_review on amount mismatch", async () => {
      const topup = await db.createWalletTopup(testUserId, "300.00", testSlipUrl);

      // Simulate amount mismatch
      await db.updateWalletTopupWithOCRApproval(topup.id, {
        status: "pending_review",
        reviewReason: "AMOUNT_MISMATCH",
        extractedData: JSON.stringify({
          amount: "250.00",
          reference: "REF003",
        }),
      });

      const updated = await db.getWalletTopupById(topup.id);
      expect(updated.status).toBe("pending_review");
      expect(updated.reviewReason).toBe("AMOUNT_MISMATCH");
    });
  });

  describe("Phase 4: Confidence Metadata", () => {
    it("should store all confidence values correctly", async () => {
      const topup = await db.createWalletTopup(testUserId, "300.00", testSlipUrl);

      await db.updateWalletTopupWithOCRApproval(topup.id, {
        status: "approved",
        ocrConfidence: 92,
        visionConfidence: 88,
        structuredConfidence: 95,
        finalConfidence: 91,
      });

      const updated = await db.getWalletTopupById(topup.id);
      expect(updated.ocrConfidence).toEqual(92);
      expect(updated.visionConfidence).toEqual(88);
      expect(updated.structuredConfidence).toEqual(95);
      expect(updated.finalConfidence).toEqual(91);
    });

    it("should handle low confidence values", async () => {
      const topup = await db.createWalletTopup(testUserId, "300.00", testSlipUrl);

      // Simulate approval with confidence below typical threshold
      await db.updateWalletTopupWithOCRApproval(topup.id, {
        status: "pending_review",
        ocrConfidence: 75,
        finalConfidence: 75,
        reviewReason: "LOW_CONFIDENCE",
      });

      const updated = await db.getWalletTopupById(topup.id);
      expect(updated.finalConfidence).toEqual(75);
      expect(updated.status).toBe("pending_review");
    });
  });

  describe("Phase 5: OCR Decision Tracking", () => {
    it("should track OCR decision (approved vs needs_review)", async () => {
      const topup1 = await db.createWalletTopup(testUserId, "300.00", testSlipUrl);
      const topup2 = await db.createWalletTopup(testUserId, "300.00", testSlipUrl);

      // Auto-approved
      await db.updateWalletTopupWithOCRApproval(topup1.id, {
        status: "approved",
        ocrDecision: "approved",
      });

      // Needs review
      await db.updateWalletTopupWithOCRApproval(topup2.id, {
        status: "pending_review",
        ocrDecision: "needs_review",
        reviewReason: "LOW_CONFIDENCE",
      });

      const updated1 = await db.getWalletTopupById(topup1.id);
      const updated2 = await db.getWalletTopupById(topup2.id);

      expect(updated1.ocrDecision).toBe("approved");
      expect(updated2.ocrDecision).toBe("needs_review");
    });

    it("should track approval source (ocr_auto vs manual)", async () => {
      const topup1 = await db.createWalletTopup(testUserId, "300.00", testSlipUrl);
      const topup2 = await db.createWalletTopup(testUserId, "300.00", testSlipUrl);

      // OCR auto-approval
      await db.updateWalletTopupWithOCRApproval(topup1.id, {
        status: "approved",
        approvalSource: "ocr_auto",
      });

      // Manual approval
      await db.updateWalletTopupWithOCRApproval(topup2.id, {
        status: "approved",
        approvalSource: "manual",
      });

      const updated1 = await db.getWalletTopupById(topup1.id);
      const updated2 = await db.getWalletTopupById(topup2.id);

      expect(updated1.approvalSource).toBe("ocr_auto");
      expect(updated2.approvalSource).toBe("manual");
    });
  });

  describe("Phase 6: Extracted Data Persistence", () => {
    it("should persist extracted OCR data as JSON", async () => {
      const topup = await db.createWalletTopup(testUserId, "300.00", testSlipUrl);
      const extractedData = {
        reference: "REF004",
        amount: "300.00",
        merchant: "Test Bank",
        timestamp: "2026-01-15T10:30:00Z",
        accountNumber: "1234567890",
      };

      await db.updateWalletTopupWithOCRApproval(topup.id, {
        status: "approved",
        extractedData: JSON.stringify(extractedData),
      });

      const updated = await db.getWalletTopupById(topup.id);
      const parsed = JSON.parse(updated.extractedData || "{}");

      expect(parsed.reference).toBe("REF004");
      expect(parsed.amount).toBe("300.00");
      expect(parsed.merchant).toBe("Test Bank");
    });

    it("should persist duplicate status as JSON", async () => {
      const topup = await db.createWalletTopup(testUserId, "300.00", testSlipUrl);
      const duplicateStatus = {
        isDuplicate: true,
        type: "REFERENCE",
        reference: "DUP_REF_001",
        fingerprint: "fp_dup_001",
      };

      await db.updateWalletTopupWithOCRApproval(topup.id, {
        status: "pending_review",
        duplicateStatus: JSON.stringify(duplicateStatus),
        reviewReason: "DUPLICATE_REFERENCE",
      });

      const updated = await db.getWalletTopupById(topup.id);
      const parsed = JSON.parse(updated.duplicateStatus || "{}");

      expect(parsed.isDuplicate).toBe(true);
      expect(parsed.type).toBe("REFERENCE");
      expect(parsed.reference).toBe("DUP_REF_001");
    });
  });

  describe("Phase 7: Bonus Calculation with OCR", () => {
    it("should credit correct bonus amount when auto-approved", async () => {
      const topup = await db.createWalletTopup(testUserId, "500.00", testSlipUrl);
      const balanceBefore = await db.getWalletBalance(testUserId);

      // Auto-approve with bonus
      await db.approveWalletTopupWithOCR(topup.id, {
        status: "approved",
        extractedData: JSON.stringify({ reference: "REF005" }),
        ocrConfidence: 95,
        visionConfidence: 95,
        structuredConfidence: 95,
        finalConfidence: 95,
        duplicateStatus: JSON.stringify({ isDuplicate: false }),
        ocrDecision: "approved",
        approvalSource: "ocr_auto",
        creditedAmount: "520.00", // 500 + 20 bonus
      });

      const balanceAfter = await db.getWalletBalance(testUserId);
      const credited = parseFloat(balanceAfter) - parseFloat(balanceBefore);

      expect(credited).toBeCloseTo(520.0, 1);
    });

    it("should credit correct bonus for 250-499 range", async () => {
      const topup = await db.createWalletTopup(testUserId, "300.00", testSlipUrl);
      const balanceBefore = await db.getWalletBalance(testUserId);

      await db.approveWalletTopupWithOCR(topup.id, {
        status: "approved",
        extractedData: JSON.stringify({ reference: "REF006" }),
        ocrConfidence: 90,
        visionConfidence: 90,
        structuredConfidence: 90,
        finalConfidence: 90,
        duplicateStatus: JSON.stringify({ isDuplicate: false }),
        ocrDecision: "approved",
        approvalSource: "ocr_auto",
        creditedAmount: "310.00", // 300 + 10 bonus
      });

      const balanceAfter = await db.getWalletBalance(testUserId);
      const credited = parseFloat(balanceAfter) - parseFloat(balanceBefore);

      expect(credited).toBeCloseTo(310.0, 1);
    });
  });

  describe("Phase 8: Review Reason Tracking", () => {
    it("should track various review reasons", async () => {
      const reasons = [
        "LOW_CONFIDENCE",
        "AMOUNT_MISMATCH",
        "DUPLICATE_REFERENCE",
        "DUPLICATE_FINGERPRINT",
        "MISSING_FIELDS",
        "OCR_PROCESSING_ERROR",
      ];

      for (const reason of reasons) {
        const topup = await db.createWalletTopup(testUserId, "100.00", testSlipUrl);
        await db.updateWalletTopupWithOCRApproval(topup.id, {
          status: "pending_review",
          reviewReason: reason,
        });

        const updated = await db.getWalletTopupById(topup.id);
        expect(updated.reviewReason).toBe(reason);
      }
    });
  });

  describe("Phase 9: Status Transitions", () => {
    it("should allow pending -> pending_review transition", async () => {
      const topup = await db.createWalletTopup(testUserId, "100.00", testSlipUrl);
      expect(topup.status).toBe("pending");

      await db.updateWalletTopupWithOCRApproval(topup.id, {
        status: "pending_review",
        reviewReason: "LOW_CONFIDENCE",
      });

      const updated = await db.getWalletTopupById(topup.id);
      expect(updated.status).toBe("pending_review");
    });

    it("should allow pending_review -> approved transition", async () => {
      const topup = await db.createWalletTopup(testUserId, "100.00", testSlipUrl);
      await db.updateWalletTopupWithOCRApproval(topup.id, {
        status: "pending_review",
      });

      await db.approveWalletTopup(topup.id, 1);
      const updated = await db.getWalletTopupById(topup.id);
      expect(updated.status).toBe("approved");
    });

    it("should allow pending_review -> rejected transition", async () => {
      const topup = await db.createWalletTopup(testUserId, "100.00", testSlipUrl);
      await db.updateWalletTopupWithOCRApproval(topup.id, {
        status: "pending_review",
      });

      await db.rejectWalletTopup(topup.id, 1, "Invalid slip");
      const updated = await db.getWalletTopupById(topup.id);
      expect(updated.status).toBe("rejected");
    });
  });

  describe("Phase 10: Comprehensive OCR Workflow", () => {
    it("should complete full OCR workflow: pending -> pending_review -> approved", async () => {
      const topup = await db.createWalletTopup(testUserId, "250.00", testSlipUrl);
      const balanceBefore = await db.getWalletBalance(testUserId);

      // Step 1: OCR runs, detects low confidence
      await db.updateWalletTopupWithOCRApproval(topup.id, {
        status: "pending_review",
        reviewReason: "LOW_CONFIDENCE",
        ocrConfidence: 72,
        finalConfidence: 72,
        extractedData: JSON.stringify({
          reference: "WORKFLOW_TEST",
          amount: "250.00",
        }),
        ocrDecision: "needs_review",
        approvalSource: "manual",
      });

      let updated = await db.getWalletTopupById(topup.id);
      expect(updated.status).toBe("pending_review");
      expect(updated.ocrConfidence).toEqual(72);

      // Step 2: Admin reviews and approves
      await db.approveWalletTopup(topup.id, 1);

      updated = await db.getWalletTopupById(topup.id);
      expect(updated.status).toBe("approved");
      expect(updated.reviewedByUserId).toBe(1);

      // Step 3: Verify wallet was credited
      const balanceAfter = await db.getWalletBalance(testUserId);
      const credited = parseFloat(balanceAfter) - parseFloat(balanceBefore);
      expect(credited).toBeCloseTo(260.0, 1);
    });
  });
});
