import { describe, expect, it } from "vitest";
import {
  applyChapterCanvasChange,
  chapterCanvasFindingRange,
  chapterCanvasOffsetToParagraph,
  type ChapterCanvasParagraph,
} from "./workspaceChapterCanvas";

function makeIdFactory() {
  let counter = 0;
  return () => {
    counter += 1;
    return `new-${counter}`;
  };
}

const previous: ChapterCanvasParagraph[] = [
  { id: "a", paragraphKey: "KA", text: "ย่อหน้าแรก" },
  { id: "b", paragraphKey: "KB", text: "ย่อหน้าที่สอง" },
];

describe("IPE-058-E finding coordinate contract", () => {
  it("maps a finding onto the canvas range deterministically (Previous/Next stable)", () => {
    const first = chapterCanvasFindingRange(previous, {
      paragraphKey: "KA",
      startOffset: 0,
      endOffset: 4,
    });
    const second = chapterCanvasFindingRange(previous, {
      paragraphKey: "KB",
      startOffset: 2,
      endOffset: 9,
    });
    expect(first).toEqual({ start: 0, end: 4 });
    expect(second?.start).toBeGreaterThan(first!.end);
  });

  it("fails safely for a stale paragraphKey — no highlight, no wrong paragraph", () => {
    expect(
      chapterCanvasFindingRange(previous, {
        paragraphKey: "DELETED",
        startOffset: 0,
        endOffset: 5,
      })
    ).toBeNull();
    expect(
      chapterCanvasFindingRange(previous, { paragraphKey: null })
    ).toBeNull();
  });

  it("IPE-058-E review fix: invalid offsets fail-safe to null — never clamped onto another span", () => {
    // End beyond the node length.
    expect(
      chapterCanvasFindingRange(previous, {
        paragraphKey: "KA",
        startOffset: 0,
        endOffset: 999_999,
      })
    ).toBeNull();
    // Start beyond the node length.
    expect(
      chapterCanvasFindingRange(previous, {
        paragraphKey: "KA",
        startOffset: 500,
        endOffset: 600,
      })
    ).toBeNull();
    // Negative offsets.
    expect(
      chapterCanvasFindingRange(previous, {
        paragraphKey: "KA",
        startOffset: -1,
        endOffset: 3,
      })
    ).toBeNull();
    expect(
      chapterCanvasFindingRange(previous, {
        paragraphKey: "KA",
        startOffset: 0,
        endOffset: -3,
      })
    ).toBeNull();
    // start > end.
    expect(
      chapterCanvasFindingRange(previous, {
        paragraphKey: "KA",
        startOffset: 5,
        endOffset: 2,
      })
    ).toBeNull();
    // NaN / non-finite.
    expect(
      chapterCanvasFindingRange(previous, {
        paragraphKey: "KA",
        startOffset: Number.NaN,
        endOffset: 3,
      })
    ).toBeNull();
    expect(
      chapterCanvasFindingRange(previous, {
        paragraphKey: "KA",
        startOffset: 0,
        endOffset: Number.POSITIVE_INFINITY,
      })
    ).toBeNull();
    // Exact boundary is VALID (zero-width caret range at node end accepted).
    expect(
      chapterCanvasFindingRange(previous, {
        paragraphKey: "KA",
        startOffset: 0,
        endOffset: "ย่อหน้าแรก".length,
      })
    ).toEqual({ start: 0, end: "ย่อหน้าแรก".length });
    expect(
      chapterCanvasFindingRange(previous, {
        paragraphKey: "KA",
        startOffset: "ย่อหน้าแรก".length,
        endOffset: "ย่อหน้าแรก".length,
      })
    ).toEqual({ start: "ย่อหน้าแรก".length, end: "ย่อหน้าแรก".length });
  });

  it("IPE-058-E review fix: emoji UTF-16 boundaries still map correctly when valid", () => {
    const withEmoji: ChapterCanvasParagraph[] = [
      { id: "e", paragraphKey: "KE", text: "😀" },
    ];
    // The surrogate pair occupies UTF-16 code units 0..2.
    expect(
      chapterCanvasFindingRange(withEmoji, {
        paragraphKey: "KE",
        startOffset: 0,
        endOffset: 2,
      })
    ).toEqual({ start: 0, end: 2 });
    // End at 2 is the exact node boundary: valid.
    expect(
      chapterCanvasFindingRange(withEmoji, {
        paragraphKey: "KE",
        startOffset: 1,
        endOffset: 2,
      })
    ).toEqual({ start: 1, end: 2 });
    // End at 3 exceeds the node's UTF-16 length: fail-safe null (no clamp).
    expect(
      chapterCanvasFindingRange(withEmoji, {
        paragraphKey: "KE",
        startOffset: 0,
        endOffset: 3,
      })
    ).toBeNull();
  });

  it("treats structural findings (no paragraphKey) as range-less — handled by tab navigation", () => {
    expect(chapterCanvasFindingRange(previous, {})).toBeNull();
    expect(
      chapterCanvasFindingRange(previous, {
        paragraphKey: undefined,
        startOffset: null,
        endOffset: null,
      })
    ).toBeNull();
  });

  it("maps offsets after content changes onto surviving nodes, not stale ones", () => {
    const result = applyChapterCanvasChange({
      previous,
      oldText: "ย่อหน้าแรก\n\nย่อหน้าที่สอง",
      newText: "ย่อหน้าแรก\n\nย่อหน้ากลางแทรก\n\nย่อหน้าที่สอง",
      nextId: makeIdFactory(),
    });
    const second = chapterCanvasFindingRange(result.paragraphs, {
      paragraphKey: "KB",
      startOffset: 0,
      endOffset: 3,
    });
    // KB moved further down the canvas but kept its identity.
    expect(second).not.toBeNull();
    const nodeStart = result.paragraphs.findIndex(p => p.paragraphKey === "KB");
    // KB moved further down the canvas but kept its identity: its canvas
    // range starts exactly at its own node offset.
    const nodeOffset = result.paragraphs
      .slice(0, nodeStart)
      .reduce((sum, paragraph) => sum + paragraph.text.length + 2, 0);
    expect(second!.start).toBe(nodeOffset);
  });
});
