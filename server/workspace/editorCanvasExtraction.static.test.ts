// IPE-062R4A — editor canvas extraction static contract. Pins the
// three-pane editor surface: a pure navigation rail, ONE central canvas
// owning the active editor, and a QC/assistance rail. Per repo convention
// (no jsdom/RTL) these read the sources.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../", import.meta.url);
const source = (path: string) => readFileSync(new URL(path, root), "utf8").replace(/\r\n/g, "\n");

const page = source("client/src/pages/WorkspacePage.tsx");

function sliceBetween(startMarker: string, endMarker: string) {
  const start = page.indexOf(startMarker);
  const end = page.indexOf(endMarker, start + 1);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return page.slice(start, end);
}

describe("IPE-062R4A — three-pane editor surface", () => {
  const navigator = sliceBetween(
    'data-testid="workspace-chapter-list-pane"',
    'data-testid="workspace-chapter-editor-pane"'
  );
  // IPE-062R4C: the assist rail moved to the OUTER right panel, so the
  // canvas pane slice runs to the stage panel that follows the editor.
  const canvasPane = sliceBetween(
    'data-testid="workspace-chapter-editor-pane"',
    '<div className={packDetailTab === "stage"'
  );
  const assist = page.slice(page.indexOf('data-testid="workspace-assist-pane"'));

  it("A. renders the tab navigator as a pure selector (no editor textarea inside)", () => {
    expect(navigator).not.toContain("<textarea");
    expect(navigator).not.toContain("ChapterEditorCanvas");
    expect(navigator).not.toContain("workspace-chapter-editor-canvas");
    // Navigator keeps navigation data: titles, status chips, issue counts.
    expect(navigator).toContain("แท็บใน Draft");
    expect(navigator).toContain("chapterEditorStatusByTab.get(tab.sourceTabId)");
    expect(navigator).toContain("คำต่างประเทศ");
    expect(navigator).toContain("structural issue");
    expect(navigator).toContain("openChapterEditor(tab)");
  });

  it("B. renders the selected chapter's editor in the central canvas at full remaining width", () => {
    expect(canvasPane).toContain("<ChapterEditorCanvas");
    // The canvas component itself carries the editing textarea (defined once
    // at module level, invoked exactly here).
    const canvasComponent = page.slice(
      page.indexOf("function ChapterEditorCanvas"),
      page.indexOf("export default function WorkspacePage")
    );
    expect(canvasComponent).toContain('id="workspace-chapter-editor-canvas"');
    expect(canvasPane).toContain("chapterEditorTarget.title");
    // IPE-062R4C: the inner editor split is TWO columns — a bounded
    // navigator rail and the editor taking ALL remaining width (min-w-0,
    // no fixed assist column inside the Episode Pack Detail).
    expect(page).toContain("xl:grid-cols-[minmax(200px,240px)_minmax(0,1fr)]");
    const editorPaneOpen = page.indexOf('data-testid="workspace-chapter-editor-pane"');
    const editorPaneLine = page.slice(page.lastIndexOf("<div", editorPaneOpen), editorPaneOpen);
    expect(editorPaneLine).toContain("min-w-0");
  });

  it("B2. the editor split has exactly TWO direct columns and the assist rail lives in the outer right panel", () => {
    // Codex P1 + staging acceptance regression: a third assist column nested
    // inside the Episode Pack Detail squeezed the canvas back to a narrow
    // column. Pin the structure directly:
    const lines = page.split("\n");
    const balanceFrom = (marker: string) => {
      const open = lines.findIndex((l) => l.includes(marker));
      let bal = 0;
      for (let i = open; i < lines.length; i++) {
        const l = lines[i];
        bal +=
          (l.match(/<div\b/g) ?? []).length -
          (l.match(/<div\b[^>]*\/>/g) ?? []).length -
          (l.match(/<\/div>/g) ?? []).length;
        if (bal === 0) return { open: open + 1, close: i + 1 };
      }
      return null;
    };
    const split = balanceFrom('data-testid="workspace-editor-split"');
    const editor = balanceFrom('data-testid="workspace-chapter-editor-pane"');
    const navigator = balanceFrom('data-testid="workspace-chapter-list-pane"');
    const assist = balanceFrom('data-testid="workspace-assist-pane"');
    const sidePanel = page.indexOf('data-testid="workspace-side-panel"');
    expect(split).not.toBeNull();
    expect(editor).not.toBeNull();
    expect(navigator).not.toBeNull();
    expect(assist).not.toBeNull();
    // Both inner panes close INSIDE the split (direct children)...
    expect(editor!.close).toBeLessThan(split!.close);
    expect(navigator!.close).toBeLessThan(split!.close);
    // ...and the assist pane is NOT a third child: it opens after the whole
    // split closed, inside the outer side panel.
    expect(assist!.open).toBeGreaterThan(split!.close);
    const sidePanelLine = page
      .slice(0, page.indexOf('data-testid="workspace-side-panel"'))
      .split("\n").length;
    expect(sidePanelLine).toBeGreaterThan(0);
    expect(assist!.open).toBeGreaterThan(sidePanelLine);
    // No second nested grid template inside the Episode Pack Detail.
    expect(page).not.toContain("minmax(260px,0.9fr)]\" data-testid=\"workspace-assist-pane\"");
  });

  it("C. keeps exactly ONE active editor surface (no per-tab editors mounted)", () => {
    // The canvas is the only full-content editor: the central pane renders no
    // raw <textarea> other than the canvas component itself, and the legacy
    // per-tab paragraph-tools block is gone.
    expect((canvasPane.match(/<textarea/g) ?? []).length).toBe(0);
    expect(page).not.toContain("เครื่องมือแก้ไขรายย่อหน้า");
    // Canvas component is invoked exactly once.
    expect((page.match(/<ChapterEditorCanvas/g) ?? []).length).toBe(1);
    // The editor renders only when a single chapterEditorTarget exists.
    expect(page).toContain("chapterEditorTarget ? (");
    expect(page).toContain('data-testid="workspace-chapter-editor-empty"');
  });

  it("D. switching chapters updates the canvas through the existing open path", () => {
    // Navigator buttons, prev/next, and the issue-first jump all route
    // through openChapterEditor — one owner of the active target.
    expect(navigator).toContain("openChapterEditor(tab)");
    expect(navigator).toContain("openChapterEditor(nextIssueChapterTab)");
    expect(canvasPane).toContain("previousChapterTab && openChapterEditor(previousChapterTab)");
    expect(canvasPane).toContain("nextChapterTab && openChapterEditor(nextChapterTab)");
    // Dirty guard still lives in openChapterEditor.
    expect(page).toContain("มีการแก้ไขที่ยังไม่ได้บันทึก ต้องการทิ้งการแก้ไขแล้วเปิดแท็บอื่นหรือไม่?");
  });

  it("E. dirty chapter switches use the guard before disposing (no silent discard)", () => {
    // Same confirmation boundary for story and pack switches.
    expect(page).toContain("ต้องการทิ้งการแก้ไขแล้วเปลี่ยนเรื่องหรือไม่?");
    expect(page).toContain("ต้องการทิ้งการแก้ไขแล้วเปลี่ยนแพ็กหรือไม่?");
    expect(page).toContain("discardChapterEditorForContextSwitch");
  });

  it("F. Cancel keeps the original editor (guard returns false before any state change)", () => {
    // The guard must return BEFORE clearing target/paragraphs when declined.
    const guard = page.slice(
      page.indexOf("const discardChapterEditorForContextSwitch"),
      page.indexOf("const selectStory =")
    );
    expect(guard).toContain("if (dirty && !window.confirm(message)) return false;");
    expect(guard.indexOf("return false")).toBeGreaterThan(-1);
    expect(guard).toContain("setChapterEditorTarget(undefined)");
    // selectPackForActiveStory only selects after the guard passes.
    const selectPack = page.slice(
      page.indexOf("const selectPackForActiveStory"),
      page.indexOf("const selectPackAcrossStories")
    );
    expect(selectPack.indexOf("return false")).toBeLessThan(selectPack.indexOf("setSelectedSourceWorkItemId(workItemId)"));
  });

  it("G. save + autosave use the active editor identity (R3 invariant intact)", () => {
    expect((page.match(/editorDraftBelongsToSelectedPack\(/g) ?? []).length).toBe(2);
    expect(page).toContain('submitEditorEdit("autosave")');
    expect(page).toContain("Editor นี้เปิดจากแพ็กอื่น");
    // Canvas save button submits the active canvas editor.
    expect(canvasPane).toContain("onClick={submitChapterEditorEdit}");
  });

  it("H. QC/finding data follows the active chapter from the outer right rail", () => {
    // IPE-062R4C: assist content renders in the outer side panel, not as a
    // nested third column inside the Episode Pack Detail.
    const sidePanel = page.indexOf('data-testid="workspace-side-panel"');
    const assistStart = page.indexOf('data-testid="workspace-assist-pane"');
    expect(sidePanel).toBeGreaterThan(-1);
    expect(assistStart).toBeGreaterThan(sidePanel);
    expect(assist).toContain("Issue Queue · {chapterEditorIssueItems.length}");
    expect(assist).toContain("chapterEditorIssueItems.map");
    expect(assist).toContain("navigateRelativeChapterEditorIssue");
    expect(assist).toContain("Safe Transform Preview");
    expect(assist).toContain("Full Checker vNext");
    // Finding quick-edit cards stay in the rail (never inside tab cards).
    expect(assist).toContain("editorTarget && !editorTarget.findingId");
  });

  it("I. R3 pack-switch + story-switch guards remain wired", () => {
    expect(page).toContain("onSelectPack={selectPackForActiveStory}");
    expect(page).toContain("if (storyKey === activeStoryKey) return selectPackForActiveStory(card.workItemId);");
    expect(page).toContain("onFocusStory={selectStory}");
  });
});
