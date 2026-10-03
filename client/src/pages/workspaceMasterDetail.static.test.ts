// IPE-060 — Workspace master-detail restructure: static UI contract tests.
// Per repo convention (no jsdom/RTL), these read WorkspacePage.tsx as text
// and pin the master-detail layout, compact rows with an overflow actions
// menu, the tabbed inline detail panel, and the preserved business chains
// (selection, one-click editor open, stage-blocker scroll, save flow).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../../", import.meta.url);
const source = (path: string) => readFileSync(new URL(path, root), "utf8").replace(/\r\n/g, "\n");

describe("IPE-060 master-detail layout contract", () => {
  const page = source("client/src/pages/WorkspacePage.tsx");

  it("renders story overview plus a responsive three-pane work area", () => {
    // Story overview cards lead the page; the focused story gets three panes.
    expect(page).toContain("<WorkspaceStoryOverview");
    expect(page).toContain("xl:grid-cols-[minmax(250px,0.65fr)_minmax(0,2.1fr)_minmax(280px,0.85fr)]");
    expect(page).toContain('data-testid="workspace-master-detail"');
    // Narrow widths stack (grid defaults to one column; detail pane keeps min width).
    expect(page).toContain('<div className="min-w-0">');
    expect(page).toContain('data-testid="workspace-side-panel"');
  });

  it("collapses import/bulk tooling and the full management table out of the daily work area", () => {
    // The import/bulk ops card is collapsed by default and the story work
    // area leads the page; the full pack table stays available in Advanced.
    const opsDetails = page.indexOf('data-testid="workspace-ops-advanced"');
    const grid = page.indexOf('data-testid="workspace-master-detail"');
    expect(opsDetails).toBeGreaterThan(-1);
    expect(grid).toBeGreaterThan(opsDetails);
    expect(page).toContain("นำเข้าและเครื่องมือกลุ่ม (นำเข้า · Master Intake · bulk)");
    const tableDetails = page.indexOf('data-testid="workspace-management-table"');
    expect(tableDetails).toBeGreaterThan(grid);
    const tableCard = page.slice(tableDetails, tableDetails + 1200);
    expect(tableCard).toContain("Editorial Episode Packs");
    // The focused story's compact pack list renders inside the work area.
    expect(page).toContain("<WorkspacePackListPanel");
  });

  it("keeps episode-number/name click as the selection affordance", () => {
    expect(page).toContain('onClick={()=>selectPackAcrossStories(card)}');
    // Whole episode cell is clickable (row-level select) but ignores nested controls.
    expect(page).toContain('if(el.closest("button,summary,input,a"))return;');
    expect(page).toContain('title="คลิกเพื่อเปิด Episode Pack Detail"');
  });
});

describe("IPE-060 compact rows + overflow actions menu", () => {
  const page = source("client/src/pages/WorkspacePage.tsx");

  it("moves secondary row actions into a single overflow menu", () => {
    expect(page).toContain('data-testid="editorial-row-actions"');
    const menuStart = page.indexOf('data-testid="editorial-row-actions"');
    const menu = page.slice(menuStart, menuStart + 3200);
    // All secondary actions live inside the menu block...
    expect(menu).toContain("เปิด Editor (ตอนถัดไปที่มีปัญหา)");
    expect(menu).toContain("แก้ไขช่วงตอน");
    expect(menu).toContain("แก้การขาย");
    expect(menu).toContain("นำออก");
    // ...and the destructive remove action keeps its confirm + mutation wiring.
    expect(menu).toContain("removeEditorialEpisode.mutate({workspaceId:selectedWorkspaceId,workItemId:card.workItemId})");
  });

  it("no longer renders per-row action buttons as separate controls", () => {
    // The old stacked inline-button rows are gone from the episode cell.
    expect(page).not.toContain('<div className="mt-2 flex gap-2"><Button type="button" size="sm" variant="outline" onClick={()=>{const next=window.prompt("แก้ช่วงตอน"');
    expect(page).not.toContain('{/* IPE-058-F: row -> editor in ONE click (opens next-issue tab). */}');
  });

  it("preserves the IPE-058-F one-click editor-open chain via the menu", () => {
    expect(page).toContain("setPendingEditorOpenWorkItemId(card.workItemId)");
    // Effect that consumes the pending editor-open target is intact.
    expect(page).toContain("setPendingEditorOpenWorkItemId(null)");
  });

  it("compacts table rows (py-2) — no tall action stacks inside rows", () => {
    const tableStart = page.indexOf('<table className="w-full min-w-[1240px] border-collapse text-sm">');
    const tableEnd = page.indexOf("</table>", tableStart);
    const table = page.slice(tableStart, tableEnd);
    expect(table).not.toContain("px-3 py-3");
    expect(table).toContain("px-3 py-2");
  });
});

