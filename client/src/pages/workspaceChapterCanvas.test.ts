import { describe, expect, it } from "vitest";
import {
  applyChapterCanvasChange,
  chapterCanvasFindingRange,
  chapterCanvasOffsetToParagraph,
  chapterCanvasParagraphStartOffset,
  chapterCanvasParagraphStarts,
  createChapterCanvasHistory,
  pushChapterCanvasHistory,
  redoChapterCanvas,
  serializeChapterCanvasForSave,
  serializeChapterCanvasText,
  undoChapterCanvas,
  type ChapterCanvasParagraph,
} from "./workspaceChapterCanvas";

function makeIdFactory() {
  let counter = 0;
  return () => {
    counter += 1;
    return `new-${counter}`;
  };
}

function nodes(
  entries: Array<[string, string | undefined]>
): ChapterCanvasParagraph[] {
  return entries.map(([id, text], index) => ({
    id,
    paragraphKey: text === undefined ? undefined : `key-${id}`,
    text: text ?? "",
  }));
}

describe("chapter canvas model (IPE-058-C)", () => {
  it("round-trips paragraphs -> canvas -> paragraphs", () => {
    const paragraphs = nodes([
      ["a", "ย่อหน้าแรก"],
      ["b", "ย่อหน้าที่สอง"],
      ["c", "Third paragraph with English"],
    ]);
    const text = serializeChapterCanvasText(paragraphs);
    expect(text).toBe("ย่อหน้าแรก\n\nย่อหน้าที่สอง\n\nThird paragraph with English");
    // Splitting the canvas text reproduces the same node texts in order.
    const changed = applyChapterCanvasChange({
      previous: [],
      oldText: "",
      newText: text,
      nextId: makeIdFactory(),
    });
    expect(changed.paragraphs.map(paragraph => paragraph.text)).toEqual(
      paragraphs.map(paragraph => paragraph.text)
    );
  });

  it("preserves the paragraph key across a plain text edit", () => {
    const previous = nodes([["a", "เดิม"], ["b", "อื่น"]]);
    const oldText = "เดิม\n\nอื่น";
    const newText = "เดิมที่แก้แล้ว\n\nอื่น";
    const result = applyChapterCanvasChange({
      previous,
      oldText,
      newText,
      nextId: makeIdFactory(),
    });
    expect(result.changed).toBe(true);
    expect(result.paragraphs[0]).toMatchObject({
      id: "a",
      paragraphKey: "key-a",
      text: "เดิมที่แก้แล้ว",
    });
    expect(result.paragraphs).toHaveLength(2);
  });

  it("keeps the first piece's key on Enter split and mints the second as new", () => {    const previous = nodes([["a", "ABCDEF"]]);
    const result = applyChapterCanvasChange({
      previous,
      oldText: "ABCDEF",
      newText: "ABC\n\nDEF",
      nextId: makeIdFactory(),
    });
    expect(result.paragraphs).toHaveLength(2);
    expect(result.paragraphs[0]).toMatchObject({
      id: "a",
      paragraphKey: "key-a",
      text: "ABC",
    });
    expect(result.paragraphs[1]?.paragraphKey).toBeUndefined();
    expect(result.paragraphs[1]?.text).toBe("DEF");
    expect(result.paragraphs[1]!.id).not.toBe("a");
  });
  it("keeps the first node's key on merge (boundary removed)", () => {
    const previous = nodes([["a", "หน้า"], ["b", "หลัง"]]);
    const result = applyChapterCanvasChange({
      previous,
      oldText: "หน้า\n\nหลัง",
      newText: "หน้าหลัง",
      nextId: makeIdFactory(),
    });
    expect(result.paragraphs).toHaveLength(1);
    expect(result.paragraphs[0]).toMatchObject({
      id: "a",
      paragraphKey: "key-a",
      text: "หน้าหลัง",
    });
  });

  it("inserting a paragraph does not steal the adjacent key (middle insert)", () => {
    const previous = nodes([["a", "หนึ่ง"], ["b", "สอง"]]);
    const result = applyChapterCanvasChange({
      previous,
      oldText: "หนึ่ง\n\nสอง",
      newText: "หนึ่ง\n\nแทรก\n\nสอง",
      nextId: makeIdFactory(),
    });
    expect(result.paragraphs.map(paragraph => paragraph.text)).toEqual([
      "หนึ่ง",
      "แทรก",
      "สอง",
    ]);
    expect(result.paragraphs[0]).toMatchObject({ id: "a", paragraphKey: "key-a" });
    expect(result.paragraphs[1]?.paragraphKey).toBeUndefined();
    expect(result.paragraphs[2]).toMatchObject({ id: "b", paragraphKey: "key-b" });
  });

  it("handles insert at the beginning and append at the end without re-keying", () => {
    const makeId = makeIdFactory();
    const previous = nodes([["a", "กลาง"]]);
    const atStart = applyChapterCanvasChange({
      previous,
      oldText: "กลาง",
      newText: "หัว\n\nกลาง",
      nextId: makeId,
    });
    expect(atStart.paragraphs[0]?.paragraphKey).toBeUndefined();
    expect(atStart.paragraphs[1]).toMatchObject({ id: "a", paragraphKey: "key-a" });

    const previous2 = nodes([["a", "กลาง"]]);
    const atEnd = applyChapterCanvasChange({
      previous: previous2,
      oldText: "กลาง",
      newText: "กลาง\n\nท้าย",
      nextId: makeId,
    });
    expect(atEnd.paragraphs[0]).toMatchObject({ id: "a", paragraphKey: "key-a" });
    expect(atEnd.paragraphs[1]?.paragraphKey).toBeUndefined();
  });

  it("handles multiple adjacent insertions deterministically", () => {
    const previous = nodes([["a", "จุด"]]);
    const result = applyChapterCanvasChange({
      previous,
      oldText: "จุด",
      newText: "หนึ่ง\n\nสอง\n\nสาม\n\nจุด",
      nextId: makeIdFactory(),
    });
    expect(result.paragraphs.map(paragraph => paragraph.text)).toEqual([
      "หนึ่ง",
      "สอง",
      "สาม",
      "จุด",
    ]);
    expect(result.paragraphs[3]).toMatchObject({ id: "a", paragraphKey: "key-a" });
    expect(
      result.paragraphs.slice(0, 3).every(paragraph => !paragraph.paragraphKey)
    ).toBe(true);
    const ids = new Set(result.paragraphs.map(paragraph => paragraph.id));
    expect(ids.size).toBe(result.paragraphs.length);
  });

  it("deleting a paragraph keeps survivors' keys", () => {    const previous = nodes([["a", "หนึ่ง"], ["b", "สอง"], ["c", "สาม"]]);
    const result = applyChapterCanvasChange({
      previous,
      oldText: "หนึ่ง\n\nสอง\n\nสาม",
      newText: "หนึ่ง\n\nสาม",
      nextId: makeIdFactory(),
    });
    expect(result.paragraphs.map(paragraph => paragraph.id)).toEqual(["a", "c"]);
    expect(result.paragraphs[1]).toMatchObject({ paragraphKey: "key-c" });
  });
  it("treats duplicate paragraph texts positionally per occurrence", () => {
    const previous = nodes([["a", "ซ้ำ"], ["b", "ซ้ำ"]]);
    // Deleting the second duplicate.
    const result = applyChapterCanvasChange({
      previous,
      oldText: "ซ้ำ\n\nซ้ำ",
      newText: "ซ้ำ",
      nextId: makeIdFactory(),
    });
    expect(result.paragraphs).toHaveLength(1);
    expect(result.paragraphs[0]).toMatchObject({ id: "a", paragraphKey: "key-a" });
  });
  it("deleting all content collapses to one empty node keeping its identity", () => {
    const previous = nodes([["a", "ข้อความ"]]);
    const result = applyChapterCanvasChange({
      previous,
      oldText: "ข้อความ",
      newText: "",
      nextId: makeIdFactory(),
    });
    expect(result.paragraphs).toHaveLength(1);
    expect(result.paragraphs[0]).toMatchObject({ id: "a", text: "" });
  });
  it("reorder via cut/paste keeps identity with each logical paragraph", () => {
    // Swapping two paragraphs: both pieces match their original nodes
    // occurrence-wise, so identity follows the paragraph, not the position.
    const previous = nodes([["a", "หนึ่ง"], ["b", "สอง"]]);
    const result = applyChapterCanvasChange({
      previous,
      oldText: "หนึ่ง\n\nสอง",
      newText: "สอง\n\nหนึ่ง",
      nextId: makeIdFactory(),
    });
    expect(result.paragraphs.map(paragraph => paragraph.text)).toEqual([
      "สอง",
      "หนึ่ง",
    ]);
    expect(result.paragraphs[0]).toMatchObject({ id: "b", paragraphKey: "key-b" });
    expect(result.paragraphs[1]).toMatchObject({ id: "a", paragraphKey: "key-a" });
  });
  it("normalizes CRLF paste into paragraph breaks", () => {
    const result = applyChapterCanvasChange({
      previous: [],
      oldText: "",
      newText: "บรรทัดหนึ่ง\r\n\r\nบรรทัดสอง\r\n\r\nบรรทัดสาม",
      nextId: makeIdFactory(),
    });
    expect(result.paragraphs.map(paragraph => paragraph.text)).toEqual([
      "บรรทัดหนึ่ง",
      "บรรทัดสอง",
      "บรรทัดสาม",
    ]);
  });
  it("collapses Google Docs-style excessive blank lines between paragraphs", () => {
    const result = applyChapterCanvasChange({
      previous: [],
      oldText: "",
      newText: "หนึ่ง\n\n\n\n\n\nสอง\n\n \n\t\nสาม",
      nextId: makeIdFactory(),
    });
    expect(result.paragraphs.map(paragraph => paragraph.text)).toEqual([
      "หนึ่ง",
      "สอง",
      "สาม",
    ]);
  });
  it("keeps Shift+Enter soft breaks inside the paragraph node", () => {
    const previous = nodes([["a", "บรรทัดแรก"]]);
    const result = applyChapterCanvasChange({
      previous,
      oldText: "บรรทัดแรก",
      newText: "บรรทัดแรก\nบรรทัดต่อในย่อหน้าเดียว",
      nextId: makeIdFactory(),
    });
    expect(result.paragraphs).toHaveLength(1);
    expect(result.paragraphs[0]).toMatchObject({
      id: "a",
      paragraphKey: "key-a",
      text: "บรรทัดแรก\nบรรทัดต่อในย่อหน้าเดียว",
    });
    // Soft break survives the save projection as one paragraph.
    const save = serializeChapterCanvasForSave(result.paragraphs);
    expect(save.text).toBe(
      "บรรทัดแรก\nบรรทัดต่อในย่อหน้าเดียว"
    );
    expect(save.replacementParagraphKeys).toEqual(["key-a"]);
  });
  it("serializes for save with aligned explicit identity, empty string for new paragraphs", () => {
    const paragraphs: ChapterCanvasParagraph[] = [
      { id: "a", paragraphKey: "key-a", text: "  เดิม  " },
      { id: "new-1", text: "ใหม่" },
      { id: "empty", text: "   " },
    ];
    const save = serializeChapterCanvasForSave(paragraphs);
    expect(save.text).toBe("เดิม\n\nใหม่");
    expect(save.replacementParagraphKeys).toEqual(["key-a", ""]);
  });
  it("maps Thai and emoji (surrogate pair) offsets as raw UTF-16 without conversion", () => {
    const paragraphs = nodes([["a", "ประโยคไทย テスト"], ["b", "😀 emoji"]]);
    const text = serializeChapterCanvasText(paragraphs);
    // Thai combining marks are separate UTF-16 code units.
    expect(text.indexOf("ไท")).toBeGreaterThan(0);
    expect(chapterCanvasOffsetToParagraph(paragraphs, 0)?.nodeIndex).toBe(0);
    // Emoji starts inside node b; the offset is the node start + 0.
    const emojiCanvasOffset = text.indexOf("😀");
    const mapped = chapterCanvasOffsetToParagraph(paragraphs, emojiCanvasOffset);
    expect(mapped?.nodeIndex).toBe(1);
    expect(mapped?.offsetInNode).toBe(0);
    // A surrogate pair occupies two code units; offset + 2 is still in node b.
    expect(
      chapterCanvasOffsetToParagraph(paragraphs, emojiCanvasOffset + 2)?.nodeIndex
    ).toBe(1);
    expect(chapterCanvasParagraphStarts(paragraphs)).toEqual([
      0,
      "ประโยคไทย テスト".length + 2,
    ]);
  });
  it("maps a finding (paragraphKey + offsets) onto the canvas range", () => {
    const paragraphs = nodes([["a", "หนึ่งสองสาม"], ["b", "คำต่างประเทศที่นี่"]]);
    const range = chapterCanvasFindingRange(paragraphs, {
      paragraphKey: "key-b",
      startOffset: 0,
      endOffset: 7,
    });
    const secondStart = chapterCanvasParagraphStartOffset(paragraphs, 1);
    expect(range).toEqual({
      start: secondStart,
      end: secondStart + 7,
    });
  });
  it("fails safely for a stale paragraphKey finding instead of highlighting another paragraph", () => {
    const paragraphs = nodes([["a", "ย่อหน้าเดียว"]]);
    expect(
      chapterCanvasFindingRange(paragraphs, {
        paragraphKey: "deleted-key",
        startOffset: 0,
        endOffset: 3,
      })
    ).toBeNull();
    expect(
      chapterCanvasFindingRange(paragraphs, { paragraphKey: "" })
    ).toBeNull();
  });
  it("supports controlled undo/redo that never crosses a save reset", () => {
    let history = createChapterCanvasHistory(3);
    const stateA = { paragraphs: nodes([["a", "หนึ่ง"]]), caret: 4 };
    const stateB = { paragraphs: nodes([["a", "หนึ่งสอง"]]), caret: 7 };
    history = pushChapterCanvasHistory(history, stateA);
    const undone = undoChapterCanvas(history, stateB);
    expect(undone.entry?.paragraphs[0]?.text).toBe("หนึ่ง");
    expect(undone.history.redo).toHaveLength(1);
    const redone = redoChapterCanvas(undone.history, undone.entry!);
    expect(redone.entry?.paragraphs[0]?.text).toBe("หนึ่งสอง");
    // Any new change clears the redo branch.
    const afterNewEdit = pushChapterCanvasHistory(redone.history, stateA);
    expect(afterNewEdit.redo).toHaveLength(0);
    // Limit is enforced.
    let limited = createChapterCanvasHistory(2);
    for (let index = 0; index < 5; index += 1) {
      limited = pushChapterCanvasHistory(limited, {
        paragraphs: nodes([["a", `v${index}`]]),
        caret: 1,
      });
    }
    expect(limited.undo).toHaveLength(2);
    // Save reset is a fresh history object.
    expect(createChapterCanvasHistory()).toEqual({ undo: [], redo: [], limit: 200 });
  });
  it("stays O(n) on a 1,000-paragraph chapter (round trip + diff + finding map)", () => {
    const makeId = makeIdFactory();
    const previous: ChapterCanvasParagraph[] = Array.from(
      { length: 1_000 },
      (_, index) => ({
        id: `p${index}`,
        paragraphKey: `key-${index}`,
        text: `ย่อหน้าที่ ${index} เนื้อหาสังเคราะห์`,
      })
    );
    const text = serializeChapterCanvasText(previous);
    expect(text).toContain("ย่อหน้าที่ 999");
    // One mid-document edit: O(n) diff + O(n) rebuild.
    const changed = applyChapterCanvasChange({
      previous,
      oldText: text,
      newText: text.replace("ย่อหน้าที่ 500", "ย่อหน้าที่ 500 แก้แล้ว"),
      nextId: makeId,
    });
    expect(changed.paragraphs).toHaveLength(1_000);
    expect(changed.paragraphs[500]?.paragraphKey).toBe("key-500");
    // Finding map does not scan the DOM and is a single pass.
    const range = chapterCanvasFindingRange(changed.paragraphs, {
      paragraphKey: "key-999",
      startOffset: 0,
      endOffset: 5,
    });
    expect(range).not.toBeNull();
  });

  it("IPE-058-C review fix: unmatched pairing follows original document order with duplicate texts", () => {
    // previous: A(KA1), B(KB), A(KA2); new: X, Y, Z (all edited/inserted).
    const previous: ChapterCanvasParagraph[] = [
      { id: "a1", paragraphKey: "KA1", text: "A" },
      { id: "b", paragraphKey: "KB", text: "B" },
      { id: "a2", paragraphKey: "KA2", text: "A" },
    ];
    const result = applyChapterCanvasChange({
      previous,
      oldText: "A\n\nB\n\nA",
      newText: "X\n\nY\n\nZ",
      nextId: makeIdFactory(),
    });
    // Deterministic positional continuity in DOCUMENT order:
    // X<-KA1, Y<-KB, Z<-KA2.
    expect(result.paragraphs.map(paragraph => paragraph.paragraphKey)).toEqual([
      "KA1",
      "KB",
      "KA2",
    ]);
  });

  it("IPE-058-C review fix: partial exact matches anchor document-order pairing", () => {
    // previous: A, B, A, C; new: A, X, Y, C — A(first) and C exact-match;
    // X/Y pair with the unmatched B, A(second) in document order.
    const previous: ChapterCanvasParagraph[] = [
      { id: "a1", paragraphKey: "KA1", text: "A" },
      { id: "b", paragraphKey: "KB", text: "B" },
      { id: "a2", paragraphKey: "KA2", text: "A" },
      { id: "c", paragraphKey: "KC", text: "C" },
    ];
    const result = applyChapterCanvasChange({
      previous,
      oldText: "A\n\nB\n\nA\n\nC",
      newText: "A\n\nX\n\nY\n\nC",
      nextId: makeIdFactory(),
    });
    expect(result.paragraphs.map(paragraph => paragraph.paragraphKey)).toEqual([
      "KA1",
      "KB",
      "KA2",
      "KC",
    ]);
    expect(result.paragraphs.map(paragraph => paragraph.text)).toEqual([
      "A",
      "X",
      "Y",
      "C",
    ]);
  });

  it("IPE-058-C review fix: duplicate occurrences split between exact match and edit stay deterministic", () => {
    // previous: A(KA1), A(KA2); new: A2 (edit of one), A (other kept).
    const previous: ChapterCanvasParagraph[] = [
      { id: "a1", paragraphKey: "KA1", text: "A" },
      { id: "a2", paragraphKey: "KA2", text: "A" },
    ];
    const result = applyChapterCanvasChange({
      previous,
      oldText: "A\n\nA",
      newText: "A2\n\nA",
      nextId: makeIdFactory(),
    });
    // Contract: k-th occurrence of a text in the new document pairs with the
    // k-th occurrence in the previous document (document order), so the exact
    // 'A' consumes KA1 and the edited piece inherits the remaining KA2.
    // Deterministic under duplicates either way.
    expect(result.paragraphs[0]).toMatchObject({ id: "a2", text: "A2" });
    expect(result.paragraphs[1]).toMatchObject({ id: "a1", text: "A" });
  });

  it("IPE-058-C review fix: delete + multi-edit around duplicates keeps document-order continuity", () => {
    // previous: A(KA1), B(KB), A(KA2), C(KC); new: X, C — B and the second A
    // are consumed/deleted; X inherits the first unmatched (KA1) in document
    // order and C exact-matches.
    const previous: ChapterCanvasParagraph[] = [
      { id: "a1", paragraphKey: "KA1", text: "A" },
      { id: "b", paragraphKey: "KB", text: "B" },
      { id: "a2", paragraphKey: "KA2", text: "A" },
      { id: "c", paragraphKey: "KC", text: "C" },
    ];
    const result = applyChapterCanvasChange({
      previous,
      oldText: "A\n\nB\n\nA\n\nC",
      newText: "X\n\nC",
      nextId: makeIdFactory(),
    });
    expect(result.paragraphs.map(paragraph => paragraph.paragraphKey)).toEqual([
      "KA1",
      "KC",
    ]);
  });

  it("IPE-058-C review fix: reordered exact matches keep identity with each paragraph", () => {
    const previous: ChapterCanvasParagraph[] = [
      { id: "a", paragraphKey: "KA", text: "A" },
      { id: "b", paragraphKey: "KB", text: "B" },
    ];
    const result = applyChapterCanvasChange({
      previous,
      oldText: "A\n\nB",
      newText: "B\n\nA",
      nextId: makeIdFactory(),
    });
    expect(result.paragraphs.map(paragraph => paragraph.id)).toEqual(["b", "a"]);
    expect(result.paragraphs.map(paragraph => paragraph.paragraphKey)).toEqual([
      "KB",
      "KA",
    ]);
  });
});
