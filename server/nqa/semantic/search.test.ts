import { describe, expect, it } from "vitest";

import type {
  NqaChapterExtraction,
  NqaDocumentSnapshot,
} from "../chapter/contracts";
import { sha256Hex } from "../core";
import type { NqaEmbeddingProvider } from "./contracts";
import {
  normalizeSemanticChapterText,
  searchGlobalSourceChapters,
} from "./search";

function sourceSnapshot(): NqaDocumentSnapshot {
  return {
    documentId: "source-document-12345",
    title: "English source",
    revisionId: "source-rev",
    tabs: [
      {
        tabId: "t.0",
        title: "Tab 1",
        index: 0,
        parentTabId: null,
        paragraphs: [
          {
            text: "บท 197: 196. Search and Rescue",
            startIndex: 1,
            endIndex: 31,
            tabId: "t.0",
          },
          {
            text: "source-196 rescue scene",
            startIndex: 32,
            endIndex: 60,
            tabId: "t.0",
          },
          {
            text: "บท 198: 197. Possessing",
            startIndex: 61,
            endIndex: 85,
            tabId: "t.0",
          },
          {
            text: "source-197 possession scene",
            startIndex: 86,
            endIndex: 120,
            tabId: "t.0",
          },
          {
            text: "บท 206: 205. Distant Event",
            startIndex: 121,
            endIndex: 150,
            tabId: "t.0",
          },
          {
            text: "source-205 distant event",
            startIndex: 151,
            endIndex: 190,
            tabId: "t.0",
          },
        ],
      },
    ],
  };
}

function translation(body: string): NqaChapterExtraction {
  const text = "บทที่ 197 การสิงร่าง\n" + body;
  return {
    documentId: "translation-document-123",
    revisionId: "translation-rev",
    tabId: "t.197",
    chapter: 197,
    internalSequence: null,
    title: "การสิงร่าง",
    variant: "production_original",
    paragraphCount: 2,
    startIndex: 1,
    endIndex: text.length + 1,
    text,
    sha256: sha256Hex(text),
  };
}
function providerFor(input: {
  query: number[];
  source196?: number[];
  source197?: number[];
  source205?: number[];
}): NqaEmbeddingProvider {
  return {
    providerId: "fixture-embedding",
    modelVersion: "fixture-v1",
    async embed(texts: string[]) {
      return texts.map((text, index) => {
        if (index === 0) return input.query;
        if (text.includes("source-196")) {
          return input.source196 ?? [0, 1, 0];
        }
        if (text.includes("source-197")) {
          return input.source197 ?? [1, 0, 0];
        }
        if (text.includes("source-205")) {
          return input.source205 ?? [0, 0, 1];
        }
        throw new Error("unexpected fixture text");
      });
    },
  };
}

