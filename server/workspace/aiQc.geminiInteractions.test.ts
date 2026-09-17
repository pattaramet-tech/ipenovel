import { describe, expect, it, vi } from "vitest";
import {
  buildGeminiInteractionsRequestBody,
  createWorkspaceAiQcGeminiInteractionsProvider,
  probeGeminiInteractionsRequestStage,
  validateGeminiInteractionsApiUrl,
  type WorkspaceAiQcGeminiInteractionsConfig,
} from "./aiQc.geminiInteractions";

const config: WorkspaceAiQcGeminiInteractionsConfig = {
  apiUrl: "https://generativelanguage.googleapis.com/v1beta/interactions",
  apiKey: "gemini-test-key",
  model: "gemini-3.8-flash",
  providerName: "gemini",
  timeoutMs: 5000,
  maxInputChars: 10000,
};

const input = {
  requestKey: "a".repeat(64),
  operation: "novel_qc",
  promptVersion: "prompt-v1",
  modelPolicyVersion: "policy-v1",
  snapshotId: 41,
  normalizedSha256: "b".repeat(64),
  content: "ข้อความทดสอบ",
};

function completed(id = "int_receipt_123", findings: unknown[] = []) {
  return {
    id,
    object: "interaction",
    status: "completed",
    model: "gemini-3.8-flash",
    steps: [
      {
        type: "model_output",
        content: [{ type: "text", text: JSON.stringify({ findings }) }],
      },
    ],
  };
}
describe("IPE-054-D1 Gemini Interactions adapter", () => {
  it("accepts only the official Gemini Interactions endpoint", () => {
    expect(validateGeminiInteractionsApiUrl(config.apiUrl)).toBe(config.apiUrl);
    expect(
      validateGeminiInteractionsApiUrl(
        "https://generativelanguage.googleapis.com/v1/interactions"
      )
    ).toBe("https://generativelanguage.googleapis.com/v1/interactions");
    expect(() =>
      validateGeminiInteractionsApiUrl(
        "https://evil.example.test/v1beta/interactions"
      )
    ).toThrow(/official Google/);
    expect(() =>
      validateGeminiInteractionsApiUrl(
        "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
      )
    ).toThrow(/official Google/);
    expect(() =>
      validateGeminiInteractionsApiUrl(
        "https://generativelanguage.googleapis.com/v1beta/interactions?key=secret"
      )
    ).toThrow(/official Google/);
    expect(() =>
      validateGeminiInteractionsApiUrl(
        "https://generativelanguage.googleapis.com:444/v1beta/interactions"
      )
    ).toThrow(/official Google/);
  });

  it("builds deterministic incremental request stages from the official Interactions fields", () => {
    const minimal = buildGeminiInteractionsRequestBody(input, config, "minimal");
    expect(Object.keys(minimal)).toEqual(["model", "input"]);
    expect(minimal).toMatchObject({ model: "gemini-3.8-flash" });
    expect(JSON.parse(String(minimal.input))).toMatchObject({
      contract: "workspace-ai-qc-provider-v1",
      snapshotId: 41,
      content: input.content,
    });

    const withSystem = buildGeminiInteractionsRequestBody(
      input,
      config,
      "system_instruction"
    );
    expect(Object.keys(withSystem)).toEqual([
      "model",
      "input",
      "system_instruction",
    ]);

    const withStructuredOutput = buildGeminiInteractionsRequestBody(
      input,
      config,
      "structured_output"
    );
    expect(Object.keys(withStructuredOutput)).toEqual([
      "model",
      "input",
      "system_instruction",
      "response_format",
    ]);
    expect(withStructuredOutput.response_format).toMatchObject({
      type: "text",
      mime_type: "application/json",
      schema: { type: "object", required: ["findings"] },
    });

    const storedSync = buildGeminiInteractionsRequestBody(
      input,
      config,
      "stored_sync"
    );
    expect(Object.keys(storedSync)).toEqual([
      "model",
      "input",
      "system_instruction",
      "response_format",
      "store",
      "background",
    ]);
    expect(storedSync).toMatchObject({ store: true, background: false });
    expect((storedSync as any).generation_config).toBeUndefined();
  });

  it("probes one request stage with the same sanitized transport path", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(Object.keys(body)).toEqual(["model", "input"]);
      return new Response(
        JSON.stringify({ id: "int_probe_1", status: "completed" }),
        { status: 200 }
      );
    });
    await expect(
      probeGeminiInteractionsRequestStage({
        config,
        request: input,
        stage: "minimal",
        fetchImpl: fetchMock as typeof fetch,
      })
    ).resolves.toEqual({
      stage: "minimal",
      accepted: true,
      interactionStatus: "completed",
      interactionIdPresent: true,
    });

    const rejectingFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          error: {
            code: 400,
            status: "INVALID_ARGUMENT",
            message: `bad request ${config.apiKey} ${input.content}`,
          },
        }),
        { status: 400 }
      )
    );
    let error: unknown;
    try {
      await probeGeminiInteractionsRequestStage({
        config,
        request: input,
        stage: "minimal",
        fetchImpl: rejectingFetch as typeof fetch,
      });
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toContain("HTTP 400");
    expect(String(error)).toContain("[REDACTED]");
    expect(String(error)).not.toContain(config.apiKey);
    expect(String(error)).not.toContain(input.content);
  });

  it("creates a stored synchronous interaction with x-goog-api-key and structured output", async () => {
    const fetchMock = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        expect(String(url)).toBe(config.apiUrl);
        expect(init?.method).toBe("POST");
        const headers = new Headers(init?.headers);
        expect(headers.get("x-goog-api-key")).toBe("gemini-test-key");
        expect(headers.get("authorization")).toBeNull();
        expect(headers.get("idempotency-key")).toBeNull();
        const body = JSON.parse(String(init?.body));
        expect(body.model).toBe("gemini-3.8-flash");
        expect(body.store).toBe(true);
        expect(body.background).toBe(false);
        expect(body.generation_config?.temperature).toBeUndefined();
        expect(body.generation_config?.top_p).toBeUndefined();
        expect(body.generation_config?.top_k).toBeUndefined();
        expect(body.response_format).toMatchObject({
          type: "text",
          mime_type: "application/json",
          schema: { type: "object", required: ["findings"] },
        });
        expect(JSON.stringify(body)).not.toContain("gemini-test-key");
        return new Response(
          JSON.stringify(
            completed("int_execute_1", [
              {
                category: "typo",
                severity: "warning",
                locationKey: "paragraph:3",
                message: "คำที่ควรตรวจสอบ",
                confidence: 0.91,
              },
            ])
          ),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
    );
    const provider = createWorkspaceAiQcGeminiInteractionsProvider(
      config,
      fetchMock as typeof fetch
    );
    const result = (await provider.execute(input)) as any;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      providerRequestId: "int_execute_1",
      providerName: "gemini",
      model: "gemini-3.8-flash",
      findings: [
        {
          category: "typo",
          severity: "warning",
          locationKey: "paragraph:3",
          message: "คำที่ควรตรวจสอบ",
          confidence: 0.91,
          evidenceSha256: input.normalizedSha256,
        },
      ],
    });
  });

  it("retrieves a stored interaction receipt with GET and never sends source content", async () => {
    const fetchMock = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        expect(String(url)).toBe(`${config.apiUrl}/int_receipt_123`);
        expect(init?.method).toBe("GET");
        expect(init?.body).toBeUndefined();
        const headers = new Headers(init?.headers);
        expect(headers.get("x-goog-api-key")).toBe("gemini-test-key");
        expect(headers.get("authorization")).toBeNull();
        return new Response(JSON.stringify(completed()), { status: 200 });
      }
    );
    const provider = createWorkspaceAiQcGeminiInteractionsProvider(
      config,
      fetchMock as typeof fetch
    );
    const result = await provider.reconcile!({
      providerRequestId: "int_receipt_123",
      requestKey: input.requestKey,
      operation: input.operation,
      promptVersion: input.promptVersion,
      modelPolicyVersion: input.modelPolicyVersion,
      snapshotId: input.snapshotId,
      normalizedSha256: input.normalizedSha256,
    });
    expect(result).toMatchObject({
      providerRequestId: "int_receipt_123",
      findings: [],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("treats missing or still-running receipts as unresolved without resending execution", async () => {
    const responses = [
      new Response("missing", { status: 404 }),
      new Response(
        JSON.stringify({ id: "int_receipt_123", status: "in_progress" }),
        { status: 200 }
      ),
    ];
    const fetchMock = vi.fn(async () => responses.shift()!);
    const provider = createWorkspaceAiQcGeminiInteractionsProvider(
      config,
      fetchMock as typeof fetch
    );
    const reconcileInput = {
      providerRequestId: "int_receipt_123",
      requestKey: input.requestKey,
      operation: input.operation,
      promptVersion: input.promptVersion,
      modelPolicyVersion: input.modelPolicyVersion,
      snapshotId: input.snapshotId,
      normalizedSha256: input.normalizedSha256,
    };
    await expect(provider.reconcile!(reconcileInput)).resolves.toBeNull();
    await expect(provider.reconcile!(reconcileInput)).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(call => call[1]?.method === "GET")).toBe(
      true
    );
  });

  it("fails closed when reconciliation returns a different Interaction id", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(completed("int_other")), { status: 200 })
    );
    const provider = createWorkspaceAiQcGeminiInteractionsProvider(
      config,
      fetchMock as typeof fetch
    );
    await expect(
      provider.reconcile!({
        providerRequestId: "int_expected",
        requestKey: input.requestKey,
        operation: input.operation,
        promptVersion: input.promptVersion,
        modelPolicyVersion: input.modelPolicyVersion,
        snapshotId: input.snapshotId,
        normalizedSha256: input.normalizedSha256,
      })
    ).rejects.toMatchObject({ code: "PROVIDER_RESPONSE_INVALID" });
  });

  it("surfaces a bounded sanitized Gemini error summary without leaking secrets or source content", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: 400,
              status: "INVALID_ARGUMENT",
              message: `Unknown field temperature. key=${config.apiKey} source=${input.content}`,
              details: [
                {
                  fieldViolations: [
                    {
                      field: "generation_config.temperature",
                      description: `Unsupported value; secret=${config.apiKey}; source=${input.content}`,
                    },
                  ],
                  privateDebugDump: "secret-upstream-body",
                },
              ],
            },
            privateTopLevel: "never-expose-me",
          }),
          { status: 400, headers: { "content-type": "application/json" } }
        )
    );
    const provider = createWorkspaceAiQcGeminiInteractionsProvider(
      config,
      fetchMock as typeof fetch
    );
    let error: unknown;
    try {
      await provider.execute(input);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "PROVIDER_REQUEST_FAILED" });
    expect(String(error)).toContain("HTTP 400");
    expect(String(error)).toContain("status=INVALID_ARGUMENT");
    expect(String(error)).toContain("generation_config.temperature");
    expect(String(error)).toContain("[REDACTED]");
    expect(String(error)).not.toContain(config.apiKey);
    expect(String(error)).not.toContain(input.content);
    expect(String(error)).not.toContain("secret-upstream-body");
    expect(String(error)).not.toContain("never-expose-me");
    expect(String(error).length).toBeLessThan(2200);
  });

  it("never exposes a non-JSON upstream error body", async () => {
    const fetchMock = vi.fn(
      async () => new Response("secret-upstream-body", { status: 429 })
    );
    const provider = createWorkspaceAiQcGeminiInteractionsProvider(
      config,
      fetchMock as typeof fetch
    );
    await expect(provider.execute(input)).rejects.toMatchObject({
      code: "PROVIDER_REQUEST_FAILED",
      message: "Gemini Interactions request failed with HTTP 429.",
    });
  });
});
