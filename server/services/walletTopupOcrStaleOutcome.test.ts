/**
 * R40R54R3 runtime regression: stale OCR staging outcomes.
 *
 * MOCK PROOF (this file): the submission-service handlers are the REAL
 * implementation; only the db module boundary, the OCR pipeline and the
 * Discord sender are mocked. It proves that when the guarded staging UPDATE
 * loses a concurrent settlement race (helper returns {updated: false}),
 * every handler:
 *   - reports the AUTHORITATIVE terminal status (never pending_review),
 *   - sends ZERO Discord review notifications,
 *   - touches ZERO wallet/ledger/approval functions - and because
 *     notification events are only written inside the authoritative
 *     approval transaction, zero approval calls also means zero
 *     notification events for the stale outcome.
 *
 * REAL-DB PROOF of the SQL-level CAS guard itself (row locks, affectedRows
 * under concurrent settlement) remains an S6 disposable-MySQL gap - mocks
 * cannot prove SQL atomicity (see walletTopupLifecycle.test.ts for the
 * structural half and wallet-ocr-production.test.ts for real-DB flows).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db", () => ({
  getWalletTopupById: vi.fn(),
  updateWalletTopupWithOCRApproval: vi.fn(),
  approveWalletTopupWithOCR: vi.fn(),
  creditWalletBalance: vi.fn(),
  getWalletTransactionByReference: vi.fn(),
  getWalletTopupsByUserId: vi.fn(),
  getPendingPayments: vi.fn(),
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
import { sendOCRReviewNotification } from "./discordNotificationService";
import {
  extractSlipData,
  generateFingerprint,
  parseSlipImage,
  verifySlipData,
} from "../ocr-slip-verification-v2";
import { getEffectiveOCRConfig } from "../_core/ocr-effective-config";
import { prepareSlipImageForOcr } from "./ocrImageInputService";
import { submitWalletTopupSlip } from "./walletTopupSubmissionService";

/** Wallet/ledger/approval functions a staging outcome must never reach. */
const MONEY_FUNCTIONS = [
  "creditWalletBalance",
  "getWalletTransactionByReference",
  "approveWalletTopupWithOCR",
] as const;

function pendingTopup(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    userId: 7,
    status: "pending",
    requestedAmount: "250.00",
    bonusAmount: "10.00",
    creditedAmount: "260.00",
    createdAt: new Date(),
    slipSubmittedAt: null,
    ...overrides,
  };
}

/** An authoritative APPROVED row as the stale-return would deliver it. */
function approvedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    userId: 7,
    status: "approved",
    ocrDecision: "approved",
    approvalSource: "manual",
    creditedAmount: "260.00",
    ...overrides,
  };
}

function enabledOcrConfig(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true,
    autoApproveEnabled: false,
    shadowModeEnabled: false,
    minConfidence: 80,
    maxTimeWindowMinutes: 120,
    source: "default",
    environmentOverride: null,
    ...overrides,
  };
}

/** Full OCR pipeline mocks: strong, unique, non-duplicate slip. */
function mockSuccessfulOcrPipeline() {
  (prepareSlipImageForOcr as any).mockResolvedValue("data:image/png;base64,AAAA");
  (parseSlipImage as any).mockResolvedValue({
    text: "Amount: 250.00\nRef: FAKE-REF-000\nBank: Test Bank",
    ocrConfidence: 99,
    warnings: [],
    technicalError: false,
  });
  (extractSlipData as any).mockReturnValue({
    reference: "FAKE-REF-000",
    amount: 250,
  });
  (generateFingerprint as any).mockReturnValue("fp-000");
  (verifySlipData as any).mockReturnValue({
    status: "needs_review",
    reviewReason: null,
    breakdown: {
      ocrConfidence: 99,
      amountMatched: true,
      referencePresent: true,
    },
  });
  (db.getWalletTopupsByUserId as any).mockResolvedValue([]);
  (db.getPendingPayments as any).mockResolvedValue([]);
}

