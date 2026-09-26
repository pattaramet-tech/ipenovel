import { describe, expect, it } from "vitest";

import type { NqaDocumentSnapshot } from "./contracts";
import {
  buildSourceChapterBoundaries,
  buildTranslationChapterBoundaries,
  parseSourceHeading,
  parseTranslationHeading,
} from "./parser";

const sourceSnapshot: NqaDocumentSnapshot = {
  documentId: "1wXZBYJ9Eu586XajNw4R-Q768quKzHsJsIlK-KuWTB0Q",
  title: "English source",
  revisionId:
    "ANLCKQlrksmAFNO1iPtKgVAlfisxIsQbLQc7uTC3g85mxGJsx6yzdO1-tNV-Bgyg8XLgDyFdmWb7I6BP0z3hB_9sNPam8u0pLVZzOoKp1Dk",
  tabs: [
    {
      tabId: "t.0",
      title: "Tab 1",
      index: 0,
      parentTabId: null,
      paragraphs: [
        {
          text: "บท 197: 196. Search and Rescue",
          startIndex: 170567,
          endIndex: 170597,
          tabId: "t.0",
        },
        {
          text: "source 196 body",
          startIndex: 170598,
          endIndex: 181956,
          tabId: "t.0",
        },
        {
          text: "บท 198: 197. Possessing",
          startIndex: 181957,
          endIndex: 181980,
          tabId: "t.0",
        },
        {
          text: "source 197 body",
          startIndex: 181981,
          endIndex: 193006,
          tabId: "t.0",
        },
        {
          text: "บท 199: 198. Rookie",
          startIndex: 193007,
          endIndex: 193027,
          tabId: "t.0",
        },
        {
          text: "source 198 body",
          startIndex: 193028,
          endIndex: 194000,
          tabId: "t.0",
        },
      ],
    },
  ],
};
describe("NQA chapter heading parser", () => {
  it("parses source internal sequence independently from source chapter", () => {
    expect(parseSourceHeading("บท 198: 197. Possessing")).toEqual({
      internalSequence: 198,
      chapter: 197,
      title: "Possessing",
    });
  });

  it("parses live single-number source headings without changing legacy semantics", () => {
    expect(parseSourceHeading("บท 101: Homecoming")).toEqual({
      internalSequence: 101,
      chapter: 101,
      title: "Homecoming",
    });
    expect(parseSourceHeading("บท 101:")).toBeNull();
    expect(parseSourceHeading("บท 0: Homecoming")).toBeNull();
  });

  it("builds source boundaries from live single-number source headings", () => {
    const liveSource: NqaDocumentSnapshot = {
      documentId: "live-source-101",
      title: "Live English source",
      revisionId: "live-rev-1",
      tabs: [
        {
          tabId: "t.0",
          title: "Tab 1",
          index: 0,
          parentTabId: null,
          paragraphs: [
            {
              text: "บท 101: Homecoming",
              startIndex: 1,
              endIndex: 21,
              tabId: "t.0",
            },
            {
              text: "source 101 body",
              startIndex: 22,
              endIndex: 37,
              tabId: "t.0",
            },
            {
              text: "บท 102: The Next Chapter",
              startIndex: 38,
              endIndex: 63,
              tabId: "t.0",
            },
            {
              text: "source 102 body",
              startIndex: 64,
              endIndex: 79,
              tabId: "t.0",
            },
          ],
        },
      ],
    };

    expect(buildSourceChapterBoundaries(liveSource)).toMatchObject([
      {
        internalSequence: 101,
        chapter: 101,
        title: "Homecoming",
        paragraphStart: 0,
        paragraphEnd: 1,
      },
      {
        internalSequence: 102,
        chapter: 102,
        title: "The Next Chapter",
        paragraphStart: 2,
        paragraphEnd: 3,
      },
    ]);
  });

  it("parses Thai translation chapter headings", () => {
    expect(parseTranslationHeading("บทที่ 197 การสิงร่าง(แปลใหม่)")).toEqual({
      chapter: 197,
      title: "การสิงร่าง(แปลใหม่)",
    });
  });

  it("builds the canonical source 197 range without using paragraph position as chapter id", () => {
    const boundaries = buildSourceChapterBoundaries(sourceSnapshot);
    const chapter197 = boundaries.find(boundary => boundary.chapter === 197);

    expect(chapter197).toMatchObject({
      internalSequence: 198,
      chapter: 197,
      title: "Possessing",
      tabId: "t.0",
      startIndex: 181957,
      endIndex: 193006,
      paragraphStart: 2,
      paragraphEnd: 3,
    });
  });

  it("classifies corrected translation content from heading/tab evidence", () => {
    const translation: NqaDocumentSnapshot = {
      documentId: "1iLE_8KxtftOIcZuRuU30CVmOQM0W3CnF4HWARAT3vjY",
      title: "Thai translation",
      revisionId: "revision-90",
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
              text: "corrected body",
              startIndex: 31,
              endIndex: 100,
              tabId: "t.bf525hytchcg",
            },
          ],
        },
      ],
    };

    expect(buildTranslationChapterBoundaries(translation)[0]).toMatchObject({
      chapter: 197,
      title: "การสิงร่าง(แปลใหม่)",
      variant: "corrected_candidate",
      tabId: "t.bf525hytchcg",
      tabIndex: 16,
    });
  });
  it("treats tab index as evidence only", () => {
    const translation: NqaDocumentSnapshot = {
      documentId: "translation-document-123",
      title: "Thai",
      revisionId: "rev-1",
      tabs: [
        {
          tabId: "t.unrelated-position",
          title: "แท็บ 99",
          index: 98,
          parentTabId: null,
          paragraphs: [
            {
              text: "บทที่ 197 การสิงร่าง",
              startIndex: 1,
              endIndex: 20,
              tabId: "t.unrelated-position",
            },
          ],
        },
      ],
    };

    const boundary = buildTranslationChapterBoundaries(translation)[0];
    expect(boundary.chapter).toBe(197);
    expect(boundary.tabIndex).toBe(98);
  });

  it("supports explicit historical variant override without changing heading identity", () => {
    const translation: NqaDocumentSnapshot = {
      documentId: "translation-document-123",
      title: "Historical Thai",
      revisionId: "drive-revision-69",
      tabs: [
        {
          tabId: "t.bf525hytchcg",
          title: "แท็บ 17",
          index: 16,
          parentTabId: null,
          paragraphs: [
            {
              text: "บทที่ 197 ค้นหาและช่วยเหลือ",
              startIndex: 1,
              endIndex: 30,
              tabId: "t.bf525hytchcg",
            },
          ],
        },
      ],
    };

    expect(
      buildTranslationChapterBoundaries(translation, {
        "t.bf525hytchcg": "historical_revision",
      })[0]
    ).toMatchObject({
      chapter: 197,
      variant: "historical_revision",
    });
  });
});
