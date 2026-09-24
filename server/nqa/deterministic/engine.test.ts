import { describe, expect, it } from "vitest";

import type {
  NqaChapterExtraction,
  NqaChapterResolution,
} from "../chapter/contracts";
import { normalizeFixtureTextV1, sha256Hex } from "../core";
import { runDeterministicQa } from "./engine";

function extraction(input: {
  side: "source" | "translation";
  text: string;
  paragraphs?: number;
}): NqaChapterExtraction {
  const normalized = normalizeFixtureTextV1(input.text);
  return {
    documentId:
      input.side === "source"
        ? "source-document-12345"
        : "translation-document-12345",
    revisionId: "rev-1",
    tabId: input.side === "source" ? "t.0" : "t.197",
    chapter: 197,
    internalSequence: input.side === "source" ? 198 : null,
    title: input.side === "source" ? "Possessing" : "การสิงร่าง",
    variant: input.side === "source" ? null : "corrected_candidate",
    paragraphCount: input.paragraphs ?? normalized.split("\n").length,
    startIndex: 1,
    endIndex: Array.from(normalized).length + 1,
    text: normalized,
    sha256: sha256Hex(normalized),
  };
}

function resolution(
  status: NqaChapterResolution["status"] = "RESOLVED",
  reasonCodes: NqaChapterResolution["reasonCodes"] = []
): NqaChapterResolution {
  return {
    status,
    source: null,
    translation: null,
    translationVariants: [],
    reasonCodes,
  };
}

