import { describe, expect, it } from "vitest";
import {
  EDITORIAL_FOREIGN_CHECKER_ENGINE_VERSION,
  EDITORIAL_FOREIGN_CHECKER_RULES,
  editorialAllowListSha256,
  evaluateEditorialForeignDraft,
  evaluateEditorialForeignParagraph,
  isLikelyKaomoji,
  normalizeEditorialAllowedWord,
  type EditorialCheckerParagraphInput,
} from "./editorialForeignChecker.domain";

function paragraph(
  text: string,
  overrides: Partial<EditorialCheckerParagraphInput> = {}
): EditorialCheckerParagraphInput {
  return {
    sourceTabId: "tab-1",
    tabTitle: "ตอน 1",
    paragraphKey: "p-key-1",
    paragraphOrder: 1,
    paragraphFingerprint: "p-fingerprint-1",
    text,
    ...overrides,
  };
}

describe("Editorial deterministic foreign-word checker", () => {
  it("ports the Production foreign-script ranges and returns full sentence/context with stable offsets", () => {
    const text = "เขาพูดว่า テスト แล้วเดินต่อไป。ประโยคถัดไป";
    const findings = evaluateEditorialForeignParagraph(
      paragraph(text),
      new Set()
    );
    expect(findings).toHaveLength(1);
    const finding = findings[0];
    expect(finding.ruleKey).toBe(EDITORIAL_FOREIGN_CHECKER_RULES.foreignScript);
    expect(finding.token).toBe("テスト");
    expect(text.slice(finding.startOffset, finding.endOffset)).toBe("テスト");
    expect(finding.sentenceText).toBe("เขาพูดว่า テスト แล้วเดินต่อไป。");
    expect(finding.contextText).toBe(text);
    expect(finding.findingKey).toMatch(/^[a-f0-9]{64}$/);
  });

  it("detects a short untranslated ASCII word such as support as a separate deterministic product rule", () => {
    const text = "เขาบอกว่าจะ support เรื่องนี้ให้เต็มที่";
    const findings = evaluateEditorialForeignParagraph(
      paragraph(text),
      new Set()
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      ruleKey: EDITORIAL_FOREIGN_CHECKER_RULES.latinWord,
      token: "support",
      normalizedToken: "support",
      sentenceText: text,
      contextText: text,
    });
  });

  it("normalizes ASCII allow words case-insensitively while keeping non-Latin tokens exact", () => {
    expect(normalizeEditorialAllowedWord("  Support  ")).toBe("support");
    expect(normalizeEditorialAllowedWord(" テスト ")).toBe("テスト");
    const findings = evaluateEditorialForeignParagraph(
      paragraph("SUPPORT テスト"),
      new Set(["support", "テスト"])
    );
    expect(findings).toHaveLength(0);
  });

  it("does not flag URLs, emails, or bare domains as English-word findings", () => {
    const text =
      "ดู https://example.com/test และ mail@example.com หรือ example.org/path";
    expect(
      evaluateEditorialForeignParagraph(paragraph(text), new Set())
    ).toEqual([]);
  });

  it("suppresses individual Latin-word noise inside a long-English span and emits one long-English finding", () => {
    const text =
      "นี่คือ The quick brown fox jumps over the lazy dog while another person keeps writing a sufficiently long untranslated English sentence ต่อด้วยไทย";
    const findings = evaluateEditorialForeignParagraph(
      paragraph(text),
      new Set()
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].ruleKey).toBe(
      EDITORIAL_FOREIGN_CHECKER_RULES.longEnglish
    );
    expect(findings[0].token).toContain("quick brown fox");
    expect(findings[0].sentenceText).toBe(text);
  });

  it("does not treat short English names or skill labels as long-English spans", () => {
    const findings = evaluateEditorialForeignParagraph(
      paragraph("เขาใช้ Fire Ball แล้ววิ่งต่อ"),
      new Set(["fire", "ball"])
    );
    expect(findings).toEqual([]);
  });

  it("preserves the Production kaomoji exemption without hiding nearby real foreign words", () => {
    expect(isLikelyKaomoji("Σ(っ °Д °;)っ")).toBe(true);
    const findings = evaluateEditorialForeignParagraph(
      paragraph(
        "Σ(っ °Д °;)っ แล้วเดินต่อไปอีกไกลมากจนพ้นบริบทใบหน้า แล้วเจอ テスト"
      ),
      new Set()
    );
    expect(findings.map(item => item.token)).toEqual(["テスト"]);
  });

  it("keeps the Production middle-dot exemption when it appears by itself", () => {
    const findings = evaluateEditorialForeignParagraph(
      paragraph("ชื่อ ・ ต่อ"),
      new Set()
    );
    expect(findings).toEqual([]);
  });

  it("creates distinct identities for byte-identical duplicate paragraphs because paragraphKey is part of finding identity", () => {
    const first = evaluateEditorialForeignParagraph(
      paragraph("พบ テスト", { paragraphKey: "paragraph-a" }),
      new Set()
    )[0];
    const second = evaluateEditorialForeignParagraph(
      paragraph("พบ テスト", { paragraphKey: "paragraph-b" }),
      new Set()
    )[0];
    expect(first.findingKey).not.toBe(second.findingKey);
  });

  it("keeps finding identity stable for the same paragraph content and offsets across deterministic rechecks", () => {
    const input = paragraph("เขาบอกว่าจะ support เรื่องนี้");
    const first = evaluateEditorialForeignParagraph(input, new Set())[0];
    const second = evaluateEditorialForeignParagraph(input, new Set())[0];
    expect(second).toEqual(first);
  });

  it("changes finding identity when paragraph content changes even if the token remains at the same offset", () => {
    const first = evaluateEditorialForeignParagraph(
      paragraph("abc support", {
        paragraphFingerprint: "fingerprint-before",
      }),
      new Set(["abc"])
    ).find(item => item.token === "support")!;
    const second = evaluateEditorialForeignParagraph(
      paragraph("abc support", {
        paragraphFingerprint: "fingerprint-after",
      }),
      new Set(["abc"])
    ).find(item => item.token === "support")!;
    expect(first.findingKey).not.toBe(second.findingKey);
  });

  it("orders draft findings deterministically by tab, paragraph, offset and key", () => {
    const result = evaluateEditorialForeignDraft({
      paragraphs: [
        paragraph("ไทย テスト", {
          sourceTabId: "tab-b",
          paragraphKey: "p-b",
          paragraphOrder: 1,
        }),
        paragraph("ไทย support", {
          sourceTabId: "tab-a",
          paragraphKey: "p-a",
          paragraphOrder: 2,
        }),
      ],
    });
    expect(result.engineVersion).toBe(EDITORIAL_FOREIGN_CHECKER_ENGINE_VERSION);
    expect(result.status).toBe("failed");
    expect(result.findings.map(item => item.sourceTabId)).toEqual([
      "tab-a",
      "tab-b",
    ]);
  });

  it("passes clean Thai and hashes allowlists independent of order/duplicates/case", () => {
    const result = evaluateEditorialForeignDraft({
      paragraphs: [paragraph("ข้อความภาษาไทยปกติ")],
      allowWords: ["Support"],
    });
    expect(result.status).toBe("passed");
    expect(result.findings).toEqual([]);
    expect(editorialAllowListSha256(["Support", "เทสต์", "support"])).toBe(
      editorialAllowListSha256(["เทสต์", "SUPPORT"])
    );
  });
});
