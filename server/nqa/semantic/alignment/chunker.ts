import type { NqaChapterExtraction } from "../../chapter/contracts";
import { normalizeFixtureTextV1, sha256Hex } from "../../core";
import type { NqaAlignmentPolicy, NqaSemanticChunk } from "./contracts";

type ParagraphUnit = {
  paragraphIndex: number;
  startOffset: number;
  endOffset: number;
  text: string;
};

const BOILERPLATE = new Set(["ความคิดเห็น", "โหวต", "จบตอน"]);

function paragraphUnits(
  extraction: NqaChapterExtraction,
  maxChunkChars: number
): ParagraphUnit[] {
  const raw = extraction.text.replace(/\r\n?/g, "\n");
  const lines = raw.split("\n");
  const units: ParagraphUnit[] = [];
  let offset = 0;
  let firstContentLineSkipped = false;
  let paragraphIndex = 0;

  for (const line of lines) {
    const lineStart = offset;
    const lineEnd = lineStart + line.length;
    offset = lineEnd + 1;

    const trimmed = line.trim();
    if (!trimmed) continue;

    if (!firstContentLineSkipped) {
      firstContentLineSkipped = true;
      continue;
    }

    if (BOILERPLATE.has(trimmed.toLocaleLowerCase("th"))) {
      continue;
    }

    const normalized = normalizeFixtureTextV1(trimmed);
    if (!normalized) continue;

    if (normalized.length <= maxChunkChars) {
      units.push({
        paragraphIndex,
        startOffset: lineStart,
        endOffset: lineEnd,
        text: normalized,
      });
      paragraphIndex += 1;
      continue;
    }

    let localStart = 0;
    while (localStart < normalized.length) {
      const slice = normalized.slice(localStart, localStart + maxChunkChars);
      units.push({
        paragraphIndex,
        startOffset: lineStart + localStart,
        endOffset: lineStart + localStart + slice.length,
        text: slice,
      });
      paragraphIndex += 1;
      localStart += slice.length;
    }
  }

  return units;
}

export function chunkSemanticChapter(input: {
  extraction: NqaChapterExtraction;
  policy: NqaAlignmentPolicy;
}): NqaSemanticChunk[] {
  const units = paragraphUnits(input.extraction, input.policy.maxChunkChars);

  const chunks: NqaSemanticChunk[] = [];
  let current: ParagraphUnit[] = [];
  let currentChars = 0;

  const flush = () => {
    if (current.length === 0) return;

    const text = current.map(unit => unit.text).join("\n");
    const first = current[0];
    const last = current[current.length - 1];

    chunks.push({
      chunkIndex: chunks.length,
      paragraphStart: first.paragraphIndex,
      paragraphEnd: last.paragraphIndex,
      startIndex: input.extraction.startIndex + first.startOffset,
      endIndex: input.extraction.startIndex + last.endOffset,
      charCount: text.length,
      sha256: sha256Hex(text),
      text,
    });

    current = [];
    currentChars = 0;
  };

  for (const unit of units) {
    const separator = current.length === 0 ? 0 : 1;
    const projected = currentChars + separator + unit.text.length;

    if (
      current.length > 0 &&
      (projected > input.policy.maxChunkChars ||
        (currentChars >= input.policy.targetChunkChars &&
          projected > input.policy.targetChunkChars))
    ) {
      flush();
    }

    current.push(unit);
    currentChars += (current.length === 1 ? 0 : 1) + unit.text.length;
  }

  flush();
  return chunks;
}
