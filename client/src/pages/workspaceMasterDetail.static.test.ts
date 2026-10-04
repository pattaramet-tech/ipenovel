// IPE-060/IPE-064 — Workspace master-detail restructure: static UI contract
// tests. Per repo convention (no jsdom/RTL), these read WorkspacePage.tsx as
// text and pin the 4-pane daily work area (pack tree | action bar + editor |
// finding actions), the story gate, and the preserved business chains
// (selection, one-click editor open, save flow).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../../", import.meta.url);
const source = (path: string) => readFileSync(new URL(path, root), "utf8").replace(/\r\n/g, "\n");

describe("IPE-064 master-detail layout contract", () => {
  const page = source("client/src/pages/WorkspacePage.tsx");

  it("renders the story picker first, then the three-pane work area", () => {
    expect(page).toContain("<WorkspaceStoryOverview");
    expect(page).toContain("xl:grid-cols-[minmax(250px,0.65fr)_minmax(0,2.1fr)_minmax(280px,0.85fr)]");
    expect(page).toContain('data-testid="workspace-master-detail"');
    expect(page).toContain('<div className="min-w-0 space-y-3">');
    expect(page).toContain('data-testid="workspace-side-panel"');
  });

  it("keeps import/intake tooling and the management table out of the work area", () => {
    // IPE-064: the ops card moved to /workspace/intake and the full pack
    // table was retired — the daily work area leads with the story picker.
    expect(page).not.toContain('data-testid="workspace-ops-advanced"');
    expect(page).not.toContain('data-testid="workspace-management-table"');
    expect(page).toContain('href="/workspace/intake"');
    expect(page).toContain("<WorkspacePackListPanel");
  });

  it("keeps episode-number/name click as the selection affordance in the pack tree", () => {
    const panel = source("client/src/pages/WorkspacePackListPanel.tsx");
    expect(panel).toContain("onSelectPack(workItemId)");
    expect(panel).toContain('title="คลิกเพื่อเปิดบทนี้ใน Editor"');
    const page = source("client/src/pages/WorkspacePage.tsx");
    expect(page).toContain("<WorkspacePackListPanel");
  });
});

describe("IPE-060 compact rows + overflow actions menu", () => {
  it("keeps the shared overflow actions menu on pack rows", () => {
    const menu = source("client/src/pages/EditorialPackRowActionsMenu.tsx");
    expect(menu).toContain('data-testid="editorial-row-actions"');
    expect(menu).toContain("เปิด Editor (ตอนถัดไปที่มีปัญหา)");
    expect(menu).toContain("แก้ไขช่วงตอน");
    expect(menu).toContain("แก้การขาย");
    expect(menu).toContain("นำออก");
  });

  it("preserves the IPE-058-F one-click editor-open chain via the panel", () => {
    const page = source("client/src/pages/WorkspacePage.tsx");
    expect(page).toContain("setPendingEditorOpenWorkItemId(card.workItemId)");
    expect(page).toContain("setPendingEditorOpenWorkItemId(null)");
  });
});

describe("IPE-060 workflow placement (superseded by IPE-064)", () => {
  const page = source("client/src/pages/WorkspacePage.tsx");

  it("the center is the main editor; workflow lives in the action bar and finding card", () => {
    expect(page).not.toContain('data-testid="pack-detail-tabs"');
    expect(page).not.toContain('data-testid="pack-detail-tab-editor"');
    expect(page).toContain('data-testid="workspace-main-editor"');
    expect(page).toContain("<WorkspaceActionBar");
    expect(page).toContain("<WorkspaceFindingActions");
    const actionBarSource = source("client/src/pages/WorkspaceActionBar.tsx");
    const findingSource = source("client/src/pages/WorkspaceFindingActions.tsx");
    expect(actionBarSource).toContain('data-testid="workspace-action-bar"');
    expect(findingSource).toContain('data-testid="workspace-finding-actions"');
  });

  it("keeps the canonical editor/save/export chains untouched (IPE-058 contracts)", () => {
    expect(page).toContain('id="workspace-chapter-editor-canvas"');
    expect(page).toContain('kind: "replace_tab"');
    expect(page).toContain('data-testid="workspace-novel-export-trigger"');
  });

  it("opens the chapter editor through the pack tree and scrolls to its anchor", () => {
    expect(page).toContain('id="workspace-chapter-editor"');
    expect(page).toContain("if (tab) openChapterEditor(tab);");
  });

  it("keeps readiness evidence as the single shared source (board + detail read the same query)", () => {
    expect(page).toContain("editorialEvidenceStatuses");
    expect(page).not.toContain("ipe060Readiness");
  });
});
