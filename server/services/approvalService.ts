import { withAccountMergePaymentMutationGuard } from "../db";
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
 * Centralized approval service to standardize approval metadata across all paths.
 *
 * IPE-005: every method that mutates a payment is also a classified mutation
 * of the owning account. The payment-owner guard resolves the order owner,
 * acquires the canonical users-row / account-merge guard first, then locks the
 * payment row before the write. This keeps OCR/admin/background paths on the
 * same lock hierarchy as checkout and manual approval.
 */
export class ApprovalService {
  /**
   * Approve a payment with source metadata.
   * Supports: manual admin approval, OCR auto-approval, wallet approval.
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
    const now = new Date();

    const approvalData: any = {
      status: "approved",
      approvalSource: source,
      approvedAt: now,
    };

    switch (source) {
      case "manual":
        approvalData.approvedByAdminId = metadata.adminId || null;
        approvalData.approvedByLabel = metadata.adminLabel || "Admin";
        approvalData.reviewedAt = metadata.reviewedAt || now;
        approvalData.reviewedByUserId = metadata.adminId || null;
        break;

      case "auto":
        approvalData.approvedByAdminId = null;
        approvalData.approvedByLabel = "OCR Auto-Approve";
        approvalData.autoApprovedAt = metadata.autoApprovedAt || now;
        break;

      case "wallet":
        approvalData.approvedByAdminId = null;
        approvalData.approvedByLabel = "Wallet";
        break;

      case "legacy":
        approvalData.approvedByAdminId = null;
        approvalData.approvedByLabel = "Legacy / Unknown";
        break;
    }

    await withAccountMergePaymentMutationGuard(paymentId, tx, async (guardedDb) => {
      await guardedDb
        .update(payments)
        .set(approvalData)
        .where(eq(payments.id, paymentId));
    });

    return approvalData;
  }

  /** Reject a payment with reason. Does NOT set approval metadata. */
  static async rejectPayment(
    paymentId: number,
    reason: string,
    reviewedByAdminId?: number,
    tx?: any
  ) {
    const now = new Date();

    await withAccountMergePaymentMutationGuard(paymentId, tx, async (guardedDb) => {
      await guardedDb
        .update(payments)
        .set({
          status: "rejected",
          rejectionReason: reason,
          reviewedAt: now,
          reviewedByUserId: reviewedByAdminId || null,
          // DO NOT set approval fields
        })
        .where(eq(payments.id, paymentId));
    });
  }

  /**
   * Send payment to manual review.
   * Does NOT set approval metadata.
   *
   * Conditioned on the payment still being reviewable, so a late-finishing
   * automatic OCR run can never resurrect an already-finalized payment back
   * to "pending_review". `expectedSlipVersion`, when supplied, additionally
   * requires the current slip identity to remain the exact one this OCR run
   * processed.
   */
  static async sendToReview(
    paymentId: number,
    reviewReason: string,
    extractedData?: any,
    fingerprint?: string,
    expectedSlipVersion?: { slipImageUrl: string | null; slipSubmittedAt: Date | null; evidenceVersion?: number },
    tx?: any
  ): Promise<boolean> {
    const updateData: any = {
      status: "pending_review",
      reviewReason,
      extractedData: extractedData ? JSON.stringify(extractedData) : null,
      fingerprint: fingerprint || null,
      // DO NOT set approval fields
      extractedEvidenceVersion: extractedData == null
        ? null
        : (expectedSlipVersion?.evidenceVersion ?? undefined),
    };

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
      if (expectedSlipVersion.evidenceVersion !== undefined) {
        conditions.push(eq(payments.evidenceVersion, expectedSlipVersion.evidenceVersion));
      }
    }

    return withAccountMergePaymentMutationGuard(paymentId, tx, async (guardedDb) => {
      const result = await guardedDb
        .update(payments)
        .set(updateData)
        .where(and(...conditions));

      const header = Array.isArray(result) ? result[0] : result;
      return ((header as any)?.affectedRows || 0) > 0;
    });
  }

  /** Get approval metadata for display; handles legacy records gracefully. */
  static getDisplayMetadata(payment: any) {
    return {
      approvalSource: (payment.approvalSource as string | null) || "legacy",
      approvedByLabel: payment.approvedByLabel || "Legacy / Unknown",
      approvedAt: payment.approvedAt,
      autoApprovedAt: payment.autoApprovedAt,
      reviewedAt: payment.reviewedAt,
      reviewedByUserId: payment.reviewedByUserId,
      approvedByAdminId: payment.approvedByAdminId,
    };
  }

  /** Format approval source for UI display. */
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