beforeEach(() => {
  (db.getWalletTopupById as any).mockResolvedValue(pendingTopup());
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("R40R54R3 winning staging keeps the pending_review contract", () => {
  it("scenario 1: pending -> pending_review success reports pending_review and sends the Discord review once", async () => {
    (getEffectiveOCRConfig as any).mockResolvedValue(enabledOcrConfig({ enabled: false }));
    (db.updateWalletTopupWithOCRApproval as any).mockResolvedValue({
      updated: true,
      topup: {
        id: 42,
        status: "pending_review",
        ocrDecision: "needs_review",
        reviewReason: "OCR_DISABLED",
      },
    });

    const result = await submitWalletTopupSlip(7, 42, "250.00", "r2p:payment-slips/7/slip.png");

    expect(result.status).toBe("pending_review");
    expect(result.ocrDecision).toBe("needs_review");
    expect(result.reviewReason).toBe("OCR_DISABLED");
    expect(result.stale).toBeFalsy();
    expect(sendOCRReviewNotification).toHaveBeenCalledTimes(1);
    expect(db.updateWalletTopupWithOCRApproval).toHaveBeenCalledTimes(1);
    const [, updateData] = (db.updateWalletTopupWithOCRApproval as any).mock.calls[0];
    expect(updateData.status).toBe("pending_review");
  });
});

describe("R40R54R3 stale outcomes report the authoritative terminal status", () => {
  async function submitWithStaleRow(
    staleRow: Record<string, unknown>,
    configOverrides: Record<string, unknown> = {}
  ) {
    (getEffectiveOCRConfig as any).mockResolvedValue(
      enabledOcrConfig({ enabled: false, ...configOverrides })
    );
    (db.updateWalletTopupWithOCRApproval as any).mockResolvedValue({
      updated: false,
      topup: staleRow,
    });
    return submitWalletTopupSlip(7, 42, "250.00", "r2p:payment-slips/7/slip.png");
  }

  it("scenario 2: manually approved before late OCR -> returns approved with the credited amount, zero Discord", async () => {
    const result = await submitWithStaleRow(approvedRow({ approvalSource: "manual" }));

    expect(result.status).toBe("approved");
    expect(result.stale).toBe(true);
    expect(result.creditedAmount).toBe("260.00");
    expect(result.userMessage).not.toContain("รอแอดมิน");
    expect(sendOCRReviewNotification).not.toHaveBeenCalled();
  });

  it("scenario 3: provider auto-approved before late OCR -> returns approved, zero Discord", async () => {
    const result = await submitWithStaleRow(approvedRow({ approvalSource: "ocr_auto" }));

    expect(result.status).toBe("approved");
    expect(result.stale).toBe(true);
    expect(sendOCRReviewNotification).not.toHaveBeenCalled();
  });

  it("scenario 4: rejected before late OCR -> returns rejected without a credited amount, zero Discord", async () => {
    const result = await submitWithStaleRow({
      id: 42,
      status: "rejected",
      ocrDecision: "rejected",
      creditedAmount: null,
    });

    expect(result.status).toBe("rejected");
    expect(result.stale).toBe(true);
    expect(result.creditedAmount).toBeUndefined();
    expect(sendOCRReviewNotification).not.toHaveBeenCalled();
  });

  it("scenario 5: cancelled before late OCR -> returns cancelled, zero Discord", async () => {
    const result = await submitWithStaleRow({
      id: 42,
      status: "cancelled",
      ocrDecision: null,
    });

    expect(result.status).toBe("cancelled");
    expect(result.stale).toBe(true);
    expect(result.ocrDecision).toBeUndefined();
    expect(sendOCRReviewNotification).not.toHaveBeenCalled();
  });

  it("scenario 6: EVERY stale outcome sends zero Discord review notifications", async () => {
    for (const staleRow of [
      approvedRow({ approvalSource: "manual" }),
      approvedRow({ approvalSource: "ocr_auto" }),
      { id: 42, status: "rejected", ocrDecision: "rejected" },
      { id: 42, status: "cancelled", ocrDecision: null },
    ]) {
      (db.getWalletTopupById as any).mockResolvedValue(pendingTopup());
      const result = await submitWithStaleRow(staleRow);
      expect(result.stale).toBe(true);
    }
    expect(sendOCRReviewNotification).not.toHaveBeenCalled();
  });

  it("scenario 7: stale staging never touches wallet, ledger or approval functions (=> zero notification events)", async () => {
    await submitWithStaleRow(approvedRow());
    for (const fn of MONEY_FUNCTIONS) {
      expect((db as any)[fn]).not.toHaveBeenCalled();
    }
  });

  it("scenario 12a: a WINNING staging also never touches wallet/ledger functions", async () => {
    (getEffectiveOCRConfig as any).mockResolvedValue(enabledOcrConfig({ enabled: false }));
    (db.updateWalletTopupWithOCRApproval as any).mockResolvedValue({
      updated: true,
      topup: {
        id: 42,
        status: "pending_review",
        ocrDecision: "needs_review",
        reviewReason: "OCR_DISABLED",
      },
    });

    await submitWalletTopupSlip(7, 42, "250.00", "r2p:payment-slips/7/slip.png");

    for (const fn of MONEY_FUNCTIONS) {
      expect((db as any)[fn]).not.toHaveBeenCalled();
    }
  });
});

describe("R40R54R3 duplicate / OCR-error handlers honor the stale contract", () => {
  it("scenario 9a: handleDuplicate against a settled topup reports the authoritative status, zero Discord", async () => {
    mockSuccessfulOcrPipeline();
    (verifySlipData as any).mockReturnValue({
      status: "needs_review",
      reviewReason: "DUPLICATE_REFERENCE",
      breakdown: { ocrConfidence: 99, amountMatched: true, referencePresent: true },
    });
    (getEffectiveOCRConfig as any).mockResolvedValue(enabledOcrConfig());
    (db.updateWalletTopupWithOCRApproval as any).mockResolvedValue({
      updated: false,
      topup: approvedRow(),
    });

    const result = await submitWalletTopupSlip(7, 42, "250.00", "r2p:payment-slips/7/slip.png");

    expect(db.updateWalletTopupWithOCRApproval).toHaveBeenCalledTimes(1);
    const [, updateData] = (db.updateWalletTopupWithOCRApproval as any).mock.calls[0];
    expect(updateData.status).toBe("pending_review");
    expect(result.status).toBe("approved");
    expect(result.stale).toBe(true);
    expect(sendOCRReviewNotification).not.toHaveBeenCalled();
    for (const fn of MONEY_FUNCTIONS) {
      expect((db as any)[fn]).not.toHaveBeenCalled();
    }
  });

  it("scenario 9b: handleOCRError against a settled topup reports the authoritative status, zero Discord", async () => {
    (getEffectiveOCRConfig as any).mockResolvedValue(enabledOcrConfig());
    (prepareSlipImageForOcr as any).mockResolvedValue("data:image/png;base64,AAAA");
    (parseSlipImage as any).mockResolvedValue({
      text: "",
      ocrConfidence: 0,
      warnings: [],
      technicalError: true,
    });
    (db.updateWalletTopupWithOCRApproval as any).mockResolvedValue({
      updated: false,
      topup: { id: 42, status: "cancelled", ocrDecision: null },
    });

    const result = await submitWalletTopupSlip(7, 42, "250.00", "r2p:payment-slips/7/slip.png");

    expect(result.status).toBe("cancelled");
    expect(result.stale).toBe(true);
    expect(sendOCRReviewNotification).not.toHaveBeenCalled();
    for (const fn of MONEY_FUNCTIONS) {
      expect((db as any)[fn]).not.toHaveBeenCalled();
    }
  });
});

describe("R40R54R3 auto-approve reports the authoritative settlement", () => {
  function mockApprovablePipeline() {
    mockSuccessfulOcrPipeline();
    (verifySlipData as any).mockReturnValue({
      status: "approved",
      reviewReason: null,
      breakdown: { ocrConfidence: 99, amountMatched: true, referencePresent: true },
    });
    (getEffectiveOCRConfig as any).mockResolvedValue(
      enabledOcrConfig({ autoApproveEnabled: true })
    );
  }

  it("winner path: approved authoritative row reports approved with the row's credited amount", async () => {
    mockApprovablePipeline();
    (db.approveWalletTopupWithOCR as any).mockResolvedValue(
      approvedRow({ creditedAmount: "260.00" })
    );

    const result = await submitWalletTopupSlip(7, 42, "250.00", "r2p:payment-slips/7/slip.png");

    expect(result.status).toBe("approved");
    expect(result.ocrDecision).toBe("approved");
    expect(result.creditedAmount).toBe("260.00");
    expect(result.stale).toBeFalsy();
    expect(db.approveWalletTopupWithOCR).toHaveBeenCalledTimes(1);
  });

  it("stale path: approval UPDATE lost to a concurrent rejection -> reports rejected, never credited", async () => {
    mockApprovablePipeline();
    (db.approveWalletTopupWithOCR as any).mockResolvedValue({
      id: 42,
      status: "rejected",
      ocrDecision: "rejected",
      creditedAmount: null,
    });

    const result = await submitWalletTopupSlip(7, 42, "250.00", "r2p:payment-slips/7/slip.png");

    expect(result.status).toBe("rejected");
    expect(result.creditedAmount).toBeUndefined();
    expect(result.userMessage).not.toContain("เติมเงินสำเร็จ");
  });
});
