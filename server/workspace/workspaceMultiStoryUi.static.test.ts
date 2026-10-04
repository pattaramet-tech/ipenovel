// IPE-062 — multi-story workspace UI static contract. Pins the new
// master-detail structure: story overview cards, per-story pack list,
// compact review summary, primary workflow actions, the in-place editor
// split (chapter list beside the canvas), and the collapsed advanced
// tooling. Per repo convention (no jsdom/RTL) these read the sources.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../", import.meta.url);
const source = (path: string) => readFileSync(new URL(path, root), "utf8").replace(/\r\n/g, "\n");

const page = source("client/src/pages/WorkspacePage.tsx");
const overview = source("client/src/pages/WorkspaceStoryOverview.tsx");
const packList = source("client/src/pages/WorkspacePackListPanel.tsx");
const summary = source("client/src/pages/WorkspaceReviewSummaryPanel.tsx");
const rowMenu = source("client/src/pages/EditorialPackRowActionsMenu.tsx");
const model = source("client/src/pages/workspaceMultiStory.ts");

describe("IPE-062 multi-story state model", () => {
  it("keeps per-story UI state in an isolated record (pack/chapter/tab/filter)", () => {
    expect(model).toContain("interface StoryUiState");
    expect(model).toContain("packWorkItemId: number | null");
    expect(model).toContain("chapterSourceTabId: string | null");
    expect(model).toContain("activeTab: StoryPackTab");
    expect(model).toContain("issuesOnly: boolean");
    expect(model).toContain("export function updateStoryUiState");
    // Updates are immutable per key — a story switch cannot leak state.
    expect(model).toContain("resolveStoryUiState(states, storyKey)");
  });

  it("derives pack and story status only from the durable board evidence", () => {
    expect(model).toContain("export function derivePackStatus");
    expect(model).toContain('if (evidence.available === false) return "anomalous"');
    expect(model).toContain("export function storyOverallStatus");
    // No new readiness source: the summary consumes evidence the board loads.
    expect(page).toContain("summarizeStoryPacks(group.cards)");
  });

  it("seeds the daily story model from bound novels so zero-pack stories remain focusable (IPE-062R3 P2-A)", () => {
    // The grouping is pure and unit-tested in workspaceMultiStory.test.ts
    // (story with packs / without packs / NEW_STORY-only / mixed / filtering).
    expect(model).toContain("export function groupStoriesByNovel");
    expect(model).toContain("for (const { workspaceNovel, novel } of boundNovels)");
    // Cards with a missing workspaceNovelId still merge into their novel's
    // seeded group via the novel-id alias.
    expect(model).toContain(
      "const aliasKey = Number.isFinite(novelId) ? aliasByNovelId.get(novelId) : undefined;"
    );
    // The overview groups the COMPLETE unfiltered board (IPE-064: the legacy
    // filtered management-table projection was retired).
    expect(page).toContain("groupStoriesByNovel(editorialCards, workspaceNovelOptions as any[])");
  });

  it("enforces the editor save-identity invariant at runtime (IPE-062R3 P2-B)", () => {
    // Pure invariant, unit-tested (match / mismatch / missing identity).
    expect(model).toContain("export function editorDraftBelongsToSelectedPack");
    expect(model).toContain("if (targetDraftId == null || selectedLatestDraftId == null) return false;");
    // IPE-064: the canvas save is the single guarded path — a pack switch
    // must never submit the old draft under the new pack's work item.
    const chapterEdit = page.slice(
      page.indexOf("const submitChapterEditorEdit = () => {"),
      page.indexOf("idempotencyKey: `editor-tab:")
    );
    expect(chapterEdit).toContain("editorDraftBelongsToSelectedPack(");
    expect(chapterEdit).toContain("Editor นี้เปิดจากแพ็กอื่น");
  });
});

