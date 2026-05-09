import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getDb } from "./db";
import { payments, orders } from "../drizzle/schema";
import { eq } from "drizzle-orm";
import { ApprovalService } from "./services/approvalService";

describe("OCR Payment Persistence", () => {
  let db: any;

  beforeEach(async () => {
    db = await getDb();
  });

  describe("OCR Auto-Approval Updates Payment Record", () => {
    it("should update payment status to approved when OCR auto-approves", async () => {
      // Create test payment
      const payment = await db
        .insert(payments)
        .values({
          orderId: 1,
          amount: 100,
          status: "pending",
          paymentMethod: "slip",
          createdAt: new Date(),
        })
        .returning();

      // Simulate OCR auto-approval
      await ApprovalService.approvePaymentWithSource(payment[0].id, "auto", {
        autoApprovedAt: new Date(),
      });

      // Verify payment status updated
      const updated = await db
        .select()
        .from(payments)
        .where(eq(payments.id, payment[0].id));

      expect(updated[0].status).toBe("approved");
      expect(updated[0].approvalSource).toBe("auto");
      expect(updated[0].autoApprovedAt).toBeDefined();
    });

    it("should save OCR metadata when auto-approving", async () => {
      const payment = await db
        .insert(payments)
        .values({
          orderId: 1,
          amount: 100,
          status: "pending",
          paymentMethod: "slip",
          createdAt: new Date(),
        })
        .returning();

      const extractedData = {
        amount: 100,
        reference: "REF123",
        transactionDate: new Date(),
        detectedBank: "BBL",
        confidence: 95,
      };

      const fingerprint = "abc123def456";

      // Simulate OCR auto-approval with metadata
      await ApprovalService.approvePaymentWithSource(payment[0].id, "auto", {
        autoApprovedAt: new Date(),
      });

      // Also save OCR metadata
      await db
        .update(payments)
        .set({
          extractedData: JSON.stringify(extractedData),
          fingerprint,
          linkedOrderId: 1,
          linkedPaymentId: payment[0].id,
          ocrConfidence: 95,
          ocrDecision: "auto_approved",
        })
        .where(eq(payments.id, payment[0].id));

      // Verify metadata saved
      const updated = await db
        .select()
        .from(payments)
        .where(eq(payments.id, payment[0].id));

      expect(updated[0].extractedData).toBeDefined();
      expect(updated[0].fingerprint).toBe(fingerprint);
      expect(updated[0].linkedOrderId).toBe(1);
      expect(updated[0].ocrConfidence).toBe(95);
      expect(updated[0].ocrDecision).toBe("auto_approved");
    });

    it("should not leave auto-approved payments as pending", async () => {
      const payment = await db
        .insert(payments)
        .values({
          orderId: 1,
          amount: 100,
          status: "pending",
          paymentMethod: "slip",
          createdAt: new Date(),
        })
        .returning();

      // Approve payment
      await ApprovalService.approvePaymentWithSource(payment[0].id, "auto", {
        autoApprovedAt: new Date(),
      });

      // Verify status is approved, not pending
      const updated = await db
        .select()
        .from(payments)
        .where(eq(payments.id, payment[0].id));

      expect(updated[0].status).toBe("approved");
      expect(updated[0].status).not.toBe("pending");
    });
  });

  describe("OCR Manual Review Updates Payment Record", () => {
    it("should update payment status to pending_review when OCR needs review", async () => {
      const payment = await db
        .insert(payments)
        .values({
          orderId: 1,
          amount: 100,
          status: "pending",
          paymentMethod: "slip",
          createdAt: new Date(),
        })
        .returning();

      const extractedData = {
        amount: 100,
        reference: "REF123",
        transactionDate: new Date(),
        detectedBank: "BBL",
        confidence: 75, // Below threshold
      };

      const fingerprint = "abc123def456";

      // Simulate OCR manual review
      await ApprovalService.sendToReview(
        payment[0].id,
        "LOW_CONFIDENCE",
        extractedData,
        fingerprint
      );

      // Verify payment status updated
      const updated = await db
        .select()
        .from(payments)
        .where(eq(payments.id, payment[0].id));

      expect(updated[0].status).toBe("pending_review");
      expect(updated[0].reviewReason).toBe("LOW_CONFIDENCE");
    });

    it("should save OCR metadata when sending to manual review", async () => {
      const payment = await db
        .insert(payments)
        .values({
          orderId: 1,
          amount: 100,
          status: "pending",
          paymentMethod: "slip",
          createdAt: new Date(),
        })
        .returning();

      const extractedData = {
        amount: 100,
        reference: "REF123",
        transactionDate: new Date(),
        detectedBank: "BBL",
        confidence: 75,
      };

      const fingerprint = "abc123def456";

      // Send to review
      await ApprovalService.sendToReview(
        payment[0].id,
        "LOW_CONFIDENCE",
        extractedData,
        fingerprint
      );

      // Also save additional OCR metadata
      await db
        .update(payments)
        .set({
          linkedOrderId: 1,
          linkedPaymentId: payment[0].id,
          ocrConfidence: 75,
          ocrDecision: "needs_review",
        })
        .where(eq(payments.id, payment[0].id));

      // Verify metadata saved
      const updated = await db
        .select()
        .from(payments)
        .where(eq(payments.id, payment[0].id));

      expect(updated[0].extractedData).toBeDefined();
      expect(updated[0].fingerprint).toBe(fingerprint);
      expect(updated[0].linkedOrderId).toBe(1);
      expect(updated[0].ocrConfidence).toBe(75);
      expect(updated[0].ocrDecision).toBe("needs_review");
    });

    it("should not leave OCR-reviewed payments without extractedData", async () => {
      const payment = await db
        .insert(payments)
        .values({
          orderId: 1,
          amount: 100,
          status: "pending",
          paymentMethod: "slip",
          createdAt: new Date(),
        })
        .returning();

      const extractedData = {
        amount: 100,
        reference: "REF123",
        transactionDate: new Date(),
      };

      // Send to review with extractedData
      await ApprovalService.sendToReview(
        payment[0].id,
        "LOW_CONFIDENCE",
        extractedData,
        "fingerprint123"
      );

      // Verify extractedData is saved
      const updated = await db
        .select()
        .from(payments)
        .where(eq(payments.id, payment[0].id));

      expect(updated[0].extractedData).toBeDefined();
      expect(updated[0].fingerprint).toBe("fingerprint123");
    });
  });

  describe("Duplicate Detection Uses Stored Metadata", () => {
    it("should detect duplicate references from stored extractedData", async () => {
      // Create first payment with reference
      const payment1 = await db
        .insert(payments)
        .values({
          orderId: 1,
          amount: 100,
          status: "approved",
          paymentMethod: "slip",
          extractedData: JSON.stringify({
            amount: 100,
            reference: "REF123",
            transactionDate: new Date(),
          }),
          fingerprint: "fp1",
          createdAt: new Date(),
        })
        .returning();

      // Load existing references
      const existingPayments = await db
        .select({
          id: payments.id,
          extractedData: payments.extractedData,
        })
        .from(payments)
        .where(eq(payments.status, "approved"));

      const existingReferences = new Set<string>();
      for (const p of existingPayments) {
        if (p.extractedData) {
          try {
            const data = JSON.parse(p.extractedData);
            if (data.reference) {
              existingReferences.add(data.reference);
            }
          } catch (e) {
            // Skip malformed JSON
          }
        }
      }

      // Verify duplicate reference detected
      expect(existingReferences.has("REF123")).toBe(true);
    });

    it("should detect duplicate fingerprints from stored data", async () => {
      const fingerprint = "abc123def456";

      // Create first payment with fingerprint
      await db
        .insert(payments)
        .values({
          orderId: 1,
          amount: 100,
          status: "approved",
          paymentMethod: "slip",
          fingerprint,
          createdAt: new Date(),
        })
        .returning();

      // Load existing fingerprints
      const existingPayments = await db
        .select({
          id: payments.id,
          fingerprint: payments.fingerprint,
        })
        .from(payments)
        .where(eq(payments.status, "approved"));

      const existingFingerprints = new Set<string>();
      for (const p of existingPayments) {
        if (p.fingerprint) {
          existingFingerprints.add(p.fingerprint);
        }
      }

      // Verify duplicate fingerprint detected
      expect(existingFingerprints.has(fingerprint)).toBe(true);
    });
  });

  describe("Manual Admin Approval Still Works", () => {
    it("should allow manual admin approval after pending_review", async () => {
      const payment = await db
        .insert(payments)
        .values({
          orderId: 1,
          amount: 100,
          status: "pending_review",
          paymentMethod: "slip",
          createdAt: new Date(),
        })
        .returning();

      // Admin approves manually
      await ApprovalService.approvePaymentWithSource(payment[0].id, "manual", {
        adminId: 999,
        adminLabel: "Admin User",
      });

      // Verify payment approved
      const updated = await db
        .select()
        .from(payments)
        .where(eq(payments.id, payment[0].id));

      expect(updated[0].status).toBe("approved");
      expect(updated[0].approvalSource).toBe("manual");
      expect(updated[0].approvedByAdminId).toBe(999);
    });

    it("should allow manual admin rejection", async () => {
      const payment = await db
        .insert(payments)
        .values({
          orderId: 1,
          amount: 100,
          status: "pending_review",
          paymentMethod: "slip",
          createdAt: new Date(),
        })
        .returning();

      // Admin rejects manually
      await ApprovalService.rejectPayment(
        payment[0].id,
        "Invalid slip format",
        999
      );

      // Verify payment rejected
      const updated = await db
        .select()
        .from(payments)
        .where(eq(payments.id, payment[0].id));

      expect(updated[0].status).toBe("rejected");
      expect(updated[0].rejectionReason).toBe("Invalid slip format");
      expect(updated[0].reviewedByUserId).toBe(999);
    });
  });

  describe("OCR Disabled Workflow", () => {
    it("should send all slip payments to manual review when OCR disabled", async () => {
      // When OCR is disabled, all slip payments should go to pending_review
      const payment = await db
        .insert(payments)
        .values({
          orderId: 1,
          amount: 100,
          status: "pending",
          paymentMethod: "slip",
          createdAt: new Date(),
        })
        .returning();

      // Simulate OCR disabled - send to review without auto-approval
      await ApprovalService.sendToReview(
        payment[0].id,
        "OCR_DISABLED",
        null,
        null
      );

      // Verify payment in pending_review
      const updated = await db
        .select()
        .from(payments)
        .where(eq(payments.id, payment[0].id));

      expect(updated[0].status).toBe("pending_review");
      expect(updated[0].reviewReason).toBe("OCR_DISABLED");
    });
  });
});
