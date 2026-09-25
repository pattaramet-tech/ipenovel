import type {
  NqaAlignedPair,
  NqaAlignmentEdge,
  NqaSemanticChunk,
} from "./contracts";

function ref(chunk: NqaSemanticChunk) {
  const { text: _text, ...rest } = chunk;
  return rest;
}

export function selectMonotonicAlignment(input: {
  edges: NqaAlignmentEdge[];
  sourceChunks: NqaSemanticChunk[];
  translationChunks: NqaSemanticChunk[];
}): NqaAlignedPair[] {
  const edges = [...input.edges].sort(
    (left, right) =>
      left.translationChunkIndex - right.translationChunkIndex ||
      left.sourceChunkIndex - right.sourceChunkIndex ||
      right.rerankScore - left.rerankScore
  );

  if (edges.length === 0) return [];

  const best = new Array<number>(edges.length).fill(0);
  const previous = new Array<number>(edges.length).fill(-1);

  for (let index = 0; index < edges.length; index += 1) {
    best[index] = edges[index].rerankScore;

    for (let candidate = 0; candidate < index; candidate += 1) {
      if (
        edges[candidate].translationChunkIndex >=
          edges[index].translationChunkIndex ||
        edges[candidate].sourceChunkIndex >= edges[index].sourceChunkIndex
      ) {
        continue;
      }

      const score = best[candidate] + edges[index].rerankScore;
      if (score > best[index]) {
        best[index] = score;
        previous[index] = candidate;
      }
    }
  }

  let cursor = 0;
  for (let index = 1; index < best.length; index += 1) {
    if (best[index] > best[cursor]) cursor = index;
  }

  const selected: NqaAlignmentEdge[] = [];
  while (cursor >= 0) {
    selected.push(edges[cursor]);
    cursor = previous[cursor];
  }
  selected.reverse();

  return selected.map(edge => ({
    ...edge,
    sourceChunk: ref(input.sourceChunks[edge.sourceChunkIndex]),
    translationChunk: ref(input.translationChunks[edge.translationChunkIndex]),
  }));
}
