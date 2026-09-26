import { validateNqaSidecarEndpoint } from "./sidecarEndpoint";
import type { NqaEmbeddingProvider, NqaEmbeddingVector } from "./contracts";

export function cosineSimilarity(
  left: NqaEmbeddingVector,
  right: NqaEmbeddingVector
): number {
  if (left.length === 0 || right.length === 0) {
    throw new Error("Embedding vectors must be non-empty.");
  }
  if (left.length !== right.length) {
    throw new Error("Embedding vector dimensions must match.");
  }

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      throw new Error("Embedding vectors must contain finite numbers.");
    }

    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }

  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }

  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

export class LocalHttpEmbeddingProvider implements NqaEmbeddingProvider {
  readonly providerId = "local-http-embedding";

  constructor(
    readonly modelVersion: string,
    private readonly input: {
      endpoint: string;
      fetchFn?: typeof fetch;
      timeoutMs?: number;
      privateBridge?: boolean;
    }
  ) {
    validateNqaSidecarEndpoint({
      endpoint: input.endpoint,
      privateBridge: input.privateBridge,
    });
  }

  async embed(texts: string[]): Promise<NqaEmbeddingVector[]> {
    if (texts.length === 0) return [];

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      Math.max(1, this.input.timeoutMs ?? 60_000)
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
            texts,
          }),
          signal: controller.signal,
        }
      );

      const responseText = await response.text();
      if (!response.ok) {
        throw new Error(
          "Local embedding sidecar request failed with status " +
            response.status +
            "."
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(responseText);
      } catch {
        throw new Error("Local embedding sidecar returned malformed JSON.");
      }

      if (
        !parsed ||
        typeof parsed !== "object" ||
        !Array.isArray((parsed as { vectors?: unknown }).vectors)
      ) {
        throw new Error("Local embedding sidecar response is missing vectors.");
      }

      const vectors = (parsed as { vectors: unknown[] }).vectors.map(vector => {
        if (
          !Array.isArray(vector) ||
          vector.length === 0 ||
          vector.some(
            value => typeof value !== "number" || !Number.isFinite(value)
          )
        ) {
          throw new Error(
            "Local embedding sidecar returned an invalid vector."
          );
        }
        return vector as number[];
      });

      if (vectors.length !== texts.length) {
        throw new Error(
          "Local embedding sidecar vector count does not match input count."
        );
      }

      const dimensions = new Set(vectors.map(vector => vector.length));
      if (dimensions.size !== 1) {
        throw new Error(
          "Local embedding sidecar returned mixed vector dimensions."
        );
      }

      return vectors;
    } finally {
      clearTimeout(timeout);
    }
  }
}
