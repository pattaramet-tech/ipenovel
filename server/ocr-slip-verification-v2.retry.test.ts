/**
 * Bounded OCR-specific transient-retry policy around parseSlipImage()'s
 * single invokeLLM() call (see ocr-slip-verification-v2.ts). Proven with a
 * fully injected invokeLLMFn/sleepFn (ParseSlipImageDeps) - no real network,
 * no real timers, no 1.5s of actual waiting.
 */
import { describe, expect, it, vi } from "vitest";
import { parseSlipImage, type InvokeLLMFn, type SleepFn } from "./ocr-slip-verification-v2";
import { LLMInvokeError, type InvokeResult } from "./_core/llm";

const FAKE_IMAGE_URL = "data:image/png;base64,AAAAAAAAAAAAAAAAAAAAAAAA";

function successResult(text: string): InvokeResult {
  return {
    id: "test-id",
    created: 1234567890,
    model: "test-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      },
    ],
  };
}

function makeDeps(invokeLLMFn: InvokeLLMFn) {
  const sleepFn: SleepFn = vi.fn().mockResolvedValue(undefined);
  return { invokeLLMFn, sleepFn };
}

describe("parseSlipImage - bounded OCR-specific transient retry", () => {
  it("1. generic 503 -> success: retries once, returns the successful result, technicalError is not true", async () => {
    const invokeLLMFn = vi
      .fn()
      .mockRejectedValueOnce(new LLMInvokeError(503, "generic"))
      .mockResolvedValueOnce(successResult("OCR text after recovery"));
    const deps = makeDeps(invokeLLMFn);

    const result = await parseSlipImage(FAKE_IMAGE_URL, deps);

    expect(invokeLLMFn).toHaveBeenCalledTimes(2);
    expect(result.technicalError).not.toBe(true);
    expect(result.text).toBe("OCR text after recovery");
    expect(deps.sleepFn).toHaveBeenCalledTimes(1);
    expect(deps.sleepFn).toHaveBeenNthCalledWith(1, 500);
  });

  it("2. generic 429 -> success after retry", async () => {
    const invokeLLMFn = vi
      .fn()
      .mockRejectedValueOnce(new LLMInvokeError(429, "generic"))
      .mockResolvedValueOnce(successResult("OCR text after rate limit"));
    const deps = makeDeps(invokeLLMFn);

    const result = await parseSlipImage(FAKE_IMAGE_URL, deps);

    expect(invokeLLMFn).toHaveBeenCalledTimes(2);
    expect(result.technicalError).not.toBe(true);
    expect(result.text).toBe("OCR text after rate limit");
    expect(deps.sleepFn).toHaveBeenCalledTimes(1);
    expect(deps.sleepFn).toHaveBeenNthCalledWith(1, 500);
  });

  it.each([500, 502, 503, 504])(
    "3. generic %i -> retry exhaustion: exactly 3 total attempts, final technicalError=true",
    async (status) => {
      const invokeLLMFn = vi.fn().mockRejectedValue(new LLMInvokeError(status, "generic"));
      const deps = makeDeps(invokeLLMFn);

      const result = await parseSlipImage(FAKE_IMAGE_URL, deps);

      expect(invokeLLMFn).toHaveBeenCalledTimes(3);
      expect(result.technicalError).toBe(true);
      expect(result.text).toBe("");
      expect(result.ocrConfidence).toBe(0);
      expect(deps.sleepFn).toHaveBeenCalledTimes(2);
      expect(deps.sleepFn).toHaveBeenNthCalledWith(1, 500);
      expect(deps.sleepFn).toHaveBeenNthCalledWith(2, 1000);
    }
  );

  it("4. generic 400 -> exactly one attempt, no retry, technicalError=true", async () => {
    const invokeLLMFn = vi.fn().mockRejectedValue(new LLMInvokeError(400, "generic"));
    const deps = makeDeps(invokeLLMFn);

    const result = await parseSlipImage(FAKE_IMAGE_URL, deps);

    expect(invokeLLMFn).toHaveBeenCalledTimes(1);
    expect(deps.sleepFn).not.toHaveBeenCalled();
    expect(result.technicalError).toBe(true);
  });

  it.each([401, 403])("5. generic %i -> no retry", async (status) => {
    const invokeLLMFn = vi.fn().mockRejectedValue(new LLMInvokeError(status, "generic"));
    const deps = makeDeps(invokeLLMFn);

    const result = await parseSlipImage(FAKE_IMAGE_URL, deps);

    expect(invokeLLMFn).toHaveBeenCalledTimes(1);
    expect(deps.sleepFn).not.toHaveBeenCalled();
    expect(result.technicalError).toBe(true);
  });

  it("6. successful generic request -> exactly one attempt", async () => {
    const invokeLLMFn = vi.fn().mockResolvedValue(successResult("OCR text, first try"));
    const deps = makeDeps(invokeLLMFn);

    const result = await parseSlipImage(FAKE_IMAGE_URL, deps);

    expect(invokeLLMFn).toHaveBeenCalledTimes(1);
    expect(deps.sleepFn).not.toHaveBeenCalled();
    expect(result.technicalError).not.toBe(true);
    expect(result.text).toBe("OCR text, first try");
  });

  it("7. legacy_forge 503 -> exactly one attempt, no new retry behavior", async () => {
    const invokeLLMFn = vi.fn().mockRejectedValue(new LLMInvokeError(503, "legacy_forge"));
    const deps = makeDeps(invokeLLMFn);

    const result = await parseSlipImage(FAKE_IMAGE_URL, deps);

    expect(invokeLLMFn).toHaveBeenCalledTimes(1);
    expect(deps.sleepFn).not.toHaveBeenCalled();
    expect(result.technicalError).toBe(true);
  });

  it("8. retry logs contain only safe metadata - no API key, endpoint, signed URL, r2p ref, base64 content, or upstream body", async () => {
    const FORBIDDEN_MARKERS = [
      "sk-FAKE_API_KEY_SECRETMARKER",
      "https://llm.example.internal",
      "https://signed-r2-url.example",
      "r2p:payment-slips",
      "data:image/png;base64,AAAAAAAAAAAAAAAAAAAAAAAA",
      "UPSTREAM_BODY_SECRETMARKER",
    ];

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const invokeLLMFn = vi
        .fn()
        .mockRejectedValueOnce(new LLMInvokeError(503, "generic"))
        .mockRejectedValueOnce(new LLMInvokeError(502, "generic"))
        .mockResolvedValueOnce(successResult("OCR text after two retries"));
      const deps = makeDeps(invokeLLMFn);

      await parseSlipImage(FAKE_IMAGE_URL, deps);

      expect(warnSpy).toHaveBeenCalledTimes(2);
      const allLoggedArgs = [...warnSpy.mock.calls, ...errorSpy.mock.calls]
        .flat()
        .map((arg) => (arg instanceof Error ? `${arg.name}: ${arg.message}` : String(arg)))
        .join("\n");

      for (const marker of FORBIDDEN_MARKERS) {
        expect(allLoggedArgs).not.toContain(marker);
      }

      expect(warnSpy.mock.calls[0][0]).toMatch(
        /^\[OCR\] transient generic LLM failure; retrying status=503 attempt=1\/3$/
      );
      expect(warnSpy.mock.calls[1][0]).toMatch(
        /^\[OCR\] transient generic LLM failure; retrying status=502 attempt=2\/3$/
      );
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
