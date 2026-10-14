import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { chapterEditorFindingRanges } from "./workspaceChapterEditor";
import {
  authorCanvasFindings,
  serializeChapterCanvasText,
  type ChapterCanvasParagraph,
} from "./workspaceChapterCanvas";
import {
  AuthorStageButton,
  authorCanvasLoadDecision,
  authorMutationNotice,
  confirmDiscardUnsavedEdits,
} from "./authorEditorGuards";

function paragraphs(): ChapterCanvasParagraph[] {
  return [
    { id: "a", paragraphKey: "p-1", text: "ย่อหน้าแรกสะอาด" },
    { id: "b", paragraphKey: "p-2", text: "คำต่างประเทศอยู่ในย่อหน้าสอง" },
    { id: "c", paragraphKey: "p-3", text: "ย่อหน้าสาม" },
  ];
}

describe("author canvas finding coordinates", () => {
  it("places findings from later paragraphs after the earlier paragraph text", () => {
    const nodes = paragraphs();
    const text = serializeChapterCanvasText(nodes);
    const second = "คำต่างประเทศ";
    const third = "ย่อหน้าสาม";
    const ranges = authorCanvasFindings(nodes, [
      {
        sourceTabId: "tab-1",
        paragraphKey: "p-2",
        startOffset: 0,
        endOffset: second.length,
        token: second,
      },
      {
        sourceTabId: "tab-1",
        paragraphKey: "p-3",
        startOffset: 0,
        endOffset: third.length,
        token: third,
      },
      {
        sourceTabId: "tab-1",
        paragraphKey: "deleted",
        startOffset: 0,
        endOffset: 3,
        token: "ย่อห",
      },
      {
        sourceTabId: "tab-1",
        paragraphKey: "p-2",
        startOffset: 80,
        endOffset: 90,
        token: second,
      },
      {
        sourceTabId: "tab-9",
        paragraphKey: "p-2",
        startOffset: 0,
        endOffset: second.length,
        token: second,
      },
    ], "tab-1");
    const secondStart = text.indexOf(second);
    const thirdStart = text.indexOf(third);
    expect(secondStart).toBeGreaterThan(nodes[0]!.text.length);
    expect(ranges).toEqual([
      { startOffset: secondStart, endOffset: secondStart + second.length, token: second },
      { startOffset: thirdStart, endOffset: thirdStart + third.length, token: third },
    ]);
    expect(chapterEditorFindingRanges(text, ranges)).toEqual([
      { start: secondStart, end: secondStart + second.length },
      { start: thirdStart, end: thirdStart + third.length },
    ]);
  });
});

describe("author canvas load after a save attempt", () => {
  it("holds a dirty canvas when the save was rejected", () => {
    expect(authorCanvasLoadDecision({
      forceLoad: false,
      localDirty: true,
      acceptedSaveText: null,
      currentText: "edited",
    })).toBe("hold");
  });

  it("replaces the canvas when the confirmed save still matches the text", () => {
    expect(authorCanvasLoadDecision({
      forceLoad: false,
      localDirty: true,
      acceptedSaveText: "edited",
      currentText: "edited",
    })).toBe("replace");
  });

  it("keeps newer keystrokes after a confirmed save", () => {
    expect(authorCanvasLoadDecision({
      forceLoad: false,
      localDirty: true,
      acceptedSaveText: "edited",
      currentText: "edited more",
    })).toBe("keep-edits");
  });
});

describe("author unsaved edit navigation", () => {
  it("leaves a clean editor without asking", () => {
    let asked = false;
    expect(confirmDiscardUnsavedEdits(false, () => {
      asked = true;
      return false;
    })).toBe(true);
    expect(asked).toBe(false);
  });

  it("stays when the author declines to discard", () => {
    expect(confirmDiscardUnsavedEdits(true, () => false)).toBe(false);
  });

  it("leaves when the author confirms the discard", () => {
    expect(confirmDiscardUnsavedEdits(true, () => true)).toBe(true);
  });
});

describe("author mutation notices", () => {
  it("stays silent while the request is still pending", () => {
    expect(authorMutationNotice("pending", "Save")).toBeNull();
  });

  it("reports success only for a completed server response", () => {
    expect(authorMutationNotice("success", "Stage")).toEqual({
      role: "status",
      text: "Stage completed.",
    });
  });

  it("shows the server message for a failed action", () => {
    expect(authorMutationNotice("error", "Save", "Draft version conflict")).toEqual({
      role: "alert",
      text: "Save failed: Draft version conflict",
    });
    expect(authorMutationNotice("error", "Undo", "  ")).toEqual({
      role: "alert",
      text: "Undo failed.",
    });
  });
});

describe("author Stage button", () => {
  function markup(props: {
    busy?: boolean;
    dirty?: boolean;
    stageActionReady: boolean;
    approvalId: number | null;
  }) {
    return renderToStaticMarkup(createElement(AuthorStageButton, {
      busy: props.busy ?? false,
      dirty: props.dirty ?? false,
      stageActionReady: props.stageActionReady,
      approvalId: props.approvalId,
      onStage: () => {},
    }));
  }

  function isDisabled(html: string) {
    return /<button\b[^>]*\sdisabled=""/.test(html);
  }

  it("is enabled for the first Stage when the action is ready", () => {
    const html = markup({ stageActionReady: true, approvalId: 9 });
    expect(html).toContain(">Stage</button>");
    expect(isDisabled(html)).toBe(false);
  });

  it("stays enabled after a valid Stage so replay can be sent", () => {
    expect(isDisabled(markup({ stageActionReady: true, approvalId: 9 }))).toBe(false);
  });

  it("is disabled when approval is stale or the plan is not ready", () => {
    expect(isDisabled(markup({ stageActionReady: false, approvalId: 9 }))).toBe(true);
  });

  it("is disabled without an approval id, while busy, or while the canvas is dirty", () => {
    expect(isDisabled(markup({ stageActionReady: true, approvalId: null }))).toBe(true);
    expect(isDisabled(markup({ stageActionReady: true, approvalId: 9, busy: true }))).toBe(true);
    expect(isDisabled(markup({ stageActionReady: true, approvalId: 9, dirty: true }))).toBe(true);
  });
});
