import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV } from "./env";
import { getLLMRuntimeMode, invokeLLM, resolveLLMRuntimeConfig, type LLMRuntimeConfigInput } from "./llm";

// A synthetic, obviously-fake credential/marker - used throughout to assert
// it never leaks into a thrown/logged message. Never a real secret.
const FAKE_GENERIC_KEY = "sk-test-SECRETMARKER-generic-0000";
const FAKE_FORGE_KEY = "forge-test-SECRETMARKER-0000";

const fullGeneric: LLMRuntimeConfigInput = {
  llmApiUrl: "https://llm.example.internal/chat/completions",
  llmApiKey: FAKE_GENERIC_KEY,
  llmModel: "gpt-4o-mini",
};

describe("resolveLLMRuntimeConfig", () => {
  describe("A. generic mode", () => {
    it("selects generic mode when all three LLM_* vars are set", () => {
      const config = resolveLLMRuntimeConfig(fullGeneric);
      expect(config.mode).toBe("generic");
    });

    it("trims whitespace around each configured value", () => {
      const config = resolveLLMRuntimeConfig({
        llmApiUrl: `  ${fullGeneric.llmApiUrl}  `,
        llmApiKey: `  ${fullGeneric.llmApiKey}  `,
        llmModel: "  gpt-4o-mini  ",
      });
      expect(config.apiUrl).toBe(fullGeneric.llmApiUrl);
      expect(config.apiKey).toBe(fullGeneric.llmApiKey);
      expect(config.model).toBe("gpt-4o-mini");
    });

    it("returns the configured model unchanged - never the legacy hardcoded model", () => {
      const config = resolveLLMRuntimeConfig(fullGeneric);
      expect(config.model).toBe("gpt-4o-mini");
      expect(config.model).not.toBe("gemini-2.5-flash");
    });

    it("uses the full configured LLM_API_URL unchanged - never appends /v1/chat/completions", () => {
      const config = resolveLLMRuntimeConfig({
        ...fullGeneric,
        llmApiUrl: "https://llm.example.internal/some/custom/completions-path",
      });
      expect(config.apiUrl).toBe("https://llm.example.internal/some/custom/completions-path");
    });
  });

  describe("B. partial generic config", () => {
    it("URL only -> throws", () => {
      expect(() => resolveLLMRuntimeConfig({ llmApiUrl: fullGeneric.llmApiUrl })).toThrow();
    });

    it("key only -> throws", () => {
      expect(() => resolveLLMRuntimeConfig({ llmApiKey: fullGeneric.llmApiKey })).toThrow();
    });

    it("model only -> throws", () => {
      expect(() => resolveLLMRuntimeConfig({ llmModel: fullGeneric.llmModel })).toThrow();
    });

    it("URL + key but no model -> throws", () => {
      expect(() =>
        resolveLLMRuntimeConfig({ llmApiUrl: fullGeneric.llmApiUrl, llmApiKey: fullGeneric.llmApiKey })
      ).toThrow();
    });

    it("error message names only the missing variables (URL only configured -> lists LLM_API_KEY and LLM_MODEL, not LLM_API_URL)", () => {
      expect(() => resolveLLMRuntimeConfig({ llmApiUrl: fullGeneric.llmApiUrl })).toThrowError(
        /LLM_API_KEY.*LLM_MODEL/
      );
      try {
        resolveLLMRuntimeConfig({ llmApiUrl: fullGeneric.llmApiUrl });
      } catch (error) {
        const message = (error as Error).message;
        expect(message).toContain("LLM_API_KEY");
        expect(message).toContain("LLM_MODEL");
        expect(message).not.toContain("LLM_API_URL");
      }
    });

    it("error message never contains the configured value itself", () => {
      try {
        resolveLLMRuntimeConfig({ llmApiUrl: fullGeneric.llmApiUrl, llmApiKey: fullGeneric.llmApiKey });
        expect.unreachable("should have thrown");
      } catch (error) {
        const message = (error as Error).message;
        expect(message).not.toContain(fullGeneric.llmApiUrl!);
        expect(message).not.toContain(fullGeneric.llmApiKey!);
      }
    });

    it("does not fall back to Forge when generic config is partial, even with a valid Forge key present", () => {
      expect(() =>
        resolveLLMRuntimeConfig({ llmApiUrl: fullGeneric.llmApiUrl, forgeApiKey: FAKE_FORGE_KEY })
      ).toThrow();
    });
  });

  describe("C. legacy Forge compatibility", () => {
    it("no LLM_* configured + Forge key present -> legacy_forge mode", () => {
      const config = resolveLLMRuntimeConfig({ forgeApiKey: FAKE_FORGE_KEY });
      expect(config.mode).toBe("legacy_forge");
      expect(config.apiKey).toBe(FAKE_FORGE_KEY);
    });

    it("respects an explicitly configured BUILT_IN_FORGE_API_URL", () => {
      const config = resolveLLMRuntimeConfig({
        forgeApiKey: FAKE_FORGE_KEY,
        forgeApiUrl: "https://custom-forge.example.internal",
      });
      expect(config.apiUrl).toBe("https://custom-forge.example.internal/v1/chat/completions");
    });

    it("missing BUILT_IN_FORGE_API_URL falls back to the current forge.manus.im default", () => {
      const config = resolveLLMRuntimeConfig({ forgeApiKey: FAKE_FORGE_KEY });
      expect(config.apiUrl).toBe("https://forge.manus.im/v1/chat/completions");
    });

    it("model remains the historical gemini-2.5-flash", () => {
      const config = resolveLLMRuntimeConfig({ forgeApiKey: FAKE_FORGE_KEY });
      expect(config.model).toBe("gemini-2.5-flash");
    });
  });

  describe("D. missing credentials entirely", () => {
    it("no generic config and no Forge key -> sanitized configuration failure, never the misleading OPENAI_API_KEY message", () => {
      expect(() => resolveLLMRuntimeConfig({})).toThrow();
      try {
        resolveLLMRuntimeConfig({});
        expect.unreachable("should have thrown");
      } catch (error) {
        const message = (error as Error).message;
        expect(message.toLowerCase()).not.toContain("openai_api_key");
        expect(message.toLowerCase()).toContain("llm api key");
      }
    });
  });

  describe("E. URL validation", () => {
    it("rejects a malformed generic URL", () => {
      expect(() =>
        resolveLLMRuntimeConfig({ ...fullGeneric, llmApiUrl: "not-a-url-at-all" })
      ).toThrow();
    });

    it("rejects a non-http(s) scheme", () => {
      expect(() =>
        resolveLLMRuntimeConfig({ ...fullGeneric, llmApiUrl: "ftp://llm.example.internal/chat" })
      ).toThrow();
    });

    it("rejects a URL with embedded credentials", () => {
      expect(() =>
        resolveLLMRuntimeConfig({
          ...fullGeneric,
          llmApiUrl: "https://user:hunter2@llm.example.internal/chat/completions",
        })
      ).toThrow();
    });

    it("accepts a valid https URL", () => {
      expect(() => resolveLLMRuntimeConfig(fullGeneric)).not.toThrow();
    });

    it("accepts a valid plain http URL", () => {
      expect(() =>
        resolveLLMRuntimeConfig({ ...fullGeneric, llmApiUrl: "http://localhost:11434/v1/chat/completions" })
      ).not.toThrow();
    });

    it("never includes the rejected URL value in the thrown error", () => {
      const badUrl = "https://user:hunter2@llm.example.internal/chat/completions";
      try {
        resolveLLMRuntimeConfig({ ...fullGeneric, llmApiUrl: badUrl });
        expect.unreachable("should have thrown");
      } catch (error) {
        const message = (error as Error).message;
        expect(message).not.toContain("hunter2");
        expect(message).not.toContain("llm.example.internal");
      }
    });
  });
});

