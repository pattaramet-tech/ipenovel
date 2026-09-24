import { describe, expect, it } from "vitest";

import type { NqaChapterExtraction } from "../../chapter/contracts";
import { sha256Hex } from "../../core";
import { chunkSemanticChapter } from "./chunker";
import { mergeNqaAlignmentPolicy } from "./policy";

function extraction(text: string): NqaChapterExtraction {
  return {
    documentId: "doc-12345",
    revisionId: "rev-1",
    tabId: "t.1",
    chapter: 197,
    internalSequence: null,
    title: "Test",
    variant: "corrected_candidate",
    paragraphCount: text.split("\n").length,
    startIndex: 100,
    endIndex: 100 + text.length,
    text,
    sha256: sha256Hex(text),
  };
}

describe("NQA M10 semantic chunker", () => {
  it("removes heading and known boilerplate from chunks", () => {
    const text =
      "บทที่ 197 Test\nAlpha paragraph\nความคิดเห็น\nBeta paragraph\nโหวต\nจบตอน";
    const chunks = chunkSemanticChapter({
      extraction: extraction(text),
      policy: mergeNqaAlignmentPolicy({
        targetChunkChars: 10,
        maxChunkChars: 30,
      }),
    });

    const joined = chunks.map(chunk => chunk.text).join("\n");
    expect(joined).toContain("Alpha paragraph");
    expect(joined).toContain("Beta paragraph");
    expect(joined).not.toContain("บทที่ 197");
    expect(joined).not.toContain("ความคิดเห็น");
    expect(joined).not.toContain("โหวต");
    expect(joined).not.toContain("จบตอน");
  });

  it("keeps chunks within maxChunkChars", () => {
    const chunks = chunkSemanticChapter({
      extraction: extraction("Heading\n" + "A".repeat(95)),
      policy: mergeNqaAlignmentPolicy({
        targetChunkChars: 20,
        maxChunkChars: 30,
      }),
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(chunk => chunk.charCount <= 30)).toBe(true);
  });

  it("keeps bounded range/hash metadata for every chunk", () => {
    const chunks = chunkSemanticChapter({
      extraction: extraction("Heading\nAlpha alpha\nBeta beta"),
      policy: mergeNqaAlignmentPolicy({
        targetChunkChars: 5,
        maxChunkChars: 20,
      }),
    });

    expect(chunks.length).toBe(2);
    for (const chunk of chunks) {
      expect(chunk.startIndex).toBeGreaterThanOrEqual(100);
      expect(chunk.endIndex).toBeGreaterThan(chunk.startIndex);
      expect(chunk.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });
});
