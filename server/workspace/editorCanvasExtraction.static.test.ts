// IPE-062R4A/R4D — editor-first workspace static contract. The center pane
// IS the main chapter editor; the pack/chapter navigator is a selector tree;
// QC/workflow actions live only in the right rail. Per repo convention (no
// jsdom/RTL) these read the sources.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../", import.meta.url);
const source = (path: string) => readFileSync(new URL(path, root), "utf8").replace(/\r\n/g, "\n");

const page = source("client/src/pages/WorkspacePage.tsx");
const packPanel = source("client/src/pages/WorkspacePackListPanel.tsx");

function sliceBetween(startMarker: string, endMarker: string) {
  const start = page.indexOf(startMarker);
  const end = page.indexOf(endMarker, start + 1);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return page.slice(start, end);
}

describe("IPE-062R4D — editor-first center surface", () => {
  const mainEditor = page.slice(page.indexOf('data-testid="workspace-main-editor"'));

  it("A. Episode Pack Detail shell and its tabs are no longer the primary center navigation", () => {
    expect(page).not.toContain('>Episode Pack Detail</h2>');
    expect(page).not.toContain('data-testid="pack-detail-tabs"');
    expect(page).not.toContain('data-testid="pack-detail-tab-editor"');
    // The redundant Workspace Editor wrapper heading is gone too.
    expect(page).not.toContain("Workspace Editor ·");
    expect(page).not.toContain("workspace-editor-split");
  });

  it("B. the center is the ChapterEditorCanvas as the primary surface", () => {
    expect(page).toContain('data-testid="workspace-main-editor"');
    expect(mainEditor.indexOf("<ChapterEditorCanvas")).toBeGreaterThan(-1);
    expect(mainEditor).toContain("chapterEditorTarget.title");
    const canvasComponent = page.slice(
      page.indexOf("function ChapterEditorCanvas"),
      page.indexOf("export default function WorkspacePage")
    );
    expect(canvasComponent).toContain('id="workspace-chapter-editor-canvas"');
    // Full-width editing: no fixed-width grid wraps the canvas anymore.
    expect(page).not.toContain("minmax(260px,0.9fr)]\" data-testid=");
  });

  it("C. the canvas appears BEFORE secondary pack metadata in source order", () => {
    const editorIdx = page.indexOf('data-testid="workspace-main-editor"');
    const secondaryIdx = page.indexOf('data-testid="workspace-pack-secondary"');
    expect(editorIdx).toBeGreaterThan(-1);
    expect(secondaryIdx).toBeGreaterThan(editorIdx);
    // Source/Latest Draft/Refresh cards live in the collapsed secondary block.
    const secondary = page.slice(secondaryIdx);
    expect(secondary).toContain("md:grid-cols-3");
    expect(secondary).toContain("Refresh safety");
  });

  it("F. exactly ONE ChapterEditorCanvas is mounted, gated on the single target", () => {
    expect((page.match(/<ChapterEditorCanvas/g) ?? []).length).toBe(1);
    expect(page).toContain("chapterEditorTarget ? (");
    expect(page).toContain('data-testid="workspace-chapter-editor-empty"');
  });

  it("G. the navigator (pack/chapter tree) never renders an editor textarea", () => {
    expect(packPanel).not.toContain("<textarea");
    expect(packPanel).not.toContain("ChapterEditorCanvas");
    expect(packPanel).toContain('data-testid="workspace-chapter-row"');
    expect(packPanel).toContain('data-testid="workspace-pack-expand"');
  });

  it("N. collapsed packs mount no editor and no chapter rows (metadata-only tree)", () => {
    // Chapter rows render only for the expanded AND selected pack.
    expect(packPanel).toContain("const showChapters = expanded && selected && workItemId != null && !!chapters?.length;");
    // Rows carry navigation metadata only.
    expect(packPanel).toContain("chapter.foreignFindingCount");
    expect(packPanel).toContain("chapter.structuralIssueCount");
    expect(packPanel).toContain('เติมเนื้อหา');
  });
});

