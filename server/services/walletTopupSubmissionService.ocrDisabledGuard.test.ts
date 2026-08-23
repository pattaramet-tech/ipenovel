/**
 * Wallet flow (see server/services/walletTopupSubmissionService.ts) - proves
 * that OCR_ENABLED=false (ocrConfig.enabled === false) SHORT-CIRCUITS BEFORE
 * prepareSlipImageForOcr()/parseSlipImage()/invokeLLM() are ever called, and
 * routes straight to the existing safe pending-review result:
 * status=pending_review, ocrDecision=needs_review, reviewReason=OCR_DISABLED,
 * approvalSource=manual - matching submitPaymentSlip()'s existing behavior in
 * slipSubmissionService.ts (which already checks ocrEnabled before entering
 * the OCR processing block).
 *
 * Everything (db, OCR config, Discord notifications, parseSlipImage,
 * prepareSlipImageForOcr) is mocked - no real database, network, or LLM call.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../db", () => ({
  getWalletTopupById: vi.fn(),
  // The review handlers now go through the guarded variant, which
  // reports whether the write was allowed to land.
  applyWalletTopupOcrUpdate: vi.fn(),
  updateWalletTopupWithOCRApproval: vi.fn(),
  approveWalletTopupWithOCR: vi.fn(),
  creditWalletBalance: vi.fn(),
  getWalletTransactionByReference: vi.fn(),
  getWalletTopupsByUserId: vi.fn(),
}));
vi.mock("../ocr-slip-verification-v2", () => ({
  parseSlipImage: vi.fn(),
  extractSlipData: vi.fn(),
  verifySlipData: vi.fn(),
  generateFingerprint: vi.fn(),
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

import * as db from "../db";
import { parseSlipImage } from "../ocr-slip-verification-v2";
import { getEffectiveOCRConfig } from "../_core/ocr-effective-config";
import { prepareSlipImageForOcr } from "./ocrImageInputService";
import { submitWalletTopupSlip } from "./walletTopupSubmissionService";

describe("submitWalletTopupSlip - OCR_DISABLED guard occurs before any provider call", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("ocrConfig.enabled=false -> no image preparation, no LLM invocation, pending_review/needs_review/OCR_DISABLED, no wallet approval/credit", async () => {
    (db.getWalletTopupById as any).mockResolvedValue({
      id: 42,
      userId: 7,
      status: "pending",
      requestedAmount: "250.00",
      bonusAmount: "10.00",
      creditedAmount: "260.00",
      createdAt: new Date(),
      slipSubmittedAt: null,
    });
    (db.applyWalletTopupOcrUpdate as any).mockResolvedValue({
      applied: true,
      topup: {
      id: 42,
      status: "pending_review",
      ocrDecision: "needs_review",
      reviewReason: "OCR_DISABLED",
      },
    });
    (getEffectiveOCRConfig as any).mockResolvedValue({
      enabled: false,
      autoApproveEnabled: true,
      shadowModeEnabled: false,
      minConfidence: 80,
      maxTimeWindowMinutes: 120,
      source: "default",
      environmentOverride: null,
    });

    const result = await submitWalletTopupSlip(7, 42, "250.00", "r2p:payment-slips/7/slip.png");

    // CRITICAL: no provider/image-preparation call may occur when OCR is
    // disabled - not even a moment before the OCR_DISABLED result.
    expect(prepareSlipImageForOcr).not.toHaveBeenCalled();
    expect(parseSlipImage).not.toHaveBeenCalled();

    expect(result.status).toBe("pending_review");
    expect(result.ocrDecision).toBe("needs_review");
    expect(result.reviewReason).toBe("OCR_DISABLED");

    // No auto-approval or crediting function was ever reached.
    expect(db.approveWalletTopupWithOCR).not.toHaveBeenCalled();
    expect(db.creditWalletBalance).not.toHaveBeenCalled();
    expect(db.getWalletTransactionByReference).not.toHaveBeenCalled();

    // The only DB write on this path is the pending_review status update,
    // with approvalSource=manual (existing safe pending-review contract).
    expect(db.applyWalletTopupOcrUpdate).toHaveBeenCalledTimes(1);
    const [, updateData] = (db.applyWalletTopupOcrUpdate as any).mock.calls[0];
    expect(updateData.status).toBe("pending_review");
    expect(updateData.ocrDecision).toBe("needs_review");
    expect(updateData.reviewReason).toBe("OCR_DISABLED");
    expect(updateData.approvalSource).toBe("manual");
  });

  it("ocrConfig.enabled=true, shadowModeEnabled=true -> OCR still executes for observation (shadow mode unaffected by this guard)", async () => {
    (db.getWalletTopupById as any).mockResolvedValue({
      id: 43,
      userId: 8,
      status: "pending",
      requestedAmount: "100.00",
      bonusAmount: "0.00",
      creditedAmount: "100.00",
      createdAt: new Date(),
      slipSubmittedAt: null,
    });
    (db.applyWalletTopupOcrUpdate as any).mockResolvedValue({
      applied: true,
      topup: {
      id: 43,
      status: "pending_review",
      ocrDecision: "needs_review",
      reviewReason: "SHADOW_MODE",
      },
    });
    (getEffectiveOCRConfig as any).mockResolvedValue({
      enabled: true,
      autoApproveEnabled: true,
      shadowModeEnabled: true,
      minConfidence: 80,
      maxTimeWindowMinutes: 120,
      source: "default",
      environmentOverride: null,
    });
    (prepareSlipImageForOcr as any).mockResolvedValue("data:image/png;base64,AAAA");
    (parseSlipImage as any).mockResolvedValue({
      text: "Amount: 100.00\nRef: FAKE-REF-000\nBank: Test Bank",
      ocrConfidence: 90,
      warnings: [],
      technicalError: false,
    });

    const result = await submitWalletTopupSlip(8, 43, "100.00", "r2p:payment-slips/8/slip.png");

    // Shadow mode is intentionally NOT short-circuited by the OCR_DISABLED
    // guard - it still prepares the image and calls the provider so it can
    // observe what OCR *would* have decided, while still preventing
    // auto-approval.
    expect(prepareSlipImageForOcr).toHaveBeenCalledTimes(1);
    expect(parseSlipImage).toHaveBeenCalledTimes(1);
    expect(result.reviewReason).toBe("SHADOW_MODE");
    expect(db.approveWalletTopupWithOCR).not.toHaveBeenCalled();
  });
});
