import { describe, expect, it } from "vitest";

import type { NqaAlignmentEdge, NqaSemanticChunk } from "./contracts";
import { selectMonotonicAlignment } from "./monotonic";

function chunks(prefix: string, count: number): NqaSemanticChunk[] {
  return Array.from({ length: count }, (_, index) => ({
    chunkIndex: index,
    paragraphStart: index,
    paragraphEnd: index,
    startIndex: index * 10,
    endIndex: index * 10 + 9,
    charCount: 9,
    sha256: String(index).repeat(64).slice(0, 64),
    text: prefix + index,
  }));
}

describe("NQA M10 monotonic alignment", () => {
  it("selects the best increasing path instead of crossing edges", () => {
    const edges: NqaAlignmentEdge[] = [
      {
        translationChunkIndex: 0,
        sourceChunkIndex: 1,
        denseSimilarity: 0.9,
        rerankScore: 0.9,
      },
      {
        translationChunkIndex: 1,
        sourceChunkIndex: 0,
        denseSimilarity: 0.95,
        rerankScore: 0.95,
      },
      {
        translationChunkIndex: 0,
        sourceChunkIndex: 0,
        denseSimilarity: 0.8,
        rerankScore: 0.8,
      },
      {
        translationChunkIndex: 1,
        sourceChunkIndex: 1,
        denseSimilarity: 0.8,
        rerankScore: 0.8,
      },
    ];

    const result = selectMonotonicAlignment({
      edges,
      sourceChunks: chunks("s", 2),
      translationChunks: chunks("t", 2),
    });

    expect(
      result.map(pair => [pair.translationChunkIndex, pair.sourceChunkIndex])
    ).toEqual([
      [0, 0],
      [1, 1],
    ]);
  });

  it("does not include chunk text in selected result refs", () => {
    const result = selectMonotonicAlignment({
      edges: [
        {
          translationChunkIndex: 0,
          sourceChunkIndex: 0,
          denseSimilarity: 1,
          rerankScore: 1,
        },
      ],
      sourceChunks: chunks("SECRET_SOURCE_", 1),
      translationChunks: chunks("SECRET_TRANSLATION_", 1),
    });

    expect(JSON.stringify(result)).not.toContain("SECRET_SOURCE_");
    expect(JSON.stringify(result)).not.toContain("SECRET_TRANSLATION_");
  });
});