describe("NQA global wrong-source search", () => {
  it("removes heading and known boilerplate before embedding", () => {
    expect(
      normalizeSemanticChapterText(
        "บทที่ 197 การสิงร่าง\nความคิดเห็น\nเนื้อหา\nโหวต\nจบตอน"
      )
    ).toBe("เนื้อหา");
  });

  it("passes when expected chapter ranks first with sufficient lead", async () => {
    const result = await searchGlobalSourceChapters({
      sourceSnapshot: sourceSnapshot(),
      translation: translation("query-expected"),
      expectedChapter: 197,
      provider: providerFor({
        query: [1, 0, 0],
        source197: [0.99, 0.05, 0],
        source196: [0.2, 0.9, 0],
        source205: [0.1, 0, 0.9],
      }),
      rangeStart: 196,
      rangeEnd: 205,
    });

    expect(result).toMatchObject({
      decision: "PASS",
      reasonCodes: [],
      expectedChapter: 197,
      expectedRank: 1,
      bestCandidate: { chapter: 197 },
      providerId: "fixture-embedding",
      modelVersion: "fixture-v1",
    });
    expect(result.expectedLeadOverAlternate).toBeGreaterThan(0.02);
  });

  it("reviews an expected top-1 result when the lead is too small", async () => {
    const result = await searchGlobalSourceChapters({
      sourceSnapshot: sourceSnapshot(),
      translation: translation("query-close"),
      expectedChapter: 197,
      provider: providerFor({
        query: [1, 0, 0],
        source197: [1, 0, 0],
        source196: [0.9999, 0.01, 0],
      }),
      policy: {
        minExpectedLeadPass: 0.02,
      },
    });

    expect(result.decision).toBe("REVIEW");
    expect(result.reasonCodes).toEqual(["LOW_CONFIDENCE"]);
    expect(result.expectedRank).toBe(1);
  });
  it("fails a strong nearby wrong-chapter match without distant drift", async () => {
    const result = await searchGlobalSourceChapters({
      sourceSnapshot: sourceSnapshot(),
      translation: translation("query-nearby-wrong"),
      expectedChapter: 197,
      provider: providerFor({
        query: [1, 0, 0],
        source196: [0.99, 0.02, 0],
        source197: [0.5, 0.86, 0],
        source205: [0, 0, 1],
      }),
      policy: {
        minWrongSourceSimilarityFail: 0.7,
        minWrongSourceMarginFail: 0.08,
      },
    });

    expect(result.decision).toBe("FAIL");
    expect(result.reasonCodes).toContain("WRONG_CHAPTER");
    expect(result.reasonCodes).not.toContain("SOURCE_DRIFT");
    expect(result.bestCandidate?.chapter).toBe(196);
    expect(result.expectedRank).toBeGreaterThan(1);
    expect(result.marginOverExpected).toBeGreaterThan(0.08);
  });

  it("adds SOURCE_DRIFT for a strong distant source match", async () => {
    const result = await searchGlobalSourceChapters({
      sourceSnapshot: sourceSnapshot(),
      translation: translation("query-distant"),
      expectedChapter: 197,
      provider: providerFor({
        query: [0, 0, 1],
        source196: [0.1, 0.9, 0],
        source197: [0.3, 0.2, 0.5],
        source205: [0, 0.05, 0.99],
      }),
      policy: {
        minWrongSourceSimilarityFail: 0.7,
        minWrongSourceMarginFail: 0.08,
        nearbyChapterDistance: 2,
      },
    });

    expect(result.decision).toBe("FAIL");
    expect(result.reasonCodes).toEqual(
      expect.arrayContaining(["WRONG_CHAPTER", "SOURCE_DRIFT"])
    );
    expect(result.bestCandidate?.chapter).toBe(205);
  });

  it("reviews when the expected chapter is outside the candidate range", async () => {
    const result = await searchGlobalSourceChapters({
      sourceSnapshot: sourceSnapshot(),
      translation: translation("query"),
      expectedChapter: 197,
      provider: providerFor({ query: [1, 0, 0] }),
      rangeStart: 205,
      rangeEnd: 205,
    });

    expect(result).toMatchObject({
      decision: "REVIEW",
      reasonCodes: ["INSUFFICIENT_EVIDENCE"],
      expectedRank: null,
      expectedSimilarity: null,
    });
  });
  it("reviews empty semantic evidence without calling the provider", async () => {
    let calls = 0;
    const provider: NqaEmbeddingProvider = {
      providerId: "fixture",
      modelVersion: "v1",
      async embed() {
        calls += 1;
        return [];
      },
    };

    const result = await searchGlobalSourceChapters({
      sourceSnapshot: {
        documentId: "empty-source",
        title: null,
        revisionId: "rev",
        tabs: [],
      },
      translation: translation("query"),
      expectedChapter: 197,
      provider,
    });

    expect(result.decision).toBe("REVIEW");
    expect(result.reasonCodes).toEqual(["INSUFFICIENT_EVIDENCE"]);
    expect(calls).toBe(0);
  });

  it("limits returned candidate evidence while searching the full range", async () => {
    const result = await searchGlobalSourceChapters({
      sourceSnapshot: sourceSnapshot(),
      translation: translation("query"),
      expectedChapter: 197,
      provider: providerFor({
        query: [1, 0, 0],
        source197: [1, 0, 0],
      }),
      policy: {
        maxCandidates: 2,
      },
    });

    expect(result.candidates).toHaveLength(2);
    expect(result.expectedRank).toBe(1);
  });

  it("fails closed when provider vector count is invalid", async () => {
    const provider: NqaEmbeddingProvider = {
      providerId: "broken",
      modelVersion: "broken-v1",
      async embed() {
        return [[1, 0]];
      },
    };

    await expect(
      searchGlobalSourceChapters({
        sourceSnapshot: sourceSnapshot(),
        translation: translation("query"),
        expectedChapter: 197,
        provider,
      })
    ).rejects.toThrow(
      "Embedding provider returned an unexpected vector count."
    );
  });

  it("keeps evidence bounded and excludes full chapter text", async () => {
    const secret = "UNIQUE_SECRET_TRANSLATION_TEXT_" + "ก".repeat(1500);
    const result = await searchGlobalSourceChapters({
      sourceSnapshot: sourceSnapshot(),
      translation: translation(secret),
      expectedChapter: 197,
      provider: providerFor({
        query: [1, 0, 0],
        source197: [1, 0, 0],
      }),
    });

    expect(
      result.evidence.every(item => item.boundedSummary.length <= 1000)
    ).toBe(true);
    expect(JSON.stringify(result.evidence)).not.toContain(secret);
  });
});