describe("IPE-062R4D — pack/chapter tree navigation", () => {
  it("D. pack rows expand/collapse and chapter rows appear under the expanded pack", () => {
    expect(packPanel).toContain("expandedPackIds");
    expect(packPanel).toContain('aria-expanded={expanded}');
    expect(packPanel).toContain('data-testid="workspace-pack-chapters"');
    // Expanding a non-selected pack selects it first so its tabs load.
    expect(packPanel).toContain("if (!selected && workItemId != null) onSelectPack(workItemId);");
  });

  it("E. chapter row click routes to the single active editor (no extra open button)", () => {
    // One click: openChapterEditor — the dirty guard lives inside it.
    expect(page).toContain("onSelectChapter={(row) => {");
    expect(page).toContain("if (tab) openChapterEditor(tab);");
    // The old per-row เปิด Editor button is gone from the tree rows.
    expect(packPanel).not.toContain('">เปิด Editor</Button>');
  });

  it("M. selected pack + selected chapter state stay wired", () => {
    expect(page).toContain("activeChapterTabId={chapterEditorTarget?.sourceTabId ?? null}");
    // IPE-064R3: the tree renders from the light outline rows.
    expect(page).toContain("chapters={packTreeChapters}");
  });

  it("M2. the outer master-detail grid keeps exactly THREE direct columns (no 4th child spill)", () => {
    // Staging regression: the chapter tools card was a direct grid child, so
    // the outer 3-column grid flowed [tree][tools][editor-squeezed-to-280px]
    // and pushed the side panel to a second row. The tree and the tools card
    // must share ONE wrapper div as the single left-column child.
    const lines = page.split("\n");
    const ternary = lines.findIndex((l) => l.includes("{activeStoryGroup ? ("));
    expect(ternary).toBeGreaterThan(-1);
    // The first thing in the true branch is a wrapper div, not a bare
    // fragment (a fragment would make the tools card a 4th grid child).
    expect(lines[ternary + 1].trim()).toBe('<div className="space-y-3">');
    const gridChar = page.indexOf('data-testid="workspace-master-detail"');
    expect(gridChar).toBeGreaterThan(-1);
    const gridSlice = page.slice(gridChar, page.indexOf("</main>", gridChar));
    // No stray fragment close between the panel invocation and the tools card.
    const panelIdx = gridSlice.indexOf("<WorkspacePackListPanel");
    const toolsIdx = gridSlice.indexOf('data-testid="workspace-chapter-tools"');
    expect(panelIdx).toBeGreaterThan(-1);
    expect(toolsIdx).toBeGreaterThan(panelIdx);
    expect(gridSlice.slice(panelIdx, toolsIdx)).not.toContain("</>");
  });
});