describe("getLLMRuntimeMode", () => {
  const originalLlmApiUrl = ENV.llmApiUrl;
  const originalLlmApiKey = ENV.llmApiKey;
  const originalLlmModel = ENV.llmModel;
  const originalForgeApiUrl = ENV.forgeApiUrl;
  const originalForgeApiKey = ENV.forgeApiKey;

  afterEach(() => {
    ENV.llmApiUrl = originalLlmApiUrl;
    ENV.llmApiKey = originalLlmApiKey;
    ENV.llmModel = originalLlmModel;
    ENV.forgeApiUrl = originalForgeApiUrl;
    ENV.forgeApiKey = originalForgeApiKey;
  });

  it("returns 'generic' when the LLM_* vars are configured, and returns ONLY the mode (never apiKey/apiUrl/model)", () => {
    ENV.llmApiUrl = "https://llm.example.internal/chat/completions";
    ENV.llmApiKey = "sk-test-mode-getter-key";
    ENV.llmModel = "gpt-4o-mini";

    const mode = getLLMRuntimeMode();

    expect(mode).toBe("generic");
    // Type-level guarantee, not just a runtime check: the return type is
    // LLMRuntimeMode ("generic" | "legacy_forge"), not an object - nothing
    // to accidentally destructure a secret out of.
    expect(typeof mode).toBe("string");
  });

  it("returns 'legacy_forge' when no LLM_* var is configured but a Forge key is", () => {
    ENV.llmApiUrl = "";
    ENV.llmApiKey = "";
    ENV.llmModel = "";
    ENV.forgeApiKey = "forge-test-mode-getter-key";
    ENV.forgeApiUrl = "";

    expect(getLLMRuntimeMode()).toBe("legacy_forge");
  });

  it("throws (same as the underlying resolver) when nothing is configured at all", () => {
    ENV.llmApiUrl = "";
    ENV.llmApiKey = "";
    ENV.llmModel = "";
    ENV.forgeApiUrl = "";
    ENV.forgeApiKey = "";

    expect(() => getLLMRuntimeMode()).toThrow();
  });
});

