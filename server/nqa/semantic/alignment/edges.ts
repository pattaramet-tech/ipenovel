import type { NqaEmbeddingProvider } from "../contracts";
import type {
  NqaAlignmentEdge,
  NqaAlignmentPolicy,
  NqaRerankerProvider,
  NqaRerankPair,
  NqaSemanticChunk,
} from "./contracts";
import { buildDenseChunkCandidates } from "./candidates";

export async function buildRerankedAlignmentEdges(input: {
  sourceChunks: NqaSemanticChunk[];
  translationChunks: NqaSemanticChunk[];
  embeddingProvider: NqaEmbeddingProvider;
  rerankerProvider: NqaRerankerProvider;
  policy: NqaAlignmentPolicy;
}): Promise<NqaAlignmentEdge[]> {
  const dense = await buildDenseChunkCandidates({
    sourceChunks: input.sourceChunks,
    translationChunks: input.translationChunks,
    provider: input.embeddingProvider,
    topK: input.policy.denseTopK,
  });

  const bounded = dense
    .sort(
      (left, right) =>
        left.translationChunkIndex - right.translationChunkIndex ||
        right.denseSimilarity - left.denseSimilarity ||
        left.sourceChunkIndex - right.sourceChunkIndex
    )
    .slice(0, Math.max(1, input.policy.maxRerankPairs));

  const pairs: NqaRerankPair[] = bounded.map(candidate => ({
    pairId:
      "t" + candidate.translationChunkIndex + "-s" + candidate.sourceChunkIndex,
    query: input.translationChunks[candidate.translationChunkIndex].text,
    passage: input.sourceChunks[candidate.sourceChunkIndex].text,
  }));

  const reranked = await input.rerankerProvider.rerank(pairs);
  const byId = new Map(reranked.map(score => [score.pairId, score.score]));

  return bounded.map(candidate => {
    const pairId =
      "t" + candidate.translationChunkIndex + "-s" + candidate.sourceChunkIndex;
    const rerankScore = byId.get(pairId);
    if (rerankScore === undefined) {
      throw new Error("Reranker response is missing an alignment pair.");
    }

    return {
      ...candidate,
      rerankScore,
    };
  });
}