describe("IPE-062 story overview cards", () => {
  it("renders one card per story with an overall badge and focus control", () => {
    expect(overview).toContain('data-testid="workspace-story-overview"');
    expect(overview).toContain('data-testid="workspace-story-cards"');
    expect(overview).toContain('data-testid="workspace-story-card"');
    expect(overview).toContain('data-testid="workspace-story-overall"');
    expect(overview).toContain('data-testid="workspace-story-focus"');
    expect(overview).toContain("STORY_OVERALL_LABEL[story.overall]");
    // The focused story is visually pinned.
    expect(overview).toContain('data-focused={story.focused ? "true" : undefined}');
  });

  it("shows the numbered workflow strip (เลือกแพ็ก → Publish)", () => {
    expect(overview).toContain('data-testid="workflow-steps"');
    expect(overview).toContain('"เลือกแพ็ก / ตอน"');
    expect(overview).toContain('"ยืนยัน Draft"');
    expect(overview).toContain('"Stage"');
    expect(overview).toContain('"Publish"');
  });
});

describe("IPE-062 story pack list panel", () => {
  it("searches, badges, and selects packs for the focused story only", () => {
    expect(packList).toContain('data-testid="workspace-pack-list-panel"');
    expect(packList).toContain('aria-label="ค้นหาแพ็กในเรื่องนี้"');
    expect(packList).toContain('data-testid="workspace-pack-row"');
    expect(packList).toContain('data-testid="workspace-pack-status"');
    expect(packList).toContain("STORY_PACK_STATUS_LABEL[status]");
    expect(packList).toContain("filterPacksByQuery(packs, query)");
    expect(packList).toContain("sortPacksByEpisode");
    // Row click selects the pack (detail + queries follow the selection).
    expect(packList).toContain("onSelectPack(workItemId)");
  });

  it("keeps bulk checkboxes and the shared guarded actions menu", () => {
    expect(packList).toContain("bulkSelectedWorkItemIds.has(workItemId)");
    expect(packList).toContain("<EditorialPackRowActionsMenu");
  });
});

describe("IPE-062 shared pack row actions menu", () => {
  it("preserves the IPE-058-F editor-open chain and its null guard", () => {
    expect(rowMenu).toContain('data-testid="editorial-row-actions"');
    expect(rowMenu).toContain("เปิด Editor (ตอนถัดไปที่มีปัญหา)");
    expect(rowMenu).toContain("disabled={!card.workItemId}");
  });

  it("keeps the pre-Draft sale guard verbatim", () => {
    expect(rowMenu).toContain("แก้การขาย");
    expect(rowMenu).toContain(
      '!card.evidence?.published || card.evidence?.publishedSource === "published_episode"'
    );
  });

  it("guards the destructive remove action for cards without a work item", () => {
    expect(rowMenu).toContain("text-destructive hover:bg-destructive/10");
    expect(rowMenu).toContain("disabled={!card.workItemId || removePending}");
    expect(rowMenu).toContain("ออกจาก Workspace หรือไม่?");
  });

  it("supports durable note editing from the menu", () => {
    expect(rowMenu).toContain("แก้หมายเหตุ");
    expect(rowMenu).toContain("disabled={!card.workItemId || !card.workItemVersion || editNotePending}");
  });
});

describe("IPE-062 compact review summary panel", () => {
  it("shows the four counters, an issues-only toggle, and collapsed issue groups", () => {
    expect(summary).toContain('data-testid="workspace-review-summary"');
    expect(summary).toContain('data-testid="workspace-review-counters"');
    expect(summary).toContain('data-testid="workspace-review-issues-toggle"');
    expect(summary).toContain("แสดงเฉพาะที่มีปัญหา");
    expect(summary).toContain('data-testid="workspace-review-issues"');
    expect(summary).toContain('data-testid="workspace-review-issue-row"');
    // Long finding lists never render expanded by default.
    expect(summary).toContain("<details");
    // Counters map to the checker evidence state machine.
    expect(summary).toContain('chapter.progressState === "pending"');
    expect(summary).toContain("anomalyCount");
    expect(summary).toContain("ยังไม่ตรวจ");
  });
});

describe("IPE-062 primary workflow actions", () => {
  it("exposes the flow บันทึก+ตรวจ → ยืนยัน → Stage → Publish with the existing handlers", () => {
    // IPE-064: WorkspaceWorkflowActions was retired — the numbered flow runs
    // through the sticky toolbar CTA and the bulk action bar.
    const actionBar = source("client/src/pages/WorkspaceActionBar.tsx");
    expect(actionBar).toContain('data-testid="workspace-action-bar"');
    expect(actionBar).toContain("4. ยืนยัน");
    expect(actionBar).toContain("5. Stage");
    expect(actionBar).toContain("6. Publish");
    expect(page).toContain("บันทึก Draft + ตรวจซ้ำ");
    expect(page).toContain("onConfirm={submitApprovalConfirm}");
    expect(page).toContain("onStage={submitStageDraft}");
  });

  it("wires the side panel to the same save boundary as the toolbar", () => {
    expect(page).toContain('data-testid="workspace-side-panel"');
    expect(page).toContain("<WorkspaceReviewSummaryPanel");
    // IPE-064: WorkspaceWorkflowActions was retired; the finding actions
    // card carries the save-draft boundary instead.
    expect(page).toContain("<WorkspaceFindingActions");
    expect(page).toContain("onSave={submitChapterEditorEdit}");
  });
});

