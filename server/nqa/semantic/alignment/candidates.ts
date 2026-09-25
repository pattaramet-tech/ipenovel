import type { NqaEmbeddingProvider } from "../contracts";
import { cosineSimilarity } from "../embedding";
import type { NqaDenseChunkCandidate, NqaSemanticChunk } from "./contracts";

export async function buildDenseChunkCandidates(input: {
  sourceChunks: NqaSemanticChunk[];
  translationChunks: NqaSemanticChunk[];
  provider: NqaEmbeddingProvider;
  topK: number;
}): Promise<NqaDenseChunkCandidate[]> {
  if (input.sourceChunks.length === 0 || input.translationChunks.length === 0) {
    return [];
  }

  const vectors = await input.provider.embed([
    ...input.translationChunks.map(chunk => chunk.text),
    ...input.sourceChunks.map(chunk => chunk.text),
  ]);

  const expectedCount =
    input.translationChunks.length + input.sourceChunks.length;
  if (vectors.length !== expectedCount) {
    throw new Error(
      "Embedding provider returned an unexpected chunk vector count."
    );
  }

  const translationVectors = vectors.slice(0, input.translationChunks.length);
  const sourceVectors = vectors.slice(input.translationChunks.length);

  const topK = Math.max(1, Math.min(input.topK, input.sourceChunks.length));
  const candidates: NqaDenseChunkCandidate[] = [];

  for (
    let translationIndex = 0;
    translationIndex < translationVectors.length;
    translationIndex += 1
  ) {
    const ranked = sourceVectors
      .map((vector, sourceIndex) => ({
        translationChunkIndex: translationIndex,
        sourceChunkIndex: sourceIndex,
        denseSimilarity: cosineSimilarity(
          translationVectors[translationIndex],
          vector
        ),
      }))
      .sort(
        (left, right) =>
          right.denseSimilarity - left.denseSimilarity ||
          left.sourceChunkIndex - right.sourceChunkIndex
      )
      .slice(0, topK);

    candidates.push(...ranked);
  }

  return candidates;
}
