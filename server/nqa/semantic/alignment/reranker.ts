import type {
  NqaRerankerProvider,
  NqaRerankPair,
  NqaRerankScore,
} from "./contracts";

export class LocalHttpRerankerProvider implements NqaRerankerProvider {
  readonly providerId = "local-http-reranker";

  constructor(
    readonly modelVersion: string,
    private readonly input: {
      endpoint: string;
      fetchFn?: typeof fetch;
      timeoutMs?: number;
    }
  ) {
    const parsed = new URL(input.endpoint);
    const allowedHosts = new Set(["127.0.0.1", "localhost", "::1"]);

    if (!allowedHosts.has(parsed.hostname)) {
      throw new Error("Local reranker endpoint must use a loopback hostname.");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("Local reranker endpoint must use HTTP or HTTPS.");
    }
  }

  async rerank(pairs: NqaRerankPair[]): Promise<NqaRerankScore[]> {
    if (pairs.length === 0) return [];

    const ids = new Set(pairs.map(pair => pair.pairId));
    if (ids.size !== pairs.length) {
      throw new Error("Reranker pair IDs must be unique.");
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      Math.max(1, this.input.timeoutMs ?? 120_000)
    );

    try {
      const response = await (this.input.fetchFn ?? fetch)(
        this.input.endpoint,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            model: this.modelVersion,
            pairs,
          }),
          signal: controller.signal,
        }
      );

      const responseText = await response.text();
      if (!response.ok) {
        throw new Error(
          "Local reranker request failed with status " + response.status + "."
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(responseText);
      } catch {
        throw new Error("Local reranker returned malformed JSON.");
      }

      const scores = (parsed as { scores?: unknown })?.scores;
      if (!Array.isArray(scores)) {
        throw new Error("Local reranker response is missing scores.");
      }
      if (scores.length !== pairs.length) {
        throw new Error(
          "Local reranker score count does not match pair count."
        );
      }

      return scores.map((entry, index) => {
        if (
          !entry ||
          typeof entry !== "object" ||
          typeof (entry as { pairId?: unknown }).pairId !== "string" ||
          typeof (entry as { score?: unknown }).score !== "number" ||
          !Number.isFinite((entry as { score: number }).score)
        ) {
          throw new Error("Local reranker returned an invalid score.");
        }

        const score = (entry as { score: number }).score;
        if (score < 0 || score > 1) {
          throw new Error("Local reranker score must be normalized to [0,1].");
        }

        const expectedPair = pairs[index];
        const pairId = (entry as { pairId: string }).pairId;
        if (pairId !== expectedPair.pairId) {
          throw new Error("Local reranker response order/identity mismatch.");
        }

        return { pairId, score };
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}