const relaxedPolicy = {
  minChapterCharsReview: 1,
  maxChapterCharsReview: 100_000,
  minLengthRatioReview: 0.1,
  maxLengthRatioReview: 10,
  minParagraphRatioReview: 0.1,
  maxParagraphRatioReview: 10,
};
describe("NQA deterministic QA engine", () => {
  it("passes structurally plausible source/translation content", () => {
    const source = extraction({
      side: "source",
      text:
        "บท 198: 197. Possessing\n" +
        "Sabo is unconscious in level 5.5.\n" +
        "Kurama catches the intruder in the mindscape.",
    });
    const translation = extraction({
      side: "translation",
      text:
        "บทที่ 197 การสิงร่าง\n" +
        "ซาโบหมดสติอยู่ในชั้น 5.5\n" +
        "คุรามะจับผู้บุกรุกเอาไว้ในโลกจิตใจ",
    });

    const result = runDeterministicQa({
      resolution: resolution(),
      source,
      translation,
      policy: relaxedPolicy,
    });

    expect(result).toMatchObject({
      decision: "PASS",
      reasonCodes: [],
      resolverStatus: "RESOLVED",
    });
    expect(result.evidence).toHaveLength(2);
  });

  it("does not claim semantic correctness from structurally plausible but unrelated content", () => {
    const sourceBody = "A".repeat(900);
    const unrelatedThai = "ก".repeat(850);

    const result = runDeterministicQa({
      resolution: resolution(),
      source: extraction({
        side: "source",
        text: "บท 198: 197. Possessing\n" + sourceBody,
        paragraphs: 80,
      }),
      translation: extraction({
        side: "translation",
        text: "บทที่ 197 เรื่องคนละเหตุการณ์\n" + unrelatedThai,
        paragraphs: 90,
      }),
    });

    expect(result.decision).toBe("PASS");
    expect(result.reasonCodes).not.toContain("MEANING_DIVERGENCE");
    expect(result.reasonCodes).not.toContain("SOURCE_DRIFT");
  });

  it("fails when the resolver cannot locate the chapter pair", () => {
    const result = runDeterministicQa({
      resolution: resolution("NOT_FOUND", ["TRANSLATION_CHAPTER_MISSING"]),
      source: null,
      translation: null,
    });

    expect(result).toMatchObject({
      decision: "FAIL",
      reasonCodes: ["MISSING_CHAPTER_ID"],
    });
  });

  it("reviews an ambiguous resolver mapping", () => {
    const result = runDeterministicQa({
      resolution: resolution("REVIEW", ["TRANSLATION_CHAPTER_AMBIGUOUS"]),
      source: null,
      translation: null,
    });

    expect(result.decision).toBe("REVIEW");
    expect(result.reasonCodes).toContain("AMBIGUOUS_CHAPTER_MAPPING");
  });
  it("reviews resolved duplicate variants", () => {
    const result = runDeterministicQa({
      resolution: resolution("RESOLVED_WITH_VARIANTS", [
        "DUPLICATE_CHAPTER_ID",
      ]),
      source: extraction({
        side: "source",
        text: "บท 198: 197. Possessing\n" + "A".repeat(500),
      }),
      translation: extraction({
        side: "translation",
        text: "บทที่ 197 การสิงร่าง\n" + "ก".repeat(500),
      }),
    });

    expect(result.decision).toBe("REVIEW");
    expect(result.reasonCodes).toContain("DUPLICATE_CHAPTER_ID");
  });

  it("fails an empty chapter body", () => {
    const result = runDeterministicQa({
      resolution: resolution(),
      source: extraction({
        side: "source",
        text: "บท 198: 197. Possessing\nsource body",
      }),
      translation: extraction({
        side: "translation",
        text: "บทที่ 197 การสิงร่าง",
      }),
      policy: relaxedPolicy,
    });

    expect(result.decision).toBe("FAIL");
    expect(result.reasonCodes).toContain("EMPTY_CHAPTER");
  });

  it("reviews suspiciously short content", () => {
    const result = runDeterministicQa({
      resolution: resolution(),
      source: extraction({
        side: "source",
        text: "บท 198: 197. Possessing\n" + "A".repeat(500),
      }),
      translation: extraction({
        side: "translation",
        text: "บทที่ 197 การสิงร่าง\nสั้น",
      }),
    });

    expect(result.decision).toBe("REVIEW");
    expect(result.reasonCodes).toContain("SUSPICIOUSLY_SHORT_CHAPTER");
  });

  it("reviews configured suspiciously long content", () => {
    const result = runDeterministicQa({
      resolution: resolution(),
      source: extraction({
        side: "source",
        text: "บท 198: 197. Possessing\n" + "A".repeat(500),
      }),
      translation: extraction({
        side: "translation",
        text: "บทที่ 197 การสิงร่าง\n" + "ก".repeat(800),
      }),
      policy: {
        ...relaxedPolicy,
        maxChapterCharsReview: 700,
      },
    });

    expect(result.reasonCodes).toContain("SUSPICIOUSLY_LONG_CHAPTER");
  });
  it("reviews length-ratio and paragraph-ratio outliers", () => {
    const result = runDeterministicQa({
      resolution: resolution(),
      source: extraction({
        side: "source",
        text: "บท 198: 197. Possessing\n" + "A".repeat(1000),
        paragraphs: 100,
      }),
      translation: extraction({
        side: "translation",
        text: "บทที่ 197 การสิงร่าง\n" + "ก".repeat(200),
        paragraphs: 10,
      }),
      policy: {
        ...relaxedPolicy,
        minLengthRatioReview: 0.5,
        minParagraphRatioReview: 0.5,
      },
    });

    expect(result.decision).toBe("REVIEW");
    expect(result.reasonCodes).toContain("LENGTH_RATIO_OUTLIER");
    expect(result.reasonCodes).toContain("PARAGRAPH_RATIO_OUTLIER");
  });

  it("fails an exact source copy used as translation", () => {
    const text =
      "บท 198: 197. Possessing\n" +
      "This paragraph was copied without translation.";

    const result = runDeterministicQa({
      resolution: resolution(),
      source: extraction({ side: "source", text }),
      translation: extraction({ side: "translation", text }),
      policy: relaxedPolicy,
    });

    expect(result.decision).toBe("FAIL");
    expect(result.reasonCodes).toContain("EXACT_DUPLICATE_CHAPTER");
  });

  it("reviews repeated long paragraphs", () => {
    const repeated =
      "ย่อหน้านี้ถูกทำซ้ำโดยไม่ตั้งใจและมีความยาวเพียงพอสำหรับการตรวจ";
    const result = runDeterministicQa({
      resolution: resolution(),
      source: extraction({
        side: "source",
        text: "บท 198: 197. Possessing\n" + "A".repeat(500),
      }),
      translation: extraction({
        side: "translation",
        text:
          "บทที่ 197 การสิงร่าง\n" + [repeated, repeated, repeated].join("\n"),
      }),
      policy: relaxedPolicy,
    });

    expect(result.decision).toBe("REVIEW");
    expect(result.reasonCodes).toContain("REPEATED_PARAGRAPH");
    expect(result.metrics.repeatedParagraphs[0]).toMatchObject({
      occurrences: 3,
    });
  });
  it("reviews Devanagari markers and records bounded code-point evidence", () => {
    const result = runDeterministicQa({
      resolution: resolution(),
      source: extraction({
        side: "source",
        text: "บท 198: 197. Possessing\n" + "A".repeat(500),
      }),
      translation: extraction({
        side: "translation",
        text:
          "บทที่ 197 การสิงร่าง\n" +
          "ข้อความภาษาไทยปกติ แต่มีอักขระ ो และ ह แทรกอยู่",
      }),
      policy: relaxedPolicy,
    });

    expect(result.decision).toBe("REVIEW");
    expect(result.reasonCodes).toContain("FOREIGN_TEXT_POLICY_VIOLATION");
    expect(result.metrics.foreignTextHits.map(hit => hit.codePoint)).toEqual(
      expect.arrayContaining([0x094b, 0x0939])
    );
    expect(
      result.evidence.some(item => item.boundedSummary.includes("U+094B"))
    ).toBe(true);
  });

  it("fails malformed replacement/control content", () => {
    const result = runDeterministicQa({
      resolution: resolution(),
      source: extraction({
        side: "source",
        text: "บท 198: 197. Possessing\n" + "A".repeat(500),
      }),
      translation: extraction({
        side: "translation",
        text: "บทที่ 197 การสิงร่าง\nเนื้อหา\ufffdเสียหาย",
      }),
      policy: relaxedPolicy,
    });

    expect(result.decision).toBe("FAIL");
    expect(result.reasonCodes).toContain("MALFORMED_CONTENT");
  });

  it("can require an ending marker through versioned policy", () => {
    const base = {
      resolution: resolution(),
      source: extraction({
        side: "source" as const,
        text: "บท 198: 197. Possessing\n" + "A".repeat(500),
      }),
      translation: extraction({
        side: "translation" as const,
        text: "บทที่ 197 การสิงร่าง\n" + "ก".repeat(500),
      }),
    };

    const result = runDeterministicQa({
      ...base,
      policy: {
        ...relaxedPolicy,
        requireTranslationEndingMarker: true,
      },
    });

    expect(result.decision).toBe("REVIEW");
    expect(result.reasonCodes).toContain("MISSING_ENDING_MARKER");
  });

  it("keeps ending marker optional by default", () => {
    const result = runDeterministicQa({
      resolution: resolution(),
      source: extraction({
        side: "source",
        text: "บท 198: 197. Possessing\n" + "A".repeat(500),
      }),
      translation: extraction({
        side: "translation",
        text: "บทที่ 197 การสิงร่าง\n" + "ก".repeat(500),
      }),
    });

    expect(result.reasonCodes).not.toContain("MISSING_ENDING_MARKER");
  });
  it("keeps policy evidence bounded and excludes full chapter text", () => {
    const uniqueSecretParagraph =
      "ข้อความเฉพาะสำหรับทดสอบไม่ควรปรากฏเต็มใน evidence " + "ก".repeat(2000);
    const result = runDeterministicQa({
      resolution: resolution(),
      source: extraction({
        side: "source",
        text: "บท 198: 197. Possessing\n" + "A".repeat(500),
      }),
      translation: extraction({
        side: "translation",
        text:
          "บทที่ 197 การสิงร่าง\n" +
          uniqueSecretParagraph +
          "\n" +
          uniqueSecretParagraph +
          "\n" +
          uniqueSecretParagraph,
      }),
      policy: {
        ...relaxedPolicy,
        maxChapterCharsReview: 100_000,
      },
    });

    expect(
      result.evidence.every(item => item.boundedSummary.length <= 1000)
    ).toBe(true);
    expect(JSON.stringify(result.evidence)).not.toContain(
      uniqueSecretParagraph
    );
  });
});
