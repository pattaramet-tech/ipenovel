import { describe, expect, it } from "vitest";

import {
  assertMasterIntakeRowRange,
  googleDocumentIdFromUrlOrId,
  masterIntakePreviewFingerprint,
  masterIntakeRowFingerprint,
  normalizeOptionalHttpUrl,
  parseMasterIntakeTitleRange,
} from "./masterIntake.domain";

describe("Workspace Master Intake domain", () => {
  it("parses a Thai title with a trailing episode range", () => {
    expect(parseMasterIntakeTitleRange("เกิดใหม่ในโลกโปเกมอน เส้นทางจ้าวกลยุทธ์ 341 - 390")).toMatchObject({
      novelTitle: "เกิดใหม่ในโลกโปเกมอน เส้นทางจ้าวกลยุทธ์",
      episodeNumber: "341-390",
      rangeStart: 341,
      rangeEnd: 390,
    });
  });

  it("preserves zero padding and normalizes dash variants", () => {
    expect(parseMasterIntakeTitleRange("วันพีซ ทดสอบ 001 — 050")).toMatchObject({
      novelTitle: "วันพีซ ทดสอบ",
      episodeNumber: "001-050",
      rangeStart: 1,
      rangeEnd: 50,
    });
  });

  it("rejects missing, reversed, and title-less ranges", () => {
    expect(parseMasterIntakeTitleRange("ไม่มีช่วงตอน")).toBeNull();
    expect(parseMasterIntakeTitleRange("เรื่อง 050 - 001")).toBeNull();
    expect(parseMasterIntakeTitleRange("001 - 050")).toBeNull();
  });

  it("accepts only Google Docs document identities for C/K", () => {
    const id = "1_PJbiXFkkXVfPpQsu2gIzTkfksQAAOYRUhQJIaX1gRs";
    expect(googleDocumentIdFromUrlOrId(`https://docs.google.com/document/d/${id}/edit?tab=t.1`)).toBe(id);
    expect(googleDocumentIdFromUrlOrId(id)).toBe(id);
    expect(googleDocumentIdFromUrlOrId("https://example.com/document/abc")).toBeNull();
  });

  it("allows optional http/https web source only", () => {
    expect(normalizeOptionalHttpUrl("")).toBeNull();
    expect(normalizeOptionalHttpUrl("https://www.webnovel.com/book/1")).toContain("https://www.webnovel.com");
    expect(normalizeOptionalHttpUrl("javascript:alert(1)")).toBeUndefined();
  });

  it("bounds every bulk request to 1-100 rows", () => {
    expect(() => assertMasterIntakeRowRange(2, 101)).not.toThrow();
    expect(() => assertMasterIntakeRowRange(2, 102)).toThrow(/1-100 rows/);
    expect(() => assertMasterIntakeRowRange(1, 1)).toThrow(/1-100 rows/);
  });

  it("binds preview fingerprints to resolved Workspace targets", () => {
    const base = {
      workspaceId: 7,
      startRow: 1584,
      endRow: 1584,
      rows: [{
        rowNumber: 1584,
        rowFingerprint: "a".repeat(64),
        status: "MATCH",
        existingNovelId: 10,
        workspaceNovelId: 20,
        workItemId: 30,
        blockers: [] as string[],
        sourceAlreadyLinked: true,
      }],
    };
    const fingerprint = masterIntakePreviewFingerprint(base);
    expect(masterIntakePreviewFingerprint({ ...base })).toBe(fingerprint);
    expect(
      masterIntakePreviewFingerprint({
        ...base,
        rows: [{ ...base.rows[0], workItemId: 31 }],
      })
    ).not.toBe(fingerprint);
    expect(
      masterIntakePreviewFingerprint({
        ...base,
        rows: [{ ...base.rows[0], sourceAlreadyLinked: false }],
      })
    ).not.toBe(fingerprint);
  });

  it("fingerprints stable canonical row identity and links", () => {
    const row = {
      spreadsheetId: "sheet",
      sheetId: 10,
      sheetName: "tab",
      rowNumber: 1584,
      novelTitle: "เรื่อง",
      normalizedTitle: "เรื่อง",
      episodeNumber: "001-050",
      translationDocUrl: "https://docs.google.com/document/d/12345678901234567890/edit",
      translationDocumentId: "12345678901234567890",
      webSourceUrl: "https://example.com/source",
      preparedSourceDocUrl: "https://docs.google.com/document/d/abcdefghijabcdefghij/edit",
      preparedSourceDocumentId: "abcdefghijabcdefghij",
    };
    expect(masterIntakeRowFingerprint(row)).toBe(masterIntakeRowFingerprint({ ...row }));
    expect(masterIntakeRowFingerprint({ ...row, webSourceUrl: "https://example.com/changed" }))
      .not.toBe(masterIntakeRowFingerprint(row));
  });
});
