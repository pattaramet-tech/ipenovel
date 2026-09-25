import { describe, expect, it } from "vitest";

import {
  buildChapterQaIdempotencyKey,
  buildIntakeIdempotencyKey,
  canonicalJson,
  makeBundleIdentity,
  makeNovelCandidateIdentity,
  normalizeFixtureTextV1,
  parseBundleDisplayTitle,
} from "./core";

describe("NQA core foundation", () => {
  it("normalizes fixture text deterministically", () => {
    expect(
      normalizeFixtureTextV1("แท็บ 17\r\nบทที่ 197  \r\nเนื้อหา\r\n", {
        stripLeadingTabLabel: true,
      })
    ).toBe("บทที่ 197\nเนื้อหา");
  });

  it("parses a display-title range without making the row the identity", () => {
    expect(
      parseBundleDisplayTitle(
        "วันพีซ: ความทรงจำเนื้อเรื่องถูกลบ แต่ผมมีระบบนินจา 181 - 230"
      )
    ).toEqual({
      canonicalTitle: "วันพีซ: ความทรงจำเนื้อเรื่องถูกลบ แต่ผมมีระบบนินจา",
      rangeStart: 181,
      rangeEnd: 230,
      isFinished: false,
    });
  });

  it("creates a stable structured candidate novel id", () => {
    const a = makeNovelCandidateIdentity("ชื่อเรื่อง : ทดสอบ");
    const b = makeNovelCandidateIdentity(" ชื่อเรื่อง:ทดสอบ ");
    expect(a.novelId).toBe(b.novelId);
  });

  it("creates a bundle id from novel identity and range", () => {
    const novel = makeNovelCandidateIdentity("เรื่องทดสอบ");
    const bundle = makeBundleIdentity({
      novel,
      rangeStart: 181,
      rangeEnd: 230,
      locator: null,
      translationDocumentId: "translation-document-123",
      sourceDocumentId: "source-document-12345",
    });

    expect(bundle.bundleId).toContain("_181_230");
    expect(bundle.novelId).toBe(novel.novelId);
  });

  it("canonicalizes object key order before hashing", () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe(canonicalJson({ a: 1, b: 2 }));
  });

  it("changes intake idempotency when a revision changes", () => {
    const base = {
      spreadsheetId: "sheet-1234567890",
      sheetName: "Sheet",
      row: 10,
      sourceDocumentId: "source-document-12345",
      sourceRevisionId: "4",
      translationDocumentId: "translation-document-123",
      translationRevisionId: "69",
      contractVersion: "nqa-source-contract-v1",
    };

    expect(buildIntakeIdempotencyKey(base)).not.toBe(
      buildIntakeIdempotencyKey({
        ...base,
        translationRevisionId: "90",
      })
    );
  });

  it("includes model and policy versions in chapter QA idempotency", () => {
    const base = {
      novelId: "novel_0123456789abcdef",
      bundleId: "bundle_0123456789abcdef_181_230",
      sourceChapter: 197,
      sourceHash: "a".repeat(64),
      translationHash: "b".repeat(64),
      translationVariant: "historical_revision",
      chunkerVersion: "chunk-v1",
      modelSetVersion: "models-v1",
      policyVersion: "policy-v1",
    };

    expect(buildChapterQaIdempotencyKey(base)).not.toBe(
      buildChapterQaIdempotencyKey({ ...base, policyVersion: "policy-v2" })
    );
  });
});
