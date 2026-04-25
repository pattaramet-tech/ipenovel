import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ApprovalService } from "./services/approvalService";
import { getDb } from "./db";
import { payments } from "../drizzle/schema";
import { eq } from "drizzle-orm";

describe("Approval Metadata", () => {
  let db: any;
  let testPaymentId: number;

  beforeAll(async () => {
    db = await getDb();
    if (!db) throw new Error("Database connection failed");
  });

  afterAll(async () => {
    // Cleanup test data if needed
  });

  describe("Manual Admin Approval", () => {
    it("should store admin identity on manual approval", async () => {
      const testPaymentId = 1; // Assuming test payment exists
      const adminId = 123;
      const adminLabel = "John Admin";

      await ApprovalService.approvePaymentWithSource(testPaymentId, "manual", {
        adminId,
        adminLabel,
        reviewedAt: new Date(),
      });

      const result = await db
        .select()
        .from(payments)
        .where(eq(payments.id, testPaymentId))
        .limit(1);

      expect(result[0]).toBeDefined();
      expect(result[0].approvalSource).toBe("manual");
      expect(result[0].approvedByAdminId).toBe(adminId);
      expect(result[0].approvedByLabel).toBe(adminLabel);
      expect(result[0].approvedAt).toBeDefined();
      expect(result[0].status).toBe("approved");
    });

    it("should set reviewedAt on manual approval", async () => {
      const testPaymentId = 2;
      const now = new Date();

      await ApprovalService.approvePaymentWithSource(testPaymentId, "manual", {
        adminId: 456,
        adminLabel: "Jane Admin",
        reviewedAt: now,
      });

      const result = await db
        .select()
        .from(payments)
        .where(eq(payments.id, testPaymentId))
        .limit(1);

      expect(result[0].reviewedAt).toBeDefined();
    });
  });

  describe("OCR Auto-Approval", () => {
    it("should store OCR Auto-Approve label on auto-approval", async () => {
      const testPaymentId = 3;
      const now = new Date();

      await ApprovalService.approvePaymentWithSource(testPaymentId, "auto", {
        autoApprovedAt: now,
      });

      const result = await db
        .select()
        .from(payments)
        .where(eq(payments.id, testPaymentId))
        .limit(1);

      expect(result[0]).toBeDefined();
      expect(result[0].approvalSource).toBe("auto");
      expect(result[0].approvedByAdminId).toBeNull();
      expect(result[0].approvedByLabel).toBe("OCR Auto-Approve");
      expect(result[0].approvedAt).toBeDefined();
      expect(result[0].autoApprovedAt).toBeDefined();
      expect(result[0].status).toBe("approved");
    });

    it("should not set admin ID on auto-approval", async () => {
      const testPaymentId = 4;

      await ApprovalService.approvePaymentWithSource(testPaymentId, "auto", {});

      const result = await db
        .select()
        .from(payments)
        .where(eq(payments.id, testPaymentId))
        .limit(1);

      expect(result[0].approvedByAdminId).toBeNull();
    });
  });

  describe("Wallet Approval", () => {
    it("should store Wallet label on wallet approval", async () => {
      const testPaymentId = 5;

      await ApprovalService.approvePaymentWithSource(testPaymentId, "wallet", {});

      const result = await db
        .select()
        .from(payments)
        .where(eq(payments.id, testPaymentId))
        .limit(1);

      expect(result[0]).toBeDefined();
      expect(result[0].approvalSource).toBe("wallet");
      expect(result[0].approvedByAdminId).toBeNull();
      expect(result[0].approvedByLabel).toBe("Wallet");
      expect(result[0].approvedAt).toBeDefined();
      expect(result[0].status).toBe("approved");
    });
  });

  describe("Rejection", () => {
    it("should NOT set approval fields on rejection", async () => {
      const testPaymentId = 6;
      const reason = "Invalid slip";

      await ApprovalService.rejectPayment(testPaymentId, reason, 789);

      const result = await db
        .select()
        .from(payments)
        .where(eq(payments.id, testPaymentId))
        .limit(1);

      expect(result[0]).toBeDefined();
      expect(result[0].status).toBe("rejected");
      expect(result[0].rejectionReason).toBe(reason);
      expect(result[0].reviewedByUserId).toBe(789);
      expect(result[0].reviewedAt).toBeDefined();
      // These should NOT be set on rejection
      expect(result[0].approvedAt).toBeNull();
      expect(result[0].approvedByLabel).toBeNull();
    });

    it("should preserve rejection reason", async () => {
      const testPaymentId = 7;
      const reason = "Duplicate slip detected";

      await ApprovalService.rejectPayment(testPaymentId, reason);

      const result = await db
        .select()
        .from(payments)
        .where(eq(payments.id, testPaymentId))
        .limit(1);

      expect(result[0].rejectionReason).toBe(reason);
    });
  });

  describe("Pending Review", () => {
    it("should NOT set approval fields on pending review", async () => {
      const testPaymentId = 8;
      const reviewReason = "LOW_CONFIDENCE";

      await ApprovalService.sendToReview(testPaymentId, reviewReason);

      const result = await db
        .select()
        .from(payments)
        .where(eq(payments.id, testPaymentId))
        .limit(1);

      expect(result[0]).toBeDefined();
      expect(result[0].status).toBe("pending_review");
      expect(result[0].reviewReason).toBe(reviewReason);
      // These should NOT be set on pending review
      expect(result[0].approvedAt).toBeNull();
      expect(result[0].approvedByLabel).toBeNull();
    });
  });

  describe("Display Metadata", () => {
    it("should format approval source for display", () => {
      expect(ApprovalService.formatApprovalSource("manual")).toBe("Manual");
      expect(ApprovalService.formatApprovalSource("auto")).toBe("OCR Auto-Approve");
      expect(ApprovalService.formatApprovalSource("wallet")).toBe("Wallet");
      expect(ApprovalService.formatApprovalSource("legacy")).toBe("Legacy / Unknown");
      expect(ApprovalService.formatApprovalSource(null)).toBe("Unknown");
    });

    it("should handle legacy records gracefully", () => {
      const legacyPayment = {
        id: 999,
        approvalSource: null,
        approvedByLabel: null,
        approvedAt: null,
        autoApprovedAt: null,
        reviewedAt: null,
        reviewedByAdminId: null,
        approvedByAdminId: null,
      };

      const metadata = ApprovalService.getDisplayMetadata(legacyPayment);

      expect(metadata.approvalSource).toBe("Legacy");
      expect(metadata.approvedByLabel).toBe("Legacy / Unknown");
      expect(metadata.approvedAt).toBeNull();
    });

    it("should get display metadata for manual approval", () => {
      const manualPayment = {
        id: 100,
        approvalSource: "manual",
        approvedByLabel: "Admin User",
        approvedAt: new Date("2026-04-25"),
        autoApprovedAt: null,
        reviewedAt: new Date("2026-04-25"),
        reviewedByAdminId: 123,
        approvedByAdminId: 123,
      };

      const metadata = ApprovalService.getDisplayMetadata(manualPayment);

      expect(metadata.approvalSource).toBe("manual");
      expect(metadata.approvedByLabel).toBe("Admin User");
      expect(metadata.approvedByAdminId).toBe(123);
      expect(metadata.reviewedAt).toBeDefined();
    });

    it("should get display metadata for auto-approval", () => {
      const autoPayment = {
        id: 101,
        approvalSource: "auto",
        approvedByLabel: "OCR Auto-Approve",
        approvedAt: new Date("2026-04-25"),
        autoApprovedAt: new Date("2026-04-25"),
        reviewedAt: null,
        reviewedByAdminId: null,
        approvedByAdminId: null,
      };

      const metadata = ApprovalService.getDisplayMetadata(autoPayment);

      expect(metadata.approvalSource).toBe("auto");
      expect(metadata.approvedByLabel).toBe("OCR Auto-Approve");
      expect(metadata.approvedByAdminId).toBeNull();
      expect(metadata.autoApprovedAt).toBeDefined();
    });
  });

  describe("Backward Compatibility", () => {
    it("should handle payments without approval source", () => {
      const oldPayment = {
        id: 200,
        approvalSource: null,
        approvedByLabel: null,
        status: "approved",
      };

      const metadata = ApprovalService.getDisplayMetadata(oldPayment);

      expect(metadata.approvalSource).toBe("Legacy");
      expect(metadata.approvedByLabel).toBe("Legacy / Unknown");
    });

    it("should not crash on missing fields", () => {
      const minimalPayment = {
        id: 201,
      };

      expect(() => {
        ApprovalService.getDisplayMetadata(minimalPayment);
      }).not.toThrow();
    });
  });
});
