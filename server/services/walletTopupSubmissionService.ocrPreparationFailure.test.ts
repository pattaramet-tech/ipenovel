/**
 * H. Wallet flow (see server/services/ocrImageInputService.ts) - proves
 * that an OCR image-preparation failure (prepareSlipImageForOcr() returning
 * null, e.g. a generic-mode fetch/size/MIME failure) still routes through
 * submitWalletTopupSlip()'s EXISTING, unchanged technical-error path:
 * pending_review / needs_review / OCR_PROCESSING_ERROR, with no wallet
 * credit and no transaction created. Everything (db, OCR config, Discord
 * notifications, parseSlipImage, prepareSlipImageForOcr) is mocked - no
 * real database, network, or LLM call.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../db", () => ({
  getWalletTopupById: vi.fn(),
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

describe("submitWalletTopupSlip - OCR image preparation failure (H)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("preparation failure (null) -> pending_review / needs_review / OCR_PROCESSING_ERROR, no wallet credit, no transaction created", async () => {
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
    (db.updateWalletTopupWithOCRApproval as any).mockResolvedValue({
      id: 42,
      status: "pending_review",
      ocrDecision: "needs_review",
      reviewReason: "OCR_PROCESSING_ERROR",
    });
    (getEffectiveOCRConfig as any).mockResolvedValue({
      enabled: true,
      autoApproveEnabled: true,
      shadowModeEnabled: false,
      minConfidence: 80,
      maxTimeWindowMinutes: 120,
      source: "default",
      environmentOverride: null,
    });
    // The image-preparation helper failed (e.g. fetch/size/MIME rejection) -
    // this is the exact contract prepareSlipImageForOcr() guarantees on ANY
    // internal failure (see ocrImageInputService.test.ts).
    (prepareSlipImageForOcr as any).mockResolvedValue(null);
    // parseSlipImage("") is what actually runs in production when handed an
    // empty image_url - its own documented technicalError=true contract,
    // not re-tested here (see ocr-slip-verification-v2.test.ts).
    (parseSlipImage as any).mockResolvedValue({
      text: "",
      ocrConfidence: 0,
      warnings: ["Error parsing image - check URL and image format"],
      technicalError: true,
    });

    const result = await submitWalletTopupSlip(7, 42, "250.00", "r2p:payment-slips/7/slip.png");

    expect(prepareSlipImageForOcr).toHaveBeenCalledWith("r2p:payment-slips/7/slip.png");
    // parseSlipImage must have been called with the "" fallback, never a
    // truthy but broken value.
    expect(parseSlipImage).toHaveBeenCalledWith("");

    expect(result.status).toBe("pending_review");
    expect(result.ocrDecision).toBe("needs_review");
    expect(result.reviewReason).toBe("OCR_PROCESSING_ERROR");

    // No auto-approval or crediting function was ever reached.
    expect(db.approveWalletTopupWithOCR).not.toHaveBeenCalled();
    expect(db.creditWalletBalance).not.toHaveBeenCalled();
    expect(db.getWalletTransactionByReference).not.toHaveBeenCalled();

    // The only DB write on this path is the pending_review status update.
    expect(db.updateWalletTopupWithOCRApproval).toHaveBeenCalledTimes(1);
    const [, updateData] = (db.updateWalletTopupWithOCRApproval as any).mock.calls[0];
    expect(updateData.status).toBe("pending_review");
    expect(updateData.ocrDecision).toBe("needs_review");
    expect(updateData.reviewReason).toBe("OCR_PROCESSING_ERROR");
  });
});
