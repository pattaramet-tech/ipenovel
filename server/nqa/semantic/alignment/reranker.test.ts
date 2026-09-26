import { describe, expect, it, vi } from "vitest";

import { LocalHttpRerankerProvider } from "./reranker";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("NQA M10 local reranker provider", () => {
  it("rejects non-loopback endpoints", () => {
    expect(
      () =>
        new LocalHttpRerankerProvider("BAAI/bge-reranker-v2-m3", {
          endpoint: "https://example.com/rerank",
        })
    ).toThrow("NQA sidecar endpoint must use loopback or a private bridge hostname.");
  });

  it("posts ordered query/passage pairs and returns normalized scores", async () => {
    const fetchFn = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        expect(body).toEqual({
          model: "BAAI/bge-reranker-v2-m3",
          pairs: [
            {
              pairId: "p1",
              query: "ไทย",
              passage: "English",
            },
          ],
        });
        return jsonResponse({
          scores: [{ pairId: "p1", score: 0.91 }],
        });
      }
    );

    const provider = new LocalHttpRerankerProvider("BAAI/bge-reranker-v2-m3", {
      endpoint: "http://127.0.0.1:8766/rerank",
      fetchFn,
    });

    await expect(
      provider.rerank([
        {
          pairId: "p1",
          query: "ไทย",
          passage: "English",
        },
      ])
    ).resolves.toEqual([{ pairId: "p1", score: 0.91 }]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("fails closed on out-of-range scores", async () => {
    const provider = new LocalHttpRerankerProvider("BAAI/bge-reranker-v2-m3", {
      endpoint: "http://localhost:8766/rerank",
      fetchFn: async () =>
        jsonResponse({
          scores: [{ pairId: "p1", score: 1.5 }],
        }),
    });

    await expect(
      provider.rerank([{ pairId: "p1", query: "a", passage: "b" }])
    ).rejects.toThrow("Local reranker score must be normalized to [0,1].");
  });

  it("does not leak response bodies on HTTP errors", async () => {
    const provider = new LocalHttpRerankerProvider("BAAI/bge-reranker-v2-m3", {
      endpoint: "http://localhost:8766/rerank",
      fetchFn: async () =>
        new Response("secret model output", {
          status: 500,
        }),
    });

    await expect(
      provider.rerank([{ pairId: "p1", query: "a", passage: "b" }])
    ).rejects.toThrow("Local reranker request failed with status 500.");
  });
});
