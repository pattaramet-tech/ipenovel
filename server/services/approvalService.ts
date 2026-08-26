import { getDb } from "../db";
import { payments } from "../../drizzle/schema";
import { and, eq, isNull, or } from "drizzle-orm";

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
   * Send payment to manual review.
   * Does NOT set approval metadata.
   *
   * Conditioned on the payment still being reviewable, so a late-finishing
   * automatic OCR run can never resurrect an already-finalized payment back
   * to "pending_review".
   *
   * `expectedSlipVersion`, when passed, additionally requires the row's
   * current `(slipImageUrl, slipSubmittedAt)` to still match it. Callers
   * pass this when `extractedData` was computed against a specific slip
   * snapshot (an automatic OCR run) rather than being read fresh from the
   * row inside this same call - without it, OCR started for slip B could
   * still publish B's extraction after the customer replaced B with C.
   *
   * Returns whether this call actually won the write. Callers MUST treat
   * `false` as "nothing was published" and must not proceed with any
   * further write that assumes this one landed.
   *
   * @param tx - Optional transaction context for atomic operations
   */
  static async sendToReview(
    paymentId: number,
    reviewReason: string,
    extractedData?: any,
    fingerprint?: string,
    expectedSlipVersion?: { slipImageUrl: string | null; slipSubmittedAt: Date | null },
    tx?: any
  ): Promise<boolean> {
    const db = tx || (await getDb());
    if (!db) throw new Error("Database connection failed");

    const conditions = [
      eq(payments.id, paymentId),
      or(eq(payments.status, "pending"), eq(payments.status, "pending_review")),
    ];

    if (expectedSlipVersion) {
      conditions.push(
        expectedSlipVersion.slipImageUrl === null
          ? isNull(payments.slipImageUrl)
          : eq(payments.slipImageUrl, expectedSlipVersion.slipImageUrl)
      );
      conditions.push(
        expectedSlipVersion.slipSubmittedAt === null
          ? isNull(payments.slipSubmittedAt)
          : eq(payments.slipSubmittedAt, expectedSlipVersion.slipSubmittedAt)
      );
    }

    const result = await db
      .update(payments)
      .set({
        status: "pending_review",
        reviewReason,
        extractedData: extractedData ? JSON.stringify(extractedData) : null,
        fingerprint: fingerprint || null,
        // DO NOT set approval fields
      })
      .where(and(...conditions));

    const header = Array.isArray(result) ? result[0] : result;
    return ((header as any)?.affectedRows || 0) > 0;
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
