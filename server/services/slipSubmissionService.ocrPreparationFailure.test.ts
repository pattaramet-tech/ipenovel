/**
 * I. Order flow (see server/services/ocrImageInputService.ts) - proves
 * that an OCR image-preparation failure (prepareSlipImageForOcr() returning
 * null) SHORT-CIRCUITS before ever calling parseSlipImage()/invokeLLM(),
 * and still routes through submitPaymentSlip()'s EXISTING, unchanged
 * technical-error path: manual review via ApprovalService.sendToReview(),
 * never auto-approval.
 *
 * parseSlipImage is deliberately mocked to return a PLAUSIBLE
 * AUTO-APPROVABLE result (technicalError: false, high confidence) - if the
 * short-circuit were ever removed and parseSlipImage("") got called with
 * this mock in place, the test would incorrectly observe an approval path
 * and fail loudly, rather than silently passing for the wrong reason.
 * Everything (db, OCR config, ApprovalService, orderService, Discord
 * notifications, parseSlipImage, prepareSlipImageForOcr) is mocked - no
 * real database, network, or LLM call.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../db", () => ({
  getOrderById: vi.fn(),
  getPaymentByOrderId: vi.fn(),
  getPaymentById: vi.fn(),
  getUserById: vi.fn(),
  updatePayment: vi.fn(),
  updateOrder: vi.fn(),
  recordOrderHistory: vi.fn(),
  getDb: vi.fn(),
}));
vi.mock("../ocr-slip-verification-v2", () => ({
  parseSlipImage: vi.fn(),
}));
vi.mock("../ocr-slip-integration-staging", () => ({
  processSlipVerificationStaging: vi.fn(),
}));
vi.mock("../_core/ocr-effective-config", () => ({
  getEffectiveOCRConfig: vi.fn(),
}));
vi.mock("./discordNotificationService", () => ({
  sendOCRReviewNotification: vi.fn(async () => {}),
}));
vi.mock("./ocrImageInputService", () => ({
  prepareSlipImageForOcr: vi.fn(),
}));
vi.mock("./approvalService", () => ({
  ApprovalService: {
    approvePaymentWithSource: vi.fn(),
    sendToReview: vi.fn(async () => {}),
  },
}));
vi.mock("./orderService", () => ({
  finalizeOrderCompletion: vi.fn(),
}));

import * as db from "../db";
import { parseSlipImage } from "../ocr-slip-verification-v2";
import { getEffectiveOCRConfig } from "../_core/ocr-effective-config";
import { prepareSlipImageForOcr } from "./ocrImageInputService";
import { ApprovalService } from "./approvalService";
import * as orderService from "./orderService";
import { submitPaymentSlip } from "./slipSubmissionService";

describe("submitPaymentSlip - OCR image preparation failure (I)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("preparation failure (null) -> existing manual-review result, never auto-approved", async () => {
    (db.getOrderById as any).mockResolvedValue({
      id: 100,
      userId: 5,
      status: "pending",
      totalAmount: 500,
    });
    (db.getPaymentByOrderId as any).mockResolvedValue({
      id: 200,
      status: "pending",
      slipImageUrl: "r2p:payment-slips/5/slip.png",
    });
    (db.updatePayment as any).mockResolvedValue(undefined);
    (db.updateOrder as any).mockResolvedValue(undefined);
    (db.recordOrderHistory as any).mockResolvedValue(undefined);
    (db.getUserById as any).mockResolvedValue({ id: 5, email: "test@example.invalid" });
    (getEffectiveOCRConfig as any).mockResolvedValue({
      enabled: true,
      autoApproveEnabled: true,
      shadowModeEnabled: false,
      minConfidence: 80,
      maxTimeWindowMinutes: 120,
      source: "default",
      environmentOverride: null,
    });
    // Image preparation failed (e.g. fetch/size/MIME rejection in generic
    // mode) - the exact contract prepareSlipImageForOcr() guarantees on ANY
    // internal failure (see ocrImageInputService.test.ts).
    (prepareSlipImageForOcr as any).mockResolvedValue(null);
    // Deliberately "dangerous": a plausible AUTO-APPROVABLE OCR result, so
    // that if the short-circuit were ever removed and this got called, the
    // test would observe (and fail on) an incorrect approval - never
    // silently pass because the mock happened to already look like a
    // failure. This proves a provider that accepts/ignores an empty image
    // cannot influence approval, since parseSlipImage must never be reached
    // at all on a null preparation result.
    (parseSlipImage as any).mockResolvedValue({
      text: "Amount: 500.00\nRef: FAKE-REF-000\nBank: Test Bank",
      ocrConfidence: 99,
      warnings: [],
      technicalError: false,
    });

    const result = await submitPaymentSlip({
      orderId: 100,
      slipImageUrl: "r2p:payment-slips/5/slip.png",
      userId: 5,
    });

    expect(prepareSlipImageForOcr).toHaveBeenCalledWith("r2p:payment-slips/5/slip.png");
    // CRITICAL: parseSlipImage/invokeLLM must never be reached when
    // preparation returns null - not even with an empty-string fallback.
    expect(parseSlipImage).not.toHaveBeenCalled();

    expect(result.reviewReason).toBe("OCR_PROCESSING_ERROR");
    expect(result.isAutoApproved).toBe(false);

    // Never auto-approved: the approval-transaction path was never entered.
    expect(ApprovalService.approvePaymentWithSource).not.toHaveBeenCalled();
    expect(orderService.finalizeOrderCompletion).not.toHaveBeenCalled();
    expect(db.getDb).not.toHaveBeenCalled();

    // Routed to manual review instead.
    expect(ApprovalService.sendToReview).toHaveBeenCalledTimes(1);
    expect(ApprovalService.sendToReview).toHaveBeenCalledWith(200, "OCR_PROCESSING_ERROR", null, null);

    // Order stays pending/submitted, never approved.
    expect(db.updateOrder).toHaveBeenCalledWith(100, { paymentStatus: "submitted", status: "pending" });
  });
});
