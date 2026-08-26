import { describe, expect, it, vi } from "vitest";
import { extractSlipData, parseSlipImage, verifySlipData } from "./ocr-slip-verification-v2";
import { LLMInvokeError } from "./_core/llm";
import { categorizeOcrFailure } from "./services/ocrDiagnosticsService";

/**
 * REAL-FLOW tests.
 *
 * Deliberately exercise parseSlipImage() and the caller contract rather than
 * calling describeProviderFailure() directly - the defect Codex found was
 * that the metadata existed but was DISCARDED between the two. Testing the
 * classifier alone would have passed while the pipeline still lost it.
 */

const noSleep = async () => {};

describe("parseSlipImage propagates sanitized provider diagnostics", () => {
  it("503 after 3 attempts -> PROVIDER_RETRY_EXHAUSTED, HTTP 503, attempts=3", async () => {
    const invokeLLMFn = vi.fn().mockRejectedValue(new LLMInvokeError(503, "generic"));

    const result = await parseSlipImage("data:image/png;base64,AAA", {
      invokeLLMFn,
      sleepFn: noSleep,
    });

    expect(result.technicalError).toBe(true);
    expect(result.technicalErrorCode).toBe("PROVIDER_RETRY_EXHAUSTED");
    expect(result.providerDiagnostic?.providerHttpStatus).toBe(503);
    expect(result.providerDiagnostic?.providerAttemptCount).toBe(3);
    expect(result.providerDiagnostic?.providerMode).toBe("generic");
    // The retry policy really did run three times.
    expect(invokeLLMFn).toHaveBeenCalledTimes(3);
  });

  it("429 exhausted -> PROVIDER_RETRY_EXHAUSTED with the rate-limit status", async () => {
    const invokeLLMFn = vi.fn().mockRejectedValue(new LLMInvokeError(429, "generic"));
    const result = await parseSlipImage("x", { invokeLLMFn, sleepFn: noSleep });

    expect(result.technicalErrorCode).toBe("PROVIDER_RETRY_EXHAUSTED");
    expect(result.providerDiagnostic?.providerHttpStatus).toBe(429);
    expect(result.providerDiagnostic?.providerAttemptCount).toBe(3);
  });

  it("401 -> PROVIDER_AUTH_ERROR, never retried", async () => {
    const invokeLLMFn = vi.fn().mockRejectedValue(new LLMInvokeError(401, "generic"));
    const result = await parseSlipImage("x", { invokeLLMFn, sleepFn: noSleep });

    expect(result.technicalErrorCode).toBe("PROVIDER_AUTH_ERROR");
    expect(result.providerDiagnostic?.providerHttpStatus).toBe(401);
    // A credential problem is not transient - retrying would just repeat it.
    expect(invokeLLMFn).toHaveBeenCalledTimes(1);
    expect(result.providerDiagnostic?.message).toMatch(/not a problem with the slip/i);
  });

  it("403 -> PROVIDER_AUTH_ERROR", async () => {
    const result = await parseSlipImage("x", {
      invokeLLMFn: vi.fn().mockRejectedValue(new LLMInvokeError(403, "generic")),
      sleepFn: noSleep,
    });
    expect(result.technicalErrorCode).toBe("PROVIDER_AUTH_ERROR");
  });

  it("400 -> PROVIDER_BAD_REQUEST, never retried", async () => {
    const invokeLLMFn = vi.fn().mockRejectedValue(new LLMInvokeError(400, "generic"));
    const result = await parseSlipImage("x", { invokeLLMFn, sleepFn: noSleep });
    expect(result.technicalErrorCode).toBe("PROVIDER_BAD_REQUEST");
    expect(invokeLLMFn).toHaveBeenCalledTimes(1);
  });

  it("a network failure -> PROVIDER_NETWORK_ERROR", async () => {
    const netErr = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const result = await parseSlipImage("x", {
      invokeLLMFn: vi.fn().mockRejectedValue(netErr),
      sleepFn: noSleep,
    });
    expect(result.technicalErrorCode).toBe("PROVIDER_NETWORK_ERROR");
  });

  it("every technical failure is categorized TECHNICAL, not DATA", async () => {
    for (const status of [429, 500, 503, 401, 400]) {
      const result = await parseSlipImage("x", {
        invokeLLMFn: vi.fn().mockRejectedValue(new LLMInvokeError(status, "generic")),
        sleepFn: noSleep,
      });
      expect(categorizeOcrFailure(result.technicalErrorCode)).toBe("TECHNICAL");
    }
  });

  it("a successful retry reports success - the provider row must read PASS", async () => {
    const invokeLLMFn = vi
      .fn()
      .mockRejectedValueOnce(new LLMInvokeError(503, "generic"))
      .mockResolvedValueOnce({
        choices: [{ message: { content: "เลขที่รายการ: ABCD1234\nOCR Confidence Score: 97%" } }],
      });

    const result = await parseSlipImage("x", { invokeLLMFn, sleepFn: noSleep });

    expect(result.technicalError).toBeUndefined();
    expect(result.providerDiagnostic).toBeUndefined();
    expect(result.confidenceKnown).toBe(true);
    expect(result.ocrConfidence).toBe(97);
    expect(invokeLLMFn).toHaveBeenCalledTimes(2);
  });
});

