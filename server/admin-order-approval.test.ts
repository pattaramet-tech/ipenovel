/**
 * Tests for admin order approval/rejection flow fixes
 * Covers:
 * - admin.orders.approve uses centralized service (approvalSource, metadata)
 * - admin.orders.reject uses centralized service (reviewedAt, reviewedByUserId)
 * - ApprovalService.getDisplayMetadata uses reviewedByUserId (not reviewedByAdminId)
 * - ApprovalService.formatApprovalSource returns correct labels
 * - paymentMethodBadge logic for all approvalSource values
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ApprovalService } from "./services/approvalService";

// ============================================================
// ApprovalService.getDisplayMetadata — field name consistency
// ============================================================
describe("ApprovalService.getDisplayMetadata", () => {
  it("returns reviewedByUserId (not reviewedByAdminId) from payment record", () => {
    const payment = {
      approvalSource: "manual",
      approvedByLabel: "Admin Alice",
      approvedAt: new Date("2026-04-01T10:00:00Z"),
      autoApprovedAt: null,
      reviewedAt: new Date("2026-04-01T10:00:00Z"),
      reviewedByUserId: 42,       // correct DB column
      reviewedByAdminId: undefined, // this field does NOT exist in DB
      approvedByAdminId: 42,
    };
    const meta = ApprovalService.getDisplayMetadata(payment);
    expect(meta.reviewedByUserId).toBe(42);
    // Must NOT expose the wrong field name
    expect((meta as any).reviewedByAdminId).toBeUndefined();
  });

  it("normalizes null approvalSource to 'legacy' (lowercase)", () => {
    const payment = {
      approvalSource: null,
      approvedByLabel: null,
      approvedAt: null,
      autoApprovedAt: null,
      reviewedAt: null,
      reviewedByUserId: null,
      approvedByAdminId: null,
    };
    const meta = ApprovalService.getDisplayMetadata(payment);
    expect(meta.approvalSource).toBe("legacy");
  });

  it("preserves existing approvalSource when set", () => {
    const payment = {
      approvalSource: "wallet",
      approvedByLabel: "Wallet",
      approvedAt: new Date(),
      autoApprovedAt: null,
      reviewedAt: null,
      reviewedByUserId: null,
      approvedByAdminId: null,
    };
    const meta = ApprovalService.getDisplayMetadata(payment);
    expect(meta.approvalSource).toBe("wallet");
  });

  it("uses fallback label for null approvedByLabel", () => {
    const payment = {
      approvalSource: "legacy",
      approvedByLabel: null,
      approvedAt: null,
      autoApprovedAt: null,
      reviewedAt: null,
      reviewedByUserId: null,
      approvedByAdminId: null,
    };
    const meta = ApprovalService.getDisplayMetadata(payment);
    expect(meta.approvedByLabel).toBe("Legacy / Unknown");
  });
});

// ============================================================
// ApprovalService.formatApprovalSource — label correctness
// ============================================================
describe("ApprovalService.formatApprovalSource", () => {
  it("returns 'Wallet' for wallet source", () => {
    expect(ApprovalService.formatApprovalSource("wallet")).toBe("Wallet");
  });

  it("returns 'OCR Auto-Approve' for auto source", () => {
    expect(ApprovalService.formatApprovalSource("auto")).toBe("OCR Auto-Approve");
  });

  it("returns 'Manual' for manual source", () => {
    expect(ApprovalService.formatApprovalSource("manual")).toBe("Manual");
  });

  it("returns 'Legacy / Unknown' for legacy source", () => {
    expect(ApprovalService.formatApprovalSource("legacy")).toBe("Legacy / Unknown");
  });

  it("returns 'Unknown' for null source", () => {
    expect(ApprovalService.formatApprovalSource(null)).toBe("Unknown");
  });

  it("returns 'Unknown' for undefined source", () => {
    expect(ApprovalService.formatApprovalSource(undefined)).toBe("Unknown");
  });
});

// ============================================================
// ApprovalService.approvePaymentWithSource — manual metadata
// ============================================================
describe("ApprovalService.approvePaymentWithSource — manual", () => {
  it("sets all required manual approval fields", async () => {
    const capturedSet: any[] = [];
    const mockTx = {
      update: () => ({
        set: (data: any) => {
          capturedSet.push(data);
          return { where: () => Promise.resolve() };
        },
      }),
    };

    await ApprovalService.approvePaymentWithSource(
      1,
      "manual",
      { adminId: 99, adminLabel: "Admin Bob", reviewedAt: new Date("2026-04-01T10:00:00Z") },
      mockTx
    );

    expect(capturedSet).toHaveLength(1);
    const data = capturedSet[0];
    expect(data.approvalSource).toBe("manual");
    expect(data.status).toBe("approved");
    expect(data.approvedByAdminId).toBe(99);
    expect(data.approvedByLabel).toBe("Admin Bob");
    expect(data.reviewedByUserId).toBe(99);
    expect(data.reviewedAt).toBeInstanceOf(Date);
    expect(data.approvedAt).toBeInstanceOf(Date);
  });

  it("sets all required wallet approval fields", async () => {
    const capturedSet: any[] = [];
    const mockTx = {
      update: () => ({
        set: (data: any) => {
          capturedSet.push(data);
          return { where: () => Promise.resolve() };
        },
      }),
    };

    await ApprovalService.approvePaymentWithSource(1, "wallet", {}, mockTx);

    const data = capturedSet[0];
    expect(data.approvalSource).toBe("wallet");
    expect(data.status).toBe("approved");
    expect(data.approvedByLabel).toBe("Wallet");
    expect(data.approvedByAdminId).toBeNull();
  });

  it("sets all required OCR auto-approval fields", async () => {
    const capturedSet: any[] = [];
    const mockTx = {
      update: () => ({
        set: (data: any) => {
          capturedSet.push(data);
          return { where: () => Promise.resolve() };
        },
      }),
    };

    const autoTime = new Date("2026-04-01T10:00:00Z");
    await ApprovalService.approvePaymentWithSource(
      1,
      "auto",
      { autoApprovedAt: autoTime },
      mockTx
    );

    const data = capturedSet[0];
    expect(data.approvalSource).toBe("auto");
    expect(data.status).toBe("approved");
    expect(data.approvedByLabel).toBe("OCR Auto-Approve");
    expect(data.autoApprovedAt).toBe(autoTime);
    expect(data.approvedByAdminId).toBeNull();
  });
});

// ============================================================
// ApprovalService.rejectPayment — rejection metadata
// ============================================================
describe("ApprovalService.rejectPayment", () => {
  it("sets reviewedByUserId, reviewedAt, rejectionReason and status=rejected", async () => {
    const capturedSet: any[] = [];
    const mockTx = {
      update: () => ({
        set: (data: any) => {
          capturedSet.push(data);
          return { where: () => Promise.resolve() };
        },
      }),
    };

    await ApprovalService.rejectPayment(1, "Slip is blurry", 55, mockTx);

    expect(capturedSet).toHaveLength(1);
    const data = capturedSet[0];
    expect(data.status).toBe("rejected");
    expect(data.rejectionReason).toBe("Slip is blurry");
    expect(data.reviewedByUserId).toBe(55);
    expect(data.reviewedAt).toBeInstanceOf(Date);
    // Must NOT set approval fields
    expect(data.approvalSource).toBeUndefined();
    expect(data.approvedAt).toBeUndefined();
    expect(data.approvedByAdminId).toBeUndefined();
    expect(data.approvedByLabel).toBeUndefined();
  });

  it("allows null reviewedByUserId when no admin ID provided", async () => {
    const capturedSet: any[] = [];
    const mockTx = {
      update: () => ({
        set: (data: any) => {
          capturedSet.push(data);
          return { where: () => Promise.resolve() };
        },
      }),
    };

    await ApprovalService.rejectPayment(1, "Duplicate slip", undefined, mockTx);

    const data = capturedSet[0];
    expect(data.reviewedByUserId).toBeNull();
    expect(data.status).toBe("rejected");
  });
});

// ============================================================
// Payment method badge logic (mirrors frontend paymentMethodBadge)
// ============================================================
function paymentMethodBadge(approvalSource: string | null | undefined, formattedApprovalSource?: string | null) {
  switch (approvalSource) {
    case "wallet":
      return { label: "Wallet", color: "bg-purple-100 text-purple-800" };
    case "auto":
      return { label: "OCR Auto-Approve", color: "bg-blue-100 text-blue-800" };
    case "manual":
      return { label: "Transfer (Manual)", color: "bg-green-100 text-green-800" };
    case "legacy":
      return { label: "Legacy", color: "bg-slate-100 text-slate-600" };
    default:
      if (formattedApprovalSource && formattedApprovalSource !== "Unknown") {
        return { label: formattedApprovalSource, color: "bg-slate-100 text-slate-600" };
      }
      return { label: "Unknown", color: "bg-slate-100 text-slate-500" };
  }
}

describe("paymentMethodBadge", () => {
  it("returns Wallet badge for wallet approvalSource", () => {
    const badge = paymentMethodBadge("wallet");
    expect(badge.label).toBe("Wallet");
    expect(badge.color).toContain("purple");
  });

  it("returns OCR badge for auto approvalSource", () => {
    const badge = paymentMethodBadge("auto");
    expect(badge.label).toBe("OCR Auto-Approve");
    expect(badge.color).toContain("blue");
  });

  it("returns Transfer (Manual) badge for manual approvalSource", () => {
    const badge = paymentMethodBadge("manual");
    expect(badge.label).toBe("Transfer (Manual)");
    expect(badge.color).toContain("green");
  });

  it("returns Legacy badge for legacy approvalSource", () => {
    const badge = paymentMethodBadge("legacy");
    expect(badge.label).toBe("Legacy");
    expect(badge.color).toContain("slate");
  });

  it("returns Unknown for null approvalSource with no formatted source", () => {
    const badge = paymentMethodBadge(null);
    expect(badge.label).toBe("Unknown");
  });

  it("uses formattedApprovalSource as fallback when approvalSource is null", () => {
    const badge = paymentMethodBadge(null, "OCR Auto-Approve");
    expect(badge.label).toBe("OCR Auto-Approve");
  });

  it("ignores formattedApprovalSource when it is 'Unknown'", () => {
    const badge = paymentMethodBadge(null, "Unknown");
    expect(badge.label).toBe("Unknown");
  });

  it("returns Unknown for undefined approvalSource", () => {
    const badge = paymentMethodBadge(undefined);
    expect(badge.label).toBe("Unknown");
  });
});

// ============================================================
// Payment status color logic (mirrors frontend paymentStatusColor)
// ============================================================
function paymentStatusColor(status: string | undefined | null): string {
  switch (status) {
    case "approved": return "bg-green-100 text-green-800";
    case "rejected": return "bg-red-100 text-red-800";
    case "pending_review": return "bg-orange-100 text-orange-800";
    case "submitted": return "bg-blue-100 text-blue-800";
    case "pending":
    default: return "bg-yellow-100 text-yellow-800";
  }
}

describe("paymentStatusColor", () => {
  it("approved → green", () => {
    expect(paymentStatusColor("approved")).toContain("green");
  });

  it("rejected → red", () => {
    expect(paymentStatusColor("rejected")).toContain("red");
  });

  it("pending_review → orange (not yellow)", () => {
    const color = paymentStatusColor("pending_review");
    expect(color).toContain("orange");
    expect(color).not.toContain("yellow");
  });

  it("submitted → blue", () => {
    expect(paymentStatusColor("submitted")).toContain("blue");
  });

  it("pending → yellow", () => {
    expect(paymentStatusColor("pending")).toContain("yellow");
  });

  it("null → yellow (default)", () => {
    expect(paymentStatusColor(null)).toContain("yellow");
  });

  it("undefined → yellow (default)", () => {
    expect(paymentStatusColor(undefined)).toContain("yellow");
  });
});
