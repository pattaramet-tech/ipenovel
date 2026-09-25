import { describe, expect, it } from "vitest";

import type { NqaDocumentSnapshot } from "./contracts";
import { extractSourceChapter, extractTranslationChapter } from "./extractor";
import {
  buildSourceChapterBoundaries,
  buildTranslationChapterBoundaries,
} from "./parser";

describe("NQA chapter extractor", () => {
  it("extracts only the resolved source chapter range", () => {
    const snapshot: NqaDocumentSnapshot = {
      documentId: "source-document-12345",
      title: "English",
      revisionId: "rev-source",
      tabs: [
        {
          tabId: "t.0",
          title: "Tab 1",
          index: 0,
          parentTabId: null,
          paragraphs: [
            {
              text: "บท 198: 197. Possessing",
              startIndex: 181957,
              endIndex: 181980,
              tabId: "t.0",
            },
            {
              text: "Sabo is unconscious.",
              startIndex: 181981,
              endIndex: 182010,
              tabId: "t.0",
            },
            {
              text: "Kurama catches the possessor.",
              startIndex: 182011,
              endIndex: 182050,
              tabId: "t.0",
            },
            {
              text: "บท 199: 198. Rookie",
              startIndex: 182051,
              endIndex: 182072,
              tabId: "t.0",
            },
          ],
        },
      ],
    };

    const boundary = buildSourceChapterBoundaries(snapshot).find(
      candidate => candidate.chapter === 197
    );
    expect(boundary).toBeDefined();

    const extraction = extractSourceChapter({
      snapshot,
      boundary: boundary!,
    });

    expect(extraction).toMatchObject({
      chapter: 197,
      internalSequence: 198,
      title: "Possessing",
      paragraphCount: 3,
      startIndex: 181957,
      endIndex: 182050,
      variant: null,
    });
    expect(extraction.text).toContain("Sabo is unconscious.");
    expect(extraction.text).toContain("Kurama catches the possessor.");
    expect(extraction.text).not.toContain("Rookie");
    expect(extraction.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("extracts a translation variant with tab provenance", () => {
    const snapshot: NqaDocumentSnapshot = {
      documentId: "translation-document-123",
      title: "Thai",
      revisionId: "rev-thai",
      tabs: [
        {
          tabId: "t.bf525hytchcg",
          title: "บทที่ 197 การสิงร่าง",
          index: 16,
          parentTabId: null,
          paragraphs: [
            {
              text: "บทที่ 197 การสิงร่าง(แปลใหม่)",
              startIndex: 1,
              endIndex: 30,
              tabId: "t.bf525hytchcg",
            },
            {
              text: "จอนมาถึงชั้น 5.5 พร้อมซาโบ",
              startIndex: 31,
              endIndex: 70,
              tabId: "t.bf525hytchcg",
            },
          ],
        },
      ],
    };

    const boundary = buildTranslationChapterBoundaries(snapshot)[0];
    const extraction = extractTranslationChapter({
      snapshot,
      boundary,
    });

    expect(extraction).toMatchObject({
      chapter: 197,
      internalSequence: null,
      title: "การสิงร่าง(แปลใหม่)",
      variant: "corrected_candidate",
      tabId: "t.bf525hytchcg",
      paragraphCount: 2,
      startIndex: 1,
      endIndex: 70,
    });
    expect(extraction.text).toContain("ซาโบ");
  });

  it("sanitizes source tail noise and updates paragraph/end-index provenance", () => {
    const snapshot: NqaDocumentSnapshot = {
      documentId: "source-tail-noise",
      title: "English",
      revisionId: "rev-tail",
      tabs: [
        {
          tabId: "t.0",
          title: "Source",
          index: 0,
          parentTabId: null,
          paragraphs: [
            {
              text: "บท 82: 81. Promotion",
              startIndex: 1,
              endIndex: 22,
              tabId: "t.0",
            },
            {
              text: "Actual story ending.",
              startIndex: 23,
              endIndex: 43,
              tabId: "t.0",
            },
            {
              text: "Patreon(.)com/Bleam",
              startIndex: 44,
              endIndex: 63,
              tabId: "t.0",
            },
            {
              text: "For 100 advance chapters, read ahead!",
              startIndex: 64,
              endIndex: 101,
              tabId: "t.0",
            },
          ],
        },
      ],
    };
    const boundary = buildSourceChapterBoundaries(snapshot)[0];
    const extraction = extractSourceChapter({ snapshot, boundary });

    expect(extraction.text).toBe("บท 82: 81. Promotion\nActual story ending.");
    expect(extraction.paragraphCount).toBe(2);
    expect(extraction.endIndex).toBe(43);
    expect(extraction.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("sanitizes translated copied UI tail before downstream QA", () => {
    const snapshot: NqaDocumentSnapshot = {
      documentId: "translation-tail-noise",
      title: "Thai",
      revisionId: "rev-tail-th",
      tabs: [
        {
          tabId: "t.0",
          title: "บท 81",
          index: 0,
          parentTabId: null,
          paragraphs: [
            {
              text: "บทที่ 81 กิจกรรมส่งเสริมการขาย",
              startIndex: 1,
              endIndex: 31,
              tabId: "t.0",
            },
            {
              text: "นี่คือเนื้อเรื่องจริง",
              startIndex: 32,
              endIndex: 49,
              tabId: "t.0",
            },
            {
              text: "ความคิดเห็น",
              startIndex: 50,
              endIndex: 61,
              tabId: "t.0",
            },
            {
              text: "ความคิดเห็น 14",
              startIndex: 62,
              endIndex: 76,
              tabId: "t.0",
            },
            {
              text: "โหวต",
              startIndex: 77,
              endIndex: 81,
              tabId: "t.0",
            },
            {
              text: "จบตอน",
              startIndex: 82,
              endIndex: 87,
              tabId: "t.0",
            },
          ],
        },
      ],
    };
    const boundary = buildTranslationChapterBoundaries(snapshot)[0];
    const extraction = extractTranslationChapter({ snapshot, boundary });

    expect(extraction.text).toBe(
      "บทที่ 81 กิจกรรมส่งเสริมการขาย\nนี่คือเนื้อเรื่องจริง"
    );
    expect(extraction.paragraphCount).toBe(2);
    expect(extraction.endIndex).toBe(49);
  });

  it("produces deterministic hashes for identical chapter snapshots", () => {
    const snapshot: NqaDocumentSnapshot = {
      documentId: "translation-document-123",
      title: "Thai",
      revisionId: "rev-thai",
      tabs: [
        {
          tabId: "t.1",
          title: "แท็บ 1",
          index: 0,
          parentTabId: null,
          paragraphs: [
            {
              text: "บทที่ 1 เริ่มต้น",
              startIndex: 1,
              endIndex: 16,
              tabId: "t.1",
            },
            {
              text: "เนื้อหา",
              startIndex: 17,
              endIndex: 30,
              tabId: "t.1",
            },
          ],
        },
      ],
    };
    const boundary = buildTranslationChapterBoundaries(snapshot)[0];

    const a = extractTranslationChapter({ snapshot, boundary });
    const b = extractTranslationChapter({ snapshot, boundary });

    expect(a.sha256).toBe(b.sha256);
  });
});
