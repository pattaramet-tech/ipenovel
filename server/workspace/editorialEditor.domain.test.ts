import { describe, expect, it } from "vitest";
import {
  editorialDraftSha256,
  paragraphFingerprint,
  reindexEditorialDraftDocument,
  type EditorialDraftDocument,
} from "./editorialDraft.domain";
import {
  applyEditorialDraftEdit,
  editorialEditIdempotencyPayloadSha256,
} from "./editorialEditor.domain";

function document(
  text = "เขาบอกว่าจะ support เรื่องนี้ให้เต็มที่"
): EditorialDraftDocument {
  return reindexEditorialDraftDocument({
    warnings: [],
    tabs: [
      {
        sourceTabId: "tab-1",
        tabOrder: 0,
        title: "ตอน 1",
        paragraphs: [
          {
            paragraphKey: "p-key-1",
            sourceParagraphIndex: 1,
            paragraphOrder: 1,
            text,
            sourceParagraphFingerprint: paragraphFingerprint(text),
            sourceOccurrenceCount: 1,
            sourceOccurrenceOrdinal: 1,
            paragraphFingerprint: paragraphFingerprint(text),
            occurrenceCount: 1,
            occurrenceOrdinal: 1,
          },
        ],
        fingerprintSequence: [],
        structuralSha256: "",
        chapterNumber: null,
        chapterTitle: null,
        warnings: [],
      },
    ],
  });
}