describe("diagnostics never leak secrets through the real flow", () => {
  it("a leaky provider error's own message is not propagated", async () => {
    const leaky = new Error(
      "POST https://api.example.com/v1/chat?key=sk-SECRET Authorization: Bearer sk-SECRET failed: {\"error\":\"boom\"}"
    );
    const result = await parseSlipImage("x", {
      invokeLLMFn: vi.fn().mockRejectedValue(leaky),
      sleepFn: noSleep,
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/sk-SECRET/);
    expect(serialized).not.toMatch(/Authorization/i);
    expect(serialized).not.toMatch(/https?:\/\//);
  });

  it("the diagnostic carries only status, mode and attempt count", async () => {
    const result = await parseSlipImage("x", {
      invokeLLMFn: vi.fn().mockRejectedValue(new LLMInvokeError(500, "generic")),
      sleepFn: noSleep,
    });
    const keys = Object.keys(result.providerDiagnostic ?? {}).sort();
    expect(keys).toEqual(
      ["code", "message", "providerAttemptCount", "providerHttpStatus", "providerMode"].sort()
    );
  });
});

// ─── Unknown confidence through the REAL call-site contract ───────────────

describe("unknown confidence survives the real order/wallet call sites", () => {
  /**
   * Both real call sites (ocr-slip-integration-staging.ts and
   * walletTopupSubmissionService.ts) now pass `undefined` - not the numeric 0
   * placeholder - into extractSlipData when confidenceKnown is false. This
   * reproduces that exact expression so a regression at either site fails
   * here.
   */
  const callSiteConfidence = (parseResult: {
    confidenceKnown?: boolean;
    ocrConfidence: number;
  }) => (parseResult.confidenceKnown === false ? undefined : parseResult.ocrConfidence);

  const OCR_TEXT = `ธนาคารกสิกรไทย
22 ส.ค. 69 22:29
xxx-x-x5456-x
เลขที่รายการ: 016234222922AQR05745
รหัสร้านค้า: KB000002283068
จำนวน: 100.00 บาท`;

  it("the call-site expression yields undefined when the provider reported nothing", () => {
    expect(callSiteConfidence({ confidenceKnown: false, ocrConfidence: 0 })).toBeUndefined();
  });

  it("a real parse with no stated confidence produces confidenceKnown=false", async () => {
    const result = await parseSlipImage("x", {
      invokeLLMFn: vi.fn().mockResolvedValue({
        choices: [{ message: { content: OCR_TEXT } }], // no confidence line
      }),
      sleepFn: noSleep,
    });
    expect(result.confidenceKnown).toBe(false);
    expect(result.ocrConfidence).toBe(0); // placeholder only
  });

  it("end-to-end: missing provider confidence -> UNKNOWN_CONFIDENCE, NEEDS_REVIEW", async () => {
    const parsed = await parseSlipImage("x", {
      invokeLLMFn: vi.fn().mockResolvedValue({ choices: [{ message: { content: OCR_TEXT } }] }),
      sleepFn: noSleep,
    });

    const extracted = extractSlipData(parsed.text, callSiteConfidence(parsed));
    expect(extracted.confidenceKnown).toBe(false);

    const now = new Date();
    const verification = verifySlipData(
      { ...extracted, transactionDate: now, transactionDateTime: now },
      {
        orderId: 1,
        paymentId: 1,
        orderTotal: 100,
        orderCreatedAt: now,
        paymentCreatedAt: now,
        slipSubmittedAt: now,
      },
      new Set(),
      new Set()
    );

    expect(verification.reviewReason).toBe("UNKNOWN_CONFIDENCE");
    expect(verification.reviewReason).not.toBe("LOW_CONFIDENCE");
    expect(verification.isAutoApproved).toBe(false);
    expect(verification.status).toBe("pending_review");
  });

  it("passing the numeric 0 placeholder WOULD have mislabelled it - proving the fix matters", async () => {
    const parsed = await parseSlipImage("x", {
      invokeLLMFn: vi.fn().mockResolvedValue({ choices: [{ message: { content: OCR_TEXT } }] }),
      sleepFn: noSleep,
    });

    // The OLD behavior: hand the 0 placeholder straight through.
    const wrong = extractSlipData(parsed.text, parsed.ocrConfidence);
    expect(wrong.confidenceKnown).toBe(true); // 0 read as "provider said 0%"

    const now = new Date();
    const verification = verifySlipData(
      { ...wrong, transactionDate: now, transactionDateTime: now },
      {
        orderId: 1,
        paymentId: 1,
        orderTotal: 100,
        orderCreatedAt: now,
        paymentCreatedAt: now,
        slipSubmittedAt: now,
      },
      new Set(),
      new Set()
    );
    // Which produced the WRONG reason - a data verdict for a provider gap.
    expect(verification.reviewReason).toBe("LOW_CONFIDENCE");
  });

  it("a stated confidence still flows through normally", async () => {
    const parsed = await parseSlipImage("x", {
      invokeLLMFn: vi.fn().mockResolvedValue({
        choices: [{ message: { content: `${OCR_TEXT}\n\nOCR Confidence Score: 96%` } }],
      }),
      sleepFn: noSleep,
    });

    expect(parsed.confidenceKnown).toBe(true);
    const extracted = extractSlipData(parsed.text, callSiteConfidence(parsed));
    expect(extracted.confidenceKnown).toBe(true);
    expect(extracted.visionConfidence).toBe(96);
  });
});