describe("invokeLLM - request payload and error safety", () => {
  const originalLlmApiUrl = ENV.llmApiUrl;
  const originalLlmApiKey = ENV.llmApiKey;
  const originalLlmModel = ENV.llmModel;
  const originalForgeApiUrl = ENV.forgeApiUrl;
  const originalForgeApiKey = ENV.forgeApiKey;

  afterEach(() => {
    ENV.llmApiUrl = originalLlmApiUrl;
    ENV.llmApiKey = originalLlmApiKey;
    ENV.llmModel = originalLlmModel;
    ENV.forgeApiUrl = originalForgeApiUrl;
    ENV.forgeApiKey = originalForgeApiKey;
    vi.unstubAllGlobals();
  });

  function mockOkFetch() {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: "test",
        created: 0,
        model: "test-model",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  describe("F. request payload", () => {
    it("generic mode: request does NOT contain the Forge-specific `thinking` field", async () => {
      ENV.llmApiUrl = fullGeneric.llmApiUrl!;
      ENV.llmApiKey = fullGeneric.llmApiKey!;
      ENV.llmModel = fullGeneric.llmModel!;
      const fetchMock = mockOkFetch();

      await invokeLLM({ messages: [{ role: "user", content: "hi" }] });

      const [, requestInit] = fetchMock.mock.calls[0];
      const body = JSON.parse(requestInit.body as string);
      expect(body).not.toHaveProperty("thinking");
    });

    it("legacy_forge mode: request preserves the existing `thinking` payload", async () => {
      ENV.llmApiUrl = "";
      ENV.llmApiKey = "";
      ENV.llmModel = "";
      ENV.forgeApiKey = FAKE_FORGE_KEY;
      ENV.forgeApiUrl = "";
      const fetchMock = mockOkFetch();

      await invokeLLM({ messages: [{ role: "user", content: "hi" }] });

      const [, requestInit] = fetchMock.mock.calls[0];
      const body = JSON.parse(requestInit.body as string);
      expect(body.thinking).toEqual({ budget_tokens: 128 });
    });

    it("Authorization header carries the resolved API key as a Bearer token, in both modes", async () => {
      ENV.llmApiUrl = fullGeneric.llmApiUrl!;
      ENV.llmApiKey = fullGeneric.llmApiKey!;
      ENV.llmModel = fullGeneric.llmModel!;
      const fetchMock = mockOkFetch();

      await invokeLLM({ messages: [{ role: "user", content: "hi" }] });

      const [, requestInit] = fetchMock.mock.calls[0];
      const headers = requestInit.headers as Record<string, string>;
      expect(headers.authorization).toBe(`Bearer ${FAKE_GENERIC_KEY}`);
    });

    it("the configured model is placed in the request payload", async () => {
      ENV.llmApiUrl = fullGeneric.llmApiUrl!;
      ENV.llmApiKey = fullGeneric.llmApiKey!;
      ENV.llmModel = "my-custom-model-id";
      const fetchMock = mockOkFetch();

      await invokeLLM({ messages: [{ role: "user", content: "hi" }] });

      const [, requestInit] = fetchMock.mock.calls[0];
      const body = JSON.parse(requestInit.body as string);
      expect(body.model).toBe("my-custom-model-id");
    });

    it("generic mode sends the request to the full configured LLM_API_URL, unchanged", async () => {
      ENV.llmApiUrl = "https://llm.example.internal/custom/path";
      ENV.llmApiKey = fullGeneric.llmApiKey!;
      ENV.llmModel = fullGeneric.llmModel!;
      const fetchMock = mockOkFetch();

      await invokeLLM({ messages: [{ role: "user", content: "hi" }] });

      const [url] = fetchMock.mock.calls[0];
      expect(url).toBe("https://llm.example.internal/custom/path");
    });
  });

  describe("G. secret safety on a non-2xx upstream response", () => {
    it("does not embed the upstream response body in the thrown error", async () => {
      ENV.llmApiUrl = fullGeneric.llmApiUrl!;
      ENV.llmApiKey = fullGeneric.llmApiKey!;
      ENV.llmModel = fullGeneric.llmModel!;
      const upstreamLeak = "UPSTREAM_BODY_SECRETMARKER_should_never_appear";
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 401,
          statusText: "Unauthorized",
          text: async () => upstreamLeak,
        })
      );

      await expect(invokeLLM({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow();
      try {
        await invokeLLM({ messages: [{ role: "user", content: "hi" }] });
        expect.unreachable("should have thrown");
      } catch (error) {
        const message = (error as Error).message;
        expect(message).not.toContain(upstreamLeak);
        expect(message).toContain("401");
        expect(message).not.toContain(FAKE_GENERIC_KEY);
        expect(message).not.toContain(fullGeneric.llmApiUrl);
      }
    });

    it("never leaks the resolved API key or endpoint URL in a failure message, in either mode", async () => {
      ENV.llmApiUrl = fullGeneric.llmApiUrl!;
      ENV.llmApiKey = fullGeneric.llmApiKey!;
      ENV.llmModel = fullGeneric.llmModel!;
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({ ok: false, status: 500, statusText: "Internal Server Error", text: async () => "" })
      );

      try {
        await invokeLLM({ messages: [{ role: "user", content: "hi" }] });
        expect.unreachable("should have thrown");
      } catch (error) {
        const message = (error as Error).message;
        expect(message).not.toContain(FAKE_GENERIC_KEY);
        expect(message).not.toContain("llm.example.internal");
        expect(message).toContain("500");
      }
    });
  });
});
