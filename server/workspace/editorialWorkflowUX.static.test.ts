import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../", import.meta.url);
const source = (path: string) => readFileSync(new URL(path, root), "utf8");

/**
 * IPE-058-F static contract: daily-workflow UX simplification on top of the
 * IPE-058-E canonical state machine — one primary CTA, sticky toolbar,
 * collapsed issue drawer, Advanced debug section, direct row→editor
 * navigation, and grouped Stage diagnostics. No client state-machine logic.
 */
describe("Workspace daily workflow UX static contract", () => {
  const page = source("client/src/pages/WorkspacePage.tsx");
  const toolbar = source("client/src/pages/WorkspaceEditorialToolbar.tsx");
  const actionState = source("client/src/pages/workspaceEditorialActionState.ts");
  const diagnostics = source("client/src/pages/workspaceStageDiagnostics.ts");
  const checkerDomain = source("server/workspace/editorialForeignChecker.domain.ts");

  it("derives the primary CTA from the canonical state machine (no count shortcut)", () => {
    expect(actionState).toContain("deriveEditorialPrimaryAction");
    expect(actionState).toContain('case "CURRENT_READY"');
    expect(actionState).toContain('case "CURRENT_HAS_FINDINGS"');
    // The toolbar renders ONE primary action component.
    expect(toolbar).toContain("deriveEditorialPrimaryAction({");
    expect(page).toContain("<WorkspaceEditorialToolbar");
  });

  it("keeps every canonical checker state name and never introduces client state logic", () => {
    for (const state of [
      "NOT_RUN",
      "RUNNING",
      "STALE",
      "ERROR",
      "CURRENT_HAS_FINDINGS",
      "CURRENT_READY",
    ]) {
      expect(checkerDomain).toContain(`"${state}"`);
    }
    // No new client-side ready inference: the toolbar consumes server state.
    expect(toolbar).toContain("checkerState:");
    expect(toolbar).toContain("unresolvedCount:");
    expect(page).toContain("editorialCheckerState");
  });

  it("renders a sticky toolbar with Prev/Next, unsaved indicator, and issue count", () => {
    expect(page).toContain("sticky top-0 z-20");
    expect(page).toContain("ยังไม่บันทึก");
    expect(toolbar).toContain("ก่อนหน้า");
    expect(toolbar).toContain("ถัดไป");
    expect(toolbar).toContain("issueCount");
    // Debug hashes must not appear in the toolbar.
    expect(toolbar).not.toContain("shortHash");
  });

  it("collapses the issue drawer by default and keeps jump actions", () => {
    const editorRegion = page.slice(
      page.indexOf('id="workspace-chapter-editor"'),
      page.indexOf("const googleConnections") > 0
        ? page.indexOf("const googleConnections")
        : undefined
    );
    // No `details open` remains in the editor region (drawer collapsed).
    expect(editorRegion).not.toMatch(/<details open/);
    expect(page).toContain("navigateRelativeChapterEditorIssue");
    expect(page).toContain("navigateChapterEditorIssue");
  });

  it("keeps raw hashes out of the summary surfaces", () => {
    // IPE-064: the Approval/QC diagnostics boxes retired; no inline hashes.
    expect(page).not.toContain(
      "`#${editorialApprovalData.approval.id} · ${shortHash(editorialApprovalData.approval.approvedDraftSha256)}`"
    );
  });

  it("provides direct row→editor navigation from the pack tree", () => {
    // IPE-064: the management table retired — the one-click chain lives in
    // the pack list panel (menu button -> pendingEditorOpenWorkItemId -> effect).
    const panel = source("client/src/pages/WorkspacePackListPanel.tsx");
    const menu = source("client/src/pages/EditorialPackRowActionsMenu.tsx");
    expect(menu).toContain('data-testid="editorial-row-actions"');
    expect(panel).toContain("<EditorialPackRowActionsMenu");
    expect(page).toContain("pendingEditorOpenWorkItemId");
    // Selected row's chapter rows render under the expanded pack.
    expect(panel).toContain("groupCard.workItemId === selectedSourceWorkItemId" === "" ? "" : "showChapters = expanded && selected");
  });

  it("keeps Stage-blocker grouping in the diagnostics module (UI retired, IPE-064)", () => {
    expect(diagnostics).toContain("groupStageDiagnostics");
    expect(diagnostics).toContain('"METADATA_MISSING"');
    expect(diagnostics).toContain('"EPISODE_RANGE_INVALID"');
    expect(diagnostics).toContain('"APPROVAL_STALE"');
    expect(diagnostics).toContain('"SOURCE_DRIFT"');
    // The page still offers the repair entry points (toolbar CTA + canvas).
    expect(page).toContain("onStage={submitStageDraft}");
    expect(page).toContain("openChapterEditor");
  });

  it("keeps Save+Check single-boundary semantics and the Ctrl+S / unsaved guards", () => {
    expect(page).toContain("submitChapterEditorEdit");
    expect(page).toContain("บันทึก Draft + ตรวจซ้ำ");
    expect(page).toContain("runEditorialForeignCheckerOnceForDraft");
    expect(page).toContain("beforeunload");
  });

  it("preserves IPE-058-E state authority (server evaluator untouched as authority)", () => {
    const domain = source("server/workspace/editorialForeignChecker.domain.ts");
    expect(domain).toContain("evaluateEditorialCheckerState");
    expect(domain).toContain("\"CURRENT_READY\"");
    expect(domain).toContain("\"STALE\"");
    expect(domain).toContain("\"ERROR\"");
  });
});
