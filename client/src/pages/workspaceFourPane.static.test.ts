// IPE-064 — 4-pane workspace static contract. The daily work area is:
// left = pack/chapter tree with select-all, center-top = numbered action
// bar, center = single chapter canvas, right = finding workflow card.
// Intake/ops tooling lives in its own page. Per repo convention (no
// jsdom/RTL) these read the sources.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../../", import.meta.url);
const source = (path: string) => readFileSync(new URL(path, root), "utf8").replace(/\r\n/g, "\n");

describe("IPE-064 — intake separation", () => {
  const page = source("client/src/pages/WorkspacePage.tsx");
  const intake = source("client/src/pages/WorkspaceIntakePage.tsx");
  const app = source("client/src/App.tsx");

  it("registers the intake route and cross-links both pages", () => {
    expect(app).toContain('path={"/workspace/intake"}');
    // IPE-064R4B (P1): the intake link carries the selected workspace so the
    // intake page cannot fall back to the wrong (first) workspace.
    expect(page).toContain("href={`/workspace/intake${selectedWorkspaceId ? `?workspace=${selectedWorkspaceId}` : \"\"}`}");
    expect(page).toContain('params.get("workspace")');
    expect(intake).toContain('href="/workspace"');
  });

  it("moves the import/intake tooling out of WorkspacePage", () => {
    expect(page).not.toContain('data-testid="workspace-ops-advanced"');
    expect(page).not.toContain("Google Sheets Master Intake");
    expect(page).not.toContain("2. เพิ่มตอนใหม่");
    expect(page).not.toContain("bulkImportGoogleDocs");
    expect(page).not.toContain("masterIntakeSync");
    expect(intake).toContain("Google Sheets Master Intake");
    expect(intake).toContain("2. เพิ่มตอนใหม่");
    expect(intake).toContain("bulkImportGoogleDocs");
    expect(intake).toContain("masterIntakeSync");
  });

  it("moves per-pack source imports and ops read models to the intake page", () => {
    expect(page).not.toContain('data-testid="workspace-pack-imports"');
    expect(page).not.toContain("Operations / Advanced");
    expect(page).not.toContain('data-testid="workspace-management-table"');
    expect(intake).toContain('data-testid="intake-pack-imports"');
    expect(intake).toContain("Add / Refresh Google Doc");
    expect(intake).toContain("Operations / Advanced");
  });

  it("retires the Issue Queue, Full Checker vNext and Safe Transform Preview cards", () => {
    expect(page).not.toContain("Issue Queue");
    expect(page).not.toContain("Full Checker vNext");
    expect(page).not.toContain("Safe Transform Preview");
    expect(page).not.toContain("Apply เป็น Draft revision ใหม่");
  });
});

describe("IPE-064 — story gate", () => {
  const page = source("client/src/pages/WorkspacePage.tsx");

  it("shows the story picker first and a back button inside the work area", () => {
    expect(page).toContain("const [storyEntered, setStoryEntered] = useState(false);");
    expect(page).toContain("!storyEntered ? (");
    expect(page).toContain("<WorkspaceStoryOverview");
    expect(page).toContain('data-testid="workspace-back-to-stories"');
    expect(page).toContain("ย้อนกลับ เลือกเรื่อง");
    expect(page).toContain("if (selectStory(storyKey)) setStoryEntered(true);");
  });
});

