import type { NqaChapterExtraction } from "../../chapter/contracts";
import { chunkSemanticChapter } from "../alignment/chunker";
import type {
  NqaAlignmentPolicy,
  NqaAlignmentResult,
} from "../alignment/contracts";
import { mergeNqaAlignmentPolicy } from "../alignment/policy";
import type { NqaStructureEvidenceItem, NqaStructurePolicy } from "./contracts";
import { mergeNqaStructurePolicy } from "./policy";

function boundedText(text: string, maxChars: number): string {
  const trimmed = text.trim();
  return trimmed.length <= maxChars
    ? trimmed
    : trimmed.slice(0, maxChars).trimEnd();
}

export function buildStructureEvidenceItems(input: {
  alignment: NqaAlignmentResult;
  source: NqaChapterExtraction;
  translation: NqaChapterExtraction;
  policy?: Partial<NqaStructurePolicy>;
  alignmentPolicy?: Partial<NqaAlignmentPolicy>;
}): NqaStructureEvidenceItem[] {
  const policy = mergeNqaStructurePolicy(input.policy);
  const alignmentPolicy = mergeNqaAlignmentPolicy(input.alignmentPolicy);
  const sourceChunks = chunkSemanticChapter({
    extraction: input.source,
    policy: alignmentPolicy,
  });
  const translationChunks = chunkSemanticChapter({
    extraction: input.translation,
    policy: alignmentPolicy,
  });

  const items: NqaStructureEvidenceItem[] = [];
  const pairs = [...input.alignment.alignedPairs]
    .sort(
      (left, right) =>
        left.rerankScore - right.rerankScore ||
        left.translationChunkIndex - right.translationChunkIndex
    )
    .slice(0, Math.max(0, policy.lowScoreItemLimit));

  for (const pair of pairs) {
    const sourceChunk = sourceChunks[pair.sourceChunkIndex];
    const translationChunk = translationChunks[pair.translationChunkIndex];
    if (!sourceChunk || !translationChunk) continue;

    items.push({
      evidenceId:
        "structured-pair-" +
        pair.translationChunkIndex +
        "-" +
        pair.sourceChunkIndex,
      kind: "ALIGNED_PAIR",
      sourceHash: sourceChunk.sha256,
      translationHash: translationChunk.sha256,
      sourceStartIndex: sourceChunk.startIndex,
      sourceEndIndex: sourceChunk.endIndex,
      translationStartIndex: translationChunk.startIndex,
      translationEndIndex: translationChunk.endIndex,
      rerankScore: pair.rerankScore,
      sourceText: boundedText(sourceChunk.text, policy.maxCharsPerSide),
      translationText: boundedText(
        translationChunk.text,
        policy.maxCharsPerSide
      ),
    });
  }

  const gaps = input.alignment.gaps.slice(0, Math.max(0, policy.gapItemLimit));
  for (const gap of gaps) {
    if (gap.side === "SOURCE") {
      const chunk = sourceChunks[gap.chunkIndex];
      if (!chunk) continue;
      items.push({
        evidenceId: "structured-source-gap-" + gap.chunkIndex,
        kind: "SOURCE_GAP",
        sourceHash: chunk.sha256,
        translationHash: null,
        sourceStartIndex: chunk.startIndex,
        sourceEndIndex: chunk.endIndex,
        translationStartIndex: null,
        translationEndIndex: null,
        rerankScore: null,
        sourceText: boundedText(chunk.text, policy.maxCharsPerSide),
        translationText: null,
      });
    } else {
      const chunk = translationChunks[gap.chunkIndex];
      if (!chunk) continue;
      items.push({
        evidenceId: "structured-translation-gap-" + gap.chunkIndex,
        kind: "TRANSLATION_GAP",
        sourceHash: null,
        translationHash: chunk.sha256,
        sourceStartIndex: null,
        sourceEndIndex: null,
        translationStartIndex: chunk.startIndex,
        translationEndIndex: chunk.endIndex,
        rerankScore: null,
        sourceText: null,
        translationText: boundedText(chunk.text, policy.maxCharsPerSide),
      });
    }
  }

  return items.slice(0, Math.max(0, policy.maxItems));
}