describe("Workspace Editorial editor domain", () => {
  it("replaces the reviewed sentence/range and creates a different Draft hash", () => {
    const input = document();
    const start = input.tabs[0].paragraphs[0].text.indexOf("support");
    const result = applyEditorialDraftEdit(input, {
      kind: "replace_range",
      paragraphKey: "p-key-1",
      expectedParagraphFingerprint:
        input.tabs[0].paragraphs[0].paragraphFingerprint,
      startOffset: start,
      endOffset: start + "support".length,
      expectedText: "support",
      replacementText: "ช่วยเหลือ",
    });
    expect(result.document.tabs[0].paragraphs[0].text).toBe(
      "เขาบอกว่าจะ ช่วยเหลือ เรื่องนี้ให้เต็มที่"
    );
    expect(result.beforeSha256).toBe(editorialDraftSha256(input));
    expect(result.afterSha256).not.toBe(result.beforeSha256);
    expect(result.details.kind).toBe("replace_range");
  });

  it("uses JavaScript UTF-16 offsets so emoji before a finding cannot shift the guarded range", () => {
    const input = document("😀 เขาจะ support วันนี้");
    const text = input.tabs[0].paragraphs[0].text;
    const start = text.indexOf("support");
    expect(start).toBe(9);
    const result = applyEditorialDraftEdit(input, {
      kind: "replace_sentence",
      paragraphKey: "p-key-1",
      expectedParagraphFingerprint:
        input.tabs[0].paragraphs[0].paragraphFingerprint,
      startOffset: start,
      endOffset: start + 7,
      expectedText: "support",
      replacementText: "ช่วย",
    });
    expect(result.document.tabs[0].paragraphs[0].text).toBe(
      "😀 เขาจะ ช่วย วันนี้"
    );
  });

  it("fails closed when expected range text is stale", () => {
    const input = document();
    const start = input.tabs[0].paragraphs[0].text.indexOf("support");
    expect(() =>
      applyEditorialDraftEdit(input, {
        kind: "replace_range",
        paragraphKey: "p-key-1",
        expectedParagraphFingerprint:
          input.tabs[0].paragraphs[0].paragraphFingerprint,
        startOffset: start,
        endOffset: start + 7,
        expectedText: "Support",
        replacementText: "ช่วย",
      })
    ).toThrow("Expected sentence/range text no longer matches");
  });

  it("requires exact whole-paragraph expected text for explicit paragraph replacement", () => {
    const input = document("ย่อหน้าเดิม");
    expect(() =>
      applyEditorialDraftEdit(input, {
        kind: "replace_paragraph",
        paragraphKey: "p-key-1",
        expectedParagraphFingerprint:
          input.tabs[0].paragraphs[0].paragraphFingerprint,
        expectedText: "ข้อความอื่น",
        replacementText: "ย่อหน้าใหม่",
      })
    ).toThrow("Whole-paragraph expected text no longer matches");

    const result = applyEditorialDraftEdit(input, {
      kind: "replace_paragraph",
      paragraphKey: "p-key-1",
      expectedParagraphFingerprint:
        input.tabs[0].paragraphs[0].paragraphFingerprint,
      expectedText: "ย่อหน้าเดิม",
      replacementText: "ย่อหน้าใหม่",
    });
    expect(result.document.tabs[0].paragraphs[0].text).toBe("ย่อหน้าใหม่");
  });

  it("rejects ambiguous paragraph identities rather than guessing", () => {
    const input = document("ข้อความ");
    input.tabs.push({
      ...JSON.parse(JSON.stringify(input.tabs[0])),
      sourceTabId: "tab-2",
      tabOrder: 1,
    });
    expect(() =>
      applyEditorialDraftEdit(input, {
        kind: "replace_paragraph",
        paragraphKey: "p-key-1",
        expectedParagraphFingerprint:
          input.tabs[0].paragraphs[0].paragraphFingerprint,
        expectedText: "ข้อความ",
        replacementText: "ใหม่",
      })
    ).toThrow("ambiguous");
  });

  it("rejects line breaks because one mutation cannot silently create new paragraph identities", () => {
    const input = document("ข้อความ");
    expect(() =>
      applyEditorialDraftEdit(input, {
        kind: "replace_paragraph",
        paragraphKey: "p-key-1",
        expectedParagraphFingerprint:
          input.tabs[0].paragraphs[0].paragraphFingerprint,
        expectedText: "ข้อความ",
        replacementText: "บรรทัดหนึ่ง\nบรรทัดสอง",
      })
    ).toThrow("cannot introduce a line break");
  });

  it("reindexes duplicate fingerprints while preserving paragraph keys", () => {
    const input = document("หนึ่ง");
    input.tabs[0].paragraphs.push({
      ...input.tabs[0].paragraphs[0],
      paragraphKey: "p-key-2",
      sourceParagraphIndex: 2,
      paragraphOrder: 2,
      text: "สอง",
      sourceParagraphFingerprint: paragraphFingerprint("สอง"),
      paragraphFingerprint: paragraphFingerprint("สอง"),
    });
    const normalized = reindexEditorialDraftDocument(input);
    const second = normalized.tabs[0].paragraphs[1];
    const result = applyEditorialDraftEdit(normalized, {
      kind: "replace_paragraph",
      paragraphKey: "p-key-2",
      expectedParagraphFingerprint: second.paragraphFingerprint,
      expectedText: "สอง",
      replacementText: "หนึ่ง",
    });
    expect(result.document.tabs[0].paragraphs.map(p => p.paragraphKey)).toEqual(
      ["p-key-1", "p-key-2"]
    );
    expect(
      result.document.tabs[0].paragraphs.map(p => p.occurrenceCount)
    ).toEqual([2, 2]);
    expect(
      result.document.tabs[0].paragraphs.map(p => p.occurrenceOrdinal)
    ).toEqual([1, 2]);
  });

  it("hashes the idempotency payload deterministically and changes it for different replacement text", () => {
    const input = document();
    const command = {
      kind: "replace_paragraph" as const,
      paragraphKey: "p-key-1",
      expectedParagraphFingerprint:
        input.tabs[0].paragraphs[0].paragraphFingerprint,
      expectedText: input.tabs[0].paragraphs[0].text,
      replacementText: "ข้อความใหม่",
    };
    const a = editorialEditIdempotencyPayloadSha256({
      expectedDraftId: 9,
      expectedDraftVersion: 3,
      expectedDraftSha256: "a".repeat(64),
      command,
      findingKey: "f".repeat(64),
    });
    expect(a).toBe(
      editorialEditIdempotencyPayloadSha256({
        expectedDraftId: 9,
        expectedDraftVersion: 3,
        expectedDraftSha256: "a".repeat(64),
        command,
        findingKey: "f".repeat(64),
      })
    );
    expect(a).not.toBe(
      editorialEditIdempotencyPayloadSha256({
        expectedDraftId: 9,
        expectedDraftVersion: 3,
        expectedDraftSha256: "a".repeat(64),
        command: { ...command, replacementText: "อีกข้อความ" },
        findingKey: "f".repeat(64),
      })
    );
  });
});
