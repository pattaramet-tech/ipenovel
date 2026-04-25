import { getDb } from "../db";
import { payments } from "../../drizzle/schema";
import { eq } from "drizzle-orm";

/**
 * Approval metadata types
 */
export type ApprovalSource = "manual" | "auto" | "wallet" | "legacy";

export interface ApprovalMetadata {
  approvalSource: ApprovalSource;
  approvedByAdminId: number | null;
  approvedByLabel: string | null;
  approvedAt: Date;
  autoApprovedAt?: Date | null;
  reviewedAt?: Date | null;
  reviewedByUserId?: number | null;
}

/**
 * Centralized approval service to standardize approval metadata across all paths
 */
export class ApprovalService {
  /**
   * Approve a payment with source metadata
   * Supports: manual admin approval, OCR auto-approval, wallet approval
   * @param tx - Optional transaction context for atomic operations
   */
  static async approvePaymentWithSource(
    paymentId: number,
    source: ApprovalSource,
    metadata: {
      adminId?: number;
      adminLabel?: string;
      autoApprovedAt?: Date;
      reviewedAt?: Date;
    },
    tx?: any
  ) {
    const db = tx || (await getDb());
    if (!db) throw new Error("Database connection failed");

    const now = new Date();

    // Build approval metadata based on source
    let approvalData: any = {
      status: "approved",
      approvalSource: source,
      approvedAt: now,
    };

    switch (source) {
      case "manual":
        // Manual admin approval
        approvalData.approvedByAdminId = metadata.adminId || null;
        approvalData.approvedByLabel = metadata.adminLabel || "Admin";
        approvalData.reviewedAt = metadata.reviewedAt || now;
        approvalData.reviewedByUserId = metadata.adminId || null;
        break;

      case "auto":
        // OCR auto-approval
        approvalData.approvedByAdminId = null;
        approvalData.approvedByLabel = "OCR Auto-Approve";
        approvalData.autoApprovedAt = metadata.autoApprovedAt || now;
        break;

      case "wallet":
        // Wallet approval
        approvalData.approvedByAdminId = null;
        approvalData.approvedByLabel = "Wallet";
        break;

      case "legacy":
        // Legacy approval (backward compatibility)
        approvalData.approvedByAdminId = null;
        approvalData.approvedByLabel = "Legacy / Unknown";
        break;
    }

    // Update payment with approval metadata
    await db
      .update(payments)
      .set(approvalData)
      .where(eq(payments.id, paymentId));

    return approvalData;
  }

  /**
   * Reject a payment with reason
   * Does NOT set approval metadata
   * @param tx - Optional transaction context for atomic operations
   */
  static async rejectPayment(
    paymentId: number,
    reason: string,
    reviewedByAdminId?: number,
    tx?: any
  ) {
    const db = tx || (await getDb());
    if (!db) throw new Error("Database connection failed");

    const now = new Date();

    await db
      .update(payments)
      .set({
        status: "rejected",
        rejectionReason: reason,
        reviewedAt: now,
        reviewedByUserId: reviewedByAdminId || null,
        // DO NOT set approval fields
      })
      .where(eq(payments.id, paymentId));
  }

  /**
   * Send payment to manual review
   * Does NOT set approval metadata
   * @param tx - Optional transaction context for atomic operations
   */
  static async sendToReview(
    paymentId: number,
    reviewReason: string,
    extractedData?: any,
    fingerprint?: string,
    tx?: any
  ) {
    const db = tx || (await getDb());
    if (!db) throw new Error("Database connection failed");

    await db
      .update(payments)
      .set({
        status: "pending_review",
        reviewReason,
        extractedData: extractedData ? JSON.stringify(extractedData) : null,
        fingerprint: fingerprint || null,
        // DO NOT set approval fields
      })
      .where(eq(payments.id, paymentId));
  }

  /**
   * Get approval metadata for display
   * Handles legacy records gracefully
   */
  static getDisplayMetadata(payment: any) {
    return {
      // Normalize to lowercase to match ApprovalSource enum
      approvalSource: (payment.approvalSource as string | null) || "legacy",
      approvedByLabel: payment.approvedByLabel || "Legacy / Unknown",
      approvedAt: payment.approvedAt,
      autoApprovedAt: payment.autoApprovedAt,
      reviewedAt: payment.reviewedAt,
      // Bug fix: DB column is reviewedByUserId, not reviewedByAdminId
      reviewedByUserId: payment.reviewedByUserId,
      approvedByAdminId: payment.approvedByAdminId,
    };
  }

  /**
   * Format approval source for UI display
   */
  static formatApprovalSource(source: ApprovalSource | null | undefined): string {
    switch (source) {
      case "manual":
        return "Manual";
      case "auto":
        return "OCR Auto-Approve";
      case "wallet":
        return "Wallet";
      case "legacy":
        return "Legacy / Unknown";
      default:
        return "Unknown";
    }
  }
}
