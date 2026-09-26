import { describe, expect, it, vi } from "vitest";

import { LocalHttpEmbeddingProvider, cosineSimilarity } from "./embedding";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("NQA semantic embedding provider", () => {
  it("computes cosine similarity deterministically", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([1, 1], [1, 1])).toBeCloseTo(1);
  });

  it("rejects mismatched or invalid vectors", () => {
    expect(() => cosineSimilarity([], [])).toThrow(
      "Embedding vectors must be non-empty."
    );
    expect(() => cosineSimilarity([1], [1, 2])).toThrow(
      "Embedding vector dimensions must match."
    );
    expect(() => cosineSimilarity([Number.NaN], [1])).toThrow(
      "Embedding vectors must contain finite numbers."
    );
  });

  it("rejects non-loopback embedding endpoints", () => {
    expect(
      () =>
        new LocalHttpEmbeddingProvider("BAAI/bge-m3", {
          endpoint: "https://example.com/embed",
        })
    ).toThrow("NQA sidecar endpoint must use loopback or a private bridge hostname.");
  });

  it("posts bounded text batches to a loopback sidecar", async () => {
    const fetchFn = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        expect(String(url)).toBe("http://127.0.0.1:8765/embed");
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({
          model: "BAAI/bge-m3",
          texts: ["ไทย", "English"],
        });

        return jsonResponse({
          vectors: [
            [1, 0, 0],
            [0, 1, 0],
          ],
        });
      }
    );

    const provider = new LocalHttpEmbeddingProvider("BAAI/bge-m3", {
      endpoint: "http://127.0.0.1:8765/embed",
      fetchFn,
    });

    await expect(provider.embed(["ไทย", "English"])).resolves.toEqual([
      [1, 0, 0],
      [0, 1, 0],
    ]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("fails closed on malformed sidecar vectors", async () => {
    const provider = new LocalHttpEmbeddingProvider("BAAI/bge-m3", {
      endpoint: "http://localhost:8765/embed",
      fetchFn: async () =>
        jsonResponse({
          vectors: [
            [1, 0],
            [1, 0, 0],
          ],
        }),
    });

    await expect(provider.embed(["a", "b"])).rejects.toThrow(
      "Local embedding sidecar returned mixed vector dimensions."
    );
  });

  it("does not leak a sidecar response body on HTTP failure", async () => {
    const provider = new LocalHttpEmbeddingProvider("BAAI/bge-m3", {
      endpoint: "http://localhost:8765/embed",
      fetchFn: async () =>
        new Response("secret local model output", {
          status: 500,
        }),
    });

    await expect(provider.embed(["a"])).rejects.toThrow(
      "Local embedding sidecar request failed with status 500."
    );
  });
});