describe("IPE-062R4D editor-first center (supersedes the in-place split)", () => {
  it("hosts the chapter editor directly in the center with an empty-selection hint", () => {
    // The R4A inner split (chapter list | canvas) is superseded: the chapter
    // navigator is the pack/chapter tree in the left rail.
    expect(page).toContain('data-testid="workspace-main-editor"');
    expect(page).toContain('data-testid="workspace-chapter-editor-pane"');
    expect(page).not.toContain('data-testid="workspace-editor-split"');
    expect(page).toContain('data-testid="workspace-chapter-editor-empty"');
    expect(page).toContain("Editor จะเปิดในพื้นที่นี้ทันที ไม่ต้องเลื่อนหา");
  });

  it("collapses pack import sources out of the editor surface (moved to intake, IPE-064)", () => {
    expect(page).not.toContain('data-testid="workspace-pack-imports"');
    const intakeSource = source("client/src/pages/WorkspaceIntakePage.tsx");
    expect(intakeSource).toContain('data-testid="intake-pack-imports"');
    // The collapsed secondary pack metadata still sits AFTER the main editor.
    const editorStart = page.indexOf('data-testid="workspace-main-editor"');
    const secondaryStart = page.indexOf('data-testid="workspace-pack-secondary"');
    expect(secondaryStart).toBeGreaterThan(editorStart);
  });
});

describe("IPE-062 page-level multi-story wiring", () => {
  it("owns per-story state and restores it on story switch", () => {
    expect(page).toContain("const [selectedStoryKey, setSelectedStoryKey] = useState<string | null>(null);");
    expect(page).toContain("const [storyUiStates, setStoryUiStates] = useState<Record<string, StoryUiState>>({});");
    expect(page).toContain("updateStoryUiState(states, activeStoryKey");
    expect(page).toContain("pendingChapterRestoreRef.current");
    // Switching stories re-opens the remembered chapter once tabs arrive.
    expect(page).toContain("openChapterEditor(targetTab)");
    // Switching with unsaved canvas edits asks before discarding.
    expect(page).toContain("ต้องการทิ้งการแก้ไขแล้วเปลี่ยนเรื่องหรือไม่?");
  });

  it("scopes the pack list to the active story's packs", () => {
    expect(page).toContain("const activeStoryPacks = activeStoryGroup ? activeStoryGroup.cards : [];");
    expect(page).toContain("packs={activeStoryPacks}");
    expect(page).toContain("<WorkspaceStoryOverview");
    // IPE-064: focusing a story from the overview enters the work area.
    expect(page).toContain("if (selectStory(storyKey)) setStoryEntered(true);");
  });

  it("guards same-story pack switches before changing the selected work item", () => {
    expect(page).toContain("const selectPackForActiveStory = (workItemId: number) => {");
    expect(page).toContain("if (workItemId === selectedSourceWorkItemId) return true;");
    expect(page).toContain("ต้องการทิ้งการแก้ไขแล้วเปลี่ยนแพ็กหรือไม่?");
    expect(page).toContain("onSelectPack={selectPackForActiveStory}");
    expect(page).toContain("if (selectPackForActiveStory(card.workItemId)) {");
  });

  it("keeps the story gate synchronized with the workspace switch (IPE-064)", () => {
    expect(page).toContain("const [storyEntered, setStoryEntered] = useState(false);");
    expect(page).toContain('data-testid="workspace-back-to-stories"');
    // Switching workspace resets back to the story picker.
    expect(page).toContain("setStoryEntered(false);");
    // Cross-story selection still resolves the story key from the group.
    expect(page).toContain("storyKeyFor(group.workspaceNovelId, group.novel?.id)");
  });
});