describe("IPE-064 — the 4-pane work area", () => {
  const page = source("client/src/pages/WorkspacePage.tsx");
  const actionBar = source("client/src/pages/WorkspaceActionBar.tsx");
  const findingActions = source("client/src/pages/WorkspaceFindingActions.tsx");
  const packPanel = source("client/src/pages/WorkspacePackListPanel.tsx");

  it("keeps the three-column master-detail grid", () => {
    expect(page).toContain('data-testid="workspace-master-detail"');
    expect(page).toContain("xl:grid-cols-[minmax(250px,0.65fr)_minmax(0,2.1fr)_minmax(280px,0.85fr)]");
    expect(page).toContain('data-testid="workspace-side-panel"');
  });

  it("pane 1: pack list supports select-all over the active story's packs", () => {
    expect(packPanel).toContain('data-testid="workspace-pack-select-all"');
    expect(packPanel).toContain("เลือกทั้งหมด");
    expect(page).toContain("allSelected={allStoryPacksSelected}");
    expect(page).toContain("onToggleAll={toggleAllStoryPacks}");
    expect(page).toContain("const toggleAllStoryPacks = () =>");
  });

  it("pane 2: the numbered action bar sits above the editor in the center column", () => {
    expect(actionBar).toContain('data-testid="workspace-action-bar"');
    expect(actionBar).toContain("3. ตรวจ");
    expect(actionBar).toContain("4. ยืนยัน");
    expect(actionBar).toContain("5. Stage");
    expect(actionBar).toContain("6. Publish");
    // Scope: selected packs, or the open pack when nothing is selected —
    // intersected with the ACTIVE story (IPE-064R4B P1: no cross-story bulk),
    // with the open-pack fallback applied after the intersection.
    expect(page).toContain("const intersectedBulkSelection = rawBulkSelection.filter((workItemId: number) =>");
    expect(page).toContain("storySelectableWorkItemIds.includes(workItemId)");
    expect(page).toContain("<WorkspaceActionBar");
    // Bar is inside the center column, before the main editor card.
    const center = page.indexOf('className="min-w-0 space-y-3"');
    const bar = page.indexOf("<WorkspaceActionBar");
    const editor = page.indexOf('data-testid="workspace-main-editor"');
    expect(bar).toBeGreaterThan(center);
    expect(editor).toBeGreaterThan(bar);
    // Bulk endpoints are unchanged.
    expect(page).toContain("bulkRunEditorialChecker.mutate");
    expect(page).toContain("bulkApproveEditorialDrafts.mutate");
    expect(page).toContain("bulkStageEditorialDrafts.mutate");
    expect(page).toContain("bulkRequestEditorialPublish.mutate");
  });

  it("pane 3: the center stays the single ChapterEditorCanvas surface", () => {
    expect(page).toContain('data-testid="workspace-main-editor"');
    expect((page.match(/<ChapterEditorCanvas/g) ?? []).length).toBe(1);
    expect(page).toContain('data-testid="workspace-chapter-editor-empty"');
    expect(page).toContain('data-testid="workspace-pack-secondary"');
    // The canvas appears before the collapsed secondary pack metadata.
    expect(page.indexOf('data-testid="workspace-pack-secondary"')).toBeGreaterThan(
      page.indexOf('data-testid="workspace-main-editor"')
    );
  });

  it("pane 4: the finding workflow card owns go-to-issue / skip / allow / note / save", () => {
    expect(findingActions).toContain('data-testid="workspace-finding-actions"');
    expect(findingActions).toContain("ไปจุดต้องแก้ไข");
    expect(findingActions).toContain("ข้าม");
    expect(findingActions).toContain("เพิ่มอนุญาต");
    expect(findingActions).toContain("ยืนยันหมายเหตุจากผู้เขียน");
    expect(findingActions).toContain("บันทึก Draft");
    expect(page).toContain("<WorkspaceFindingActions");
    // Reuses the same guarded mutations as before (no new authority).
    expect(page).toContain('disposition: "ignored"');
    expect(page).toContain("allowEditorialFinding.mutate");
    expect(page).toContain("setStructuralConfirmation.mutate");
    expect(page).toContain("unallowEditorialWord.mutate");
    expect(page).toContain("onSave={submitChapterEditorEdit}");
  });

  it("pane 4 keeps the compact review summary as the counters strip", () => {
    expect(page).toContain("<WorkspaceReviewSummaryPanel");
  });

  it("refreshes the outline read model after every draft revision (IPE-064R4B)", () => {
    expect(page).toContain("editorialSourceDraftOutline.refetch()");
    // The revision-changing flows: save rebind, tab exclude/restore, undo.
    const saveBlock = page.slice(
      page.indexOf("const [sourceDraftResult] = await Promise.all(["),
      page.indexOf("]);", page.indexOf("const [sourceDraftResult] = await Promise.all(["))
    );
    expect(saveBlock).toContain("editorialSourceDraftOutline.refetch()");
    const undoBlock = page.slice(
      page.indexOf("const undoEditorialEdit = trpc.workspace.editorial.editorUndo.useMutation({"),
      page.indexOf("const approveEditorialDraft = trpc.workspace.editorial.approveDraft.useMutation({")
    );
    expect(undoBlock).toContain("editorialSourceDraftOutline.refetch()");
    expect(page).toContain("editorialSourceDraftOutline.refetch(),\n    ]);");
  });
});

describe("IPE-064R3 — workspace context & navigation", () => {
  const page = source("client/src/pages/WorkspacePage.tsx");
  const packPanel = source("client/src/pages/WorkspacePackListPanel.tsx");

  it("restores story/pack/chapter from the URL and keeps it in sync", () => {
    expect(page).toContain('params.get("story")');
    expect(page).toContain('params.get("chapter")');
    // IPE-064R4B (P2): the context belongs to a workspace — retry restore
    // after switching to the workspace that owns the story.
    expect(page).toContain('params.get("workspace")');
    expect(page).toContain('params.set("workspace", String(selectedWorkspaceId ?? ""))');
    expect(page).toContain("updateStoryUiState(states, storyParam");
    expect(page).toContain('params.set("story", activeStoryKey)');
    expect(page).toContain("window.history.replaceState");
    // Restore consumes the params exactly once, before the writer starts.
    expect(page).toContain("const urlRestoreAppliedRef = useRef(false);");
    expect(page).toContain("if (!urlRestoreAppliedRef.current) return;");
  });

  it("offers a quick story switcher in the header (guarded by the dirty check)", () => {
    expect(page).toContain('data-testid="workspace-story-switcher"');
    expect(page).toContain("if (selectStory(event.target.value)) setStoryEntered(true);");
  });

  it("jumps to the next needs-fix pack and auto-expands the selected pack", () => {
    expect(page).toContain('derivePackStatus(card.evidence) === "needs_fix"');
    expect(page).toContain("onJumpToPack={(workItemId) => {");
    expect(packPanel).toContain('data-testid="workspace-next-needs-fix-pack"');
    expect(packPanel).toContain("selectedRowKey");
    expect(packPanel).toContain("setExpandedPackIds((current) =>");
  });
});
