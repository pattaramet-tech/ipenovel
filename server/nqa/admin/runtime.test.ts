import { describe, expect, it } from "vitest";

import type { NqaDocumentSnapshot } from "../chapter/contracts";
import {
  SamplingNqaChapterReader,
  hashNqaAdminWriteback,
  nqaAdminRuntimeStaticConfig,
  qcFindings,
  sampledTab,
  scanForeignScripts,
  scanUnicodeAnomalies,
} from "./runtime";

function paragraph(text: string, index: number) {
  return {
    text,
    startIndex: index * 10,
    endIndex: index * 10 + text.length,
    tabId: "t.1",
  };
}

describe("M26 NQA Admin runtime", () => {
  it("samples chapter bodies while retaining every chapter heading", () => {
    const tab = {
      tabId: "t.1",
      title: "sample",
      index: 0,
      parentTabId: null,
      paragraphs: [
        paragraph("บทที่ 101 ชื่อ", 0),
        paragraph("a", 1),
        paragraph("b", 2),
        paragraph("c", 3),
        paragraph("บทที่ 102 ต่อ", 4),
        paragraph("d", 5),
        paragraph("e", 6),
        paragraph("f", 7),
      ],
    };

    expect(sampledTab(tab, 2).paragraphs.map(item => item.text)).toEqual([
      "บทที่ 101 ชื่อ",
      "a",
      "b",
      "บทที่ 102 ต่อ",
      "d",
      "e",
    ]);
  });

  it("FULL sampling returns the original document while bounded sampling is cached", async () => {
    let reads = 0;
    const snapshot: NqaDocumentSnapshot = {
      documentId: "document-123456789",
      title: "translation",
      revisionId: "r1",
      tabs: [
        {
          tabId: "t.1",
          title: "chapter",
          index: 0,
          parentTabId: null,
          paragraphs: [
            paragraph("บทที่ 101 ชื่อ", 0),
            paragraph("one", 1),
            paragraph("two", 2),
            paragraph("three", 3),
          ],
        },
      ],
    };
    const reader = {
      async readDocument() {
        reads += 1;
        return snapshot;
      },
    };

    const sampled = new SamplingNqaChapterReader(reader, 2);
    const [first, second] = await Promise.all([
      sampled.readDocument(snapshot.documentId),
      sampled.readDocument(snapshot.documentId),
    ]);
    expect(first.tabs[0].paragraphs).toHaveLength(3);
    expect(second.tabs[0].paragraphs).toHaveLength(3);
    expect(reads).toBe(1);

    const full = new SamplingNqaChapterReader(reader, "FULL");
    expect(
      (await full.readDocument(snapshot.documentId)).tabs[0].paragraphs
    ).toHaveLength(4);
  });

  it("QC allows Latin proper names but detects foreign scripts and Unicode anomalies", () => {
    expect(scanForeignScripts("Uchiha Obito โนฮาระ ริน")).toEqual([]);
    expect(scanForeignScripts("ทดสอบ нох").join(" ")).toContain("Cyrillic");
    expect(scanForeignScripts("ทดสอบ हो").join(" ")).toContain("Devanagari");
    expect(scanUnicodeAnomalies("ปกติ\ufffd")).toContain("U+FFFD");
  });

  it("QC detects footer contamination and empty chapter bodies", () => {
    const footer = qcFindings({
      translationText:
        "บทที่ 1\nเนื้อเรื่อง\nThanks for reading\nPatreon.com/test",
      rawParagraphs: [
        paragraph("บทที่ 1", 0),
        paragraph("เนื้อเรื่อง", 1),
        paragraph("Thanks for reading", 2),
        paragraph("Patreon.com/test", 3),
      ],
    });
    expect(footer.some(item => item.type === "FOOTER_CONTENT")).toBe(true);

    const empty = qcFindings({
      translationText: "บทที่ 2",
      rawParagraphs: [paragraph("บทที่ 2", 0)],
    });
    expect(empty.some(item => item.type === "EMPTY_CHAPTER")).toBe(true);
  });

  it("writeback activation is exact-literal and fingerprinting is deterministic", () => {
    const base = {
      NQA_AUTOLINK_GOOGLE_READ_ACCESS_TOKEN: "read",
      NQA_AUTOLINK_GOOGLE_READ_GRANTED_SCOPES:
        "https://www.googleapis.com/auth/spreadsheets.readonly",
      NQA_AUTOLINK_GOOGLE_WRITE_ACCESS_TOKEN: "write",
      NQA_AUTOLINK_GOOGLE_WRITE_GRANTED_SCOPES:
        "https://www.googleapis.com/auth/spreadsheets",
    };

    expect(
      nqaAdminRuntimeStaticConfig({
        ...base,
        NQA_ADMIN_WRITEBACK_ENABLED: "TRUE",
      }).writebackEnabled
    ).toBe(false);
    expect(
      nqaAdminRuntimeStaticConfig({
        ...base,
        NQA_ADMIN_WRITEBACK_ENABLED: "true",
      }).writebackEnabled
    ).toBe(true);

    const value = { runId: "run", row: 10, column: "L" };
    expect(hashNqaAdminWriteback(value)).toBe(hashNqaAdminWriteback(value));
    expect(hashNqaAdminWriteback(value)).toMatch(/^[a-f0-9]{64}$/);
  });
});
