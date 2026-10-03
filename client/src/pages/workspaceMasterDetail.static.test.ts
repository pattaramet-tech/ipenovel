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

  it("renders board and detail as a responsive two-pane master-detail grid", () => {
    expect(page).toContain('data-testid="workspace-master-detail"');
    expect(page).toContain("xl:grid-cols-[minmax(340px,0.8fr)_minmax(0,1.7fr)]");
    // Narrow widths stack (grid defaults to one column; detail pane keeps min width).
    expect(page).toContain('<div className="min-w-0">');
  });

  it("separates import/bulk tooling from the compact master list", () => {
    // Ops card holds the import/bulk tooling; master card holds the pack list.
    expect(page).toContain("นำเข้าและเครื่องมือกลุ่ม");
    const opsHeader = page.indexOf("นำเข้าและเครื่องมือกลุ่ม");
    const masterGrid = page.indexOf('data-testid="workspace-master-detail"');
    expect(opsHeader).toBeGreaterThan(-1);
    expect(masterGrid).toBeGreaterThan(opsHeader);
    // Master list card still carries the Editorial Episode Packs header.
    const masterCard = page.slice(masterGrid, masterGrid + 900);
    expect(masterCard).toContain("Editorial Episode Packs");
  });

  it("keeps episode-number/name click as the selection affordance", () => {
    expect(page).toContain('onClick={()=>setSelectedSourceWorkItemId(card.workItemId)}');
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