describe("IPE-060 tabbed inline detail panel", () => {
  const page = source("client/src/pages/WorkspacePage.tsx");

  it("provides Editor/QC/Stage/Publish tabs on the detail panel", () => {
    expect(page).toContain('data-testid="pack-detail-tabs"');
    expect(page).toContain('data-testid="pack-detail-tab-editor"');
    expect(page).toContain('data-testid="pack-detail-tab-qc"');
    expect(page).toContain('data-testid="pack-detail-tab-stage"');
    expect(page).toContain('data-testid="pack-detail-tab-publish"');
    expect(page).toContain('useState<"editor" | "qc" | "stage" | "publish">("editor")');
  });

  it("keeps every panel mounted via hidden-class toggling (no unmount of editor state)", () => {
    expect(page).toContain('packDetailTab === "editor" ? "grid gap-3 lg:grid-cols-2" : "hidden"');
    expect(page).toContain('packDetailTab === "qc" ? "space-y-3 rounded-md border p-3" : "hidden"');
    expect(page).toContain('packDetailTab === "editor" ? "rounded-md border bg-muted/10" : "hidden"');
    expect(page).toContain('packDetailTab === "stage" ? "space-y-3 rounded-md border p-3" : "hidden"');
    expect(page).toContain('packDetailTab === "publish" ? "space-y-3" : "hidden"');
  });

  it("publish tab explains not-ready state instead of silently hiding", () => {
    expect(page).toContain("ยังไม่พร้อมเผยแพร่ — ตรวจความพร้อมและทำ Stage ในแท็บ Stage");
  });

  it("cross-tab jumps switch to the editor tab before scrolling", () => {
    // openChapterEditor and the stage-blocker fallback both force the editor tab.
    expect(page).toContain("setPackDetailTab(\"editor\");\n    window.requestAnimationFrame(");
    expect(page).toContain('setPackDetailTab("editor");\n                            document\n                              .getElementById("workspace-chapter-editor")');
  });

  it("leaves readiness evidence as the single shared source (board + detail read the same query)", () => {
    expect(page).toContain("editorialEvidenceStatuses");
    // No duplicated readiness derivation was introduced by IPE-060.
    expect(page).not.toContain("ipe060Readiness");
  });

  it("keeps the canonical editor/save/chains untouched (IPE-058 contracts)", () => {
    expect(page).toContain('id="workspace-chapter-editor-canvas"');
    expect(page).toContain('kind: "replace_tab"');
    expect(page).toContain('data-testid="workspace-novel-export-trigger"');
  });
});

describe("IPE-060R2 — review repairs", () => {
  const page = source("client/src/pages/WorkspacePage.tsx");

  it("renders the publish panel as a sibling of the stage panel (never nested inside it)", () => {
    // Codex P1: nesting the publish panel inside the hidden stage panel made
    // the Publish tab permanently blank. The stage panel's <div> (and every
    // div it opens) must close BEFORE the publish panel's <div> starts.
    const stageClass = page.indexOf('packDetailTab === "stage" ? "space-y-3 rounded-md border p-3" : "hidden"');
    const publishClass = page.indexOf('packDetailTab === "publish" ? "space-y-3" : "hidden"');
    expect(stageClass).toBeGreaterThan(-1);
    expect(publishClass).toBeGreaterThan(stageClass);
    const stageDivStart = page.lastIndexOf("<div", stageClass);
    const publishDivStart = page.lastIndexOf("<div", publishClass);
    const between = page.slice(stageDivStart, publishDivStart);
    const opens = (between.match(/<div\b/g) ?? []).length - (between.match(/<div\b[^>]*\/>/g) ?? []).length;
    const closes = (between.match(/<\/div>/g) ?? []).length;
    expect(opens - closes).toBe(0);
  });

  it("disables the destructive remove action for cards without a work item", () => {
    // Codex P2: the board read model can surface active cards with
    // workItemId: null; the menu must not submit a null work-item removal.
    const menuStart = page.indexOf('data-testid="editorial-row-actions"');
    expect(menuStart).toBeGreaterThan(-1);
    const menu = page.slice(menuStart, menuStart + 3200);
    expect(menu).toContain('text-destructive hover:bg-destructive/10" disabled={!card.workItemId}');
  });
});
