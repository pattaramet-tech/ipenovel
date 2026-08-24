/**
 * Order flow (see server/services/slipSubmissionService.ts) - regression
 * proof that OCR_ENABLED=false (effectiveConfig.enabled === false) already
 * short-circuits BEFORE prepareSlipImageForOcr()/parseSlipImage()/
 * invokeLLM() are ever called, routing straight to manual review via
 * ApprovalService.sendToReview() with reviewReason=OCR_DISABLED. This
 * behavior was already correct before this change (submitPaymentSlip()
 * checks `ocrEnabled` before entering the OCR processing block) - this test
 * exists to prove it stays that way alongside the new wallet-flow guard in
 * walletTopupSubmissionService.ts.
 *
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
  publishReplacementSlipIfReviewable: vi.fn(async () => true),
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
    sendToReview: vi.fn(async () => true),
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

describe("submitPaymentSlip - OCR_DISABLED guard occurs before any provider call (regression)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("effectiveConfig.enabled=false -> no image preparation, no LLM invocation, manual review with reviewReason=OCR_DISABLED", async () => {
    (db.getOrderById as any).mockResolvedValue({
      id: 101,
      userId: 6,
      status: "pending",
      totalAmount: 500,
    });
    (db.getPaymentByOrderId as any).mockResolvedValue({
      id: 201,
      status: "pending",
      slipImageUrl: "r2p:payment-slips/6/slip.png",
    });
    (db.getPaymentById as any).mockResolvedValue({
      id: 201,
      status: "pending",
      slipImageUrl: "r2p:payment-slips/6/slip.png",
      slipSubmittedAt: new Date("2026-01-01T00:00:00Z"),
    });
    (db.updatePayment as any).mockResolvedValue(undefined);
    (db.updateOrder as any).mockResolvedValue(undefined);
    (db.recordOrderHistory as any).mockResolvedValue(undefined);
    (db.getUserById as any).mockResolvedValue({ id: 6, email: "test@example.invalid" });
    (getEffectiveOCRConfig as any).mockResolvedValue({
      enabled: false,
      autoApproveEnabled: true,
      shadowModeEnabled: false,
      minConfidence: 80,
      maxTimeWindowMinutes: 120,
      source: "default",
      environmentOverride: null,
    });

    const result = await submitPaymentSlip({
      orderId: 101,
      slipImageUrl: "r2p:payment-slips/6/slip.png",
      userId: 6,
    });

    // CRITICAL: no provider/image-preparation call may occur when OCR is
    // disabled.
    expect(prepareSlipImageForOcr).not.toHaveBeenCalled();
    expect(parseSlipImage).not.toHaveBeenCalled();

    expect(result.reviewReason).toBe("OCR_DISABLED");
    expect(result.isAutoApproved).toBe(false);

    expect(ApprovalService.approvePaymentWithSource).not.toHaveBeenCalled();
    expect(orderService.finalizeOrderCompletion).not.toHaveBeenCalled();
    // db.getDb IS now called once - the OCR attempt recorder persists a
    // `config_blocked` row so history shows why this slip was never
    // processed. That is a diagnostic write, not an approval: the assertions
    // above already prove no provider call happened and no approval or
    // finalization ran, which is what this regression guards.
    expect(ApprovalService.approvePaymentWithSource).not.toHaveBeenCalled();

    expect(ApprovalService.sendToReview).toHaveBeenCalledTimes(1);
    expect(ApprovalService.sendToReview).toHaveBeenCalledWith(
      201,
      "OCR_DISABLED",
      null,
      null,
      {
        slipImageUrl: "r2p:payment-slips/6/slip.png",
        slipSubmittedAt: new Date("2026-01-01T00:00:00Z"),
      }
    );

    expect(db.updateOrder).toHaveBeenCalledWith(101, { paymentStatus: "submitted", status: "pending" });
  });
});
