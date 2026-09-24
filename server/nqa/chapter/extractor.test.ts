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