describe("IPE-062R4D — guards and invariants (R3/R4A preserved)", () => {
  it("H. dirty chapter switching uses the existing guard", () => {
    expect(page).toContain("มีการแก้ไขที่ยังไม่ได้บันทึก ต้องการทิ้งการแก้ไขแล้วเปิดแท็บอื่นหรือไม่?");
  });

  it("I. dirty pack/story switching uses the context-switch guards", () => {
    expect(page).toContain("discardChapterEditorForContextSwitch");
    expect(page).toContain("ต้องการทิ้งการแก้ไขแล้วเปลี่ยนแพ็กหรือไม่?");
    expect(page).toContain("ต้องการทิ้งการแก้ไขแล้วเปลี่ยนเรื่องหรือไม่?");
  });

  it("J. save identity invariant enforced in the canvas save path", () => {
    // IPE-064: the finding quick-editor (and its autosave path) retired —
    // the canvas save is the single guarded submit.
    expect((page.match(/editorDraftBelongsToSelectedPack\(/g) ?? []).length).toBe(1);
    expect(page).toContain("Editor นี้เปิดจากแพ็กอื่น");
  });
});

describe("IPE-062R4E — highlight visibility + go-to-issue CTA", () => {
  it("O. the canvas textarea auto-grows so highlights never clip or desync", () => {
    // Fixed-height textarea clips the highlight overlay (absolute inset-0)
    // and desyncs it while the textarea scrolls internally. The canvas now
    // grows with its content; the editor container is the single scroller.
    const canvasComponent = page.slice(
      page.indexOf("function ChapterEditorCanvas"),
      page.indexOf("export default function WorkspacePage")
    );
    expect(canvasComponent).toContain("textarea.style.height = `");
    expect(canvasComponent).toContain("scrollHeight");
    // No internal textarea scroll height remains as a cap.
    expect(canvasComponent).not.toContain("max-h-[48rem] overflow-y-auto");
  });

  it("P. go-to-issue scroll uses an explicit container scroll after focus", () => {
    // focus() alone does not scroll ancestor containers — the mirror-based
    // helper measures the caret line and scrolls the editor container.
    expect(page).toContain("const scrollChapterCanvasCaretIntoView");
    expect(page).toContain("scrollChapterCanvasCaretIntoView(start, true)");
    expect(page).toContain("container.scrollTo({ top: target");
  });

  it("Q. the fix_findings CTA is actionable and jumps to the current finding", () => {
    // The toolbar no longer hard-disables fix_findings; the page wires the
    // jump to navigateChapterEditorIssue.
    const toolbar = source("client/src/pages/WorkspaceEditorialToolbar.tsx");
    expect(toolbar).toContain("onGoToIssue?: () => void;");
    expect(toolbar).toContain('(action.kind === "fix_findings" && !onGoToIssue)');
    expect(toolbar).toContain("case \"fix_findings\":\n        onGoToIssue?.();");
    expect(page).toContain("onGoToIssue={() => {");
    expect(page).toContain("navigateChapterEditorIssue(");
  });

  it("R. quick-skip (Ignore) sits beside the findings CTA and reuses the guarded resolve mutation", () => {
    // IPE-062R4F: move names / proper nouns are not defects — the operator
    // ignores the current finding and advances without leaving the editor.
    const toolbar = source("client/src/pages/WorkspaceEditorialToolbar.tsx");
    expect(toolbar).toContain("ข้าม (Ignore)");
    expect(toolbar).toContain("onIgnoreIssue");
    expect(page).toContain('onIgnoreIssue={() => {');
    expect(page).toContain('disposition: "ignored"');
    expect(page).toContain("idempotencyKey: `editorial-ignore:${finding.id}:${finding.resolutionVersion ?? 0}`");
    // Ignoring advances to the next issue (skip, not just dismiss).
    const handler = page.slice(
      page.indexOf("onIgnoreIssue={() => {"),
      page.indexOf("ignorePending={resolveEditorialFinding.isPending}")
    );
    expect(handler).toContain("navigateRelativeChapterEditorIssue(1)");
    // Only open findings are ignored; structural issues keep their own flow.
    expect(handler).toContain('issue.kind !== "finding"');
    expect(handler).toContain('finding.disposition !== "open"');
  });
});

describe("IPE-062R4D — right rail is the single workflow authority", () => {
  const sidePanel = page.slice(page.indexOf('data-testid="workspace-side-panel"'));

  it("K. the finding workflow card lives in the right rail; the retired preview cards are gone", () => {
    // IPE-064: Issue Queue / Full Checker / Safe Transform previews were
    // retired; the rail hosts the compact summary + finding actions card.
    expect(sidePanel).toContain("<WorkspaceFindingActions");
    expect(sidePanel).toContain("<WorkspaceReviewSummaryPanel");
    expect(page).not.toContain("Issue Queue");
    expect(page).not.toContain("Full Checker vNext");
    expect(page).not.toContain("Safe Transform Preview");
  });

  it("L. Stage/Publish primary controls live in the action bar, not duplicated in the rail", () => {
    // IPE-064: the numbered workflow bar (3.ตรวจ / 4.ยืนยัน / 5.Stage /
    // 6.Publish) sits above the center editor and replaces the old rail
    // sections; the center secondary block never carries workflow actions.
    const actionBar = source("client/src/pages/WorkspaceActionBar.tsx");
    expect(actionBar).toContain("5. Stage");
    expect(actionBar).toContain("6. Publish");
    expect(page).not.toContain('data-testid="workspace-stage-section"');
    expect(page).not.toContain('data-testid="workspace-publish-section"');
    const center = page.slice(
      page.indexOf('data-testid="workspace-main-editor"'),
      page.indexOf('data-testid="workspace-side-panel"')
    );
    expect(center).not.toContain("bulkRequestEditorialPublish");
    expect(center).not.toContain("stageEditorialEpisode.mutate");
  });
});
