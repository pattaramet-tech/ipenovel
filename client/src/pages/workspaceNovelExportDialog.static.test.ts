// IPE-059-B - Static UI contract tests for the Workspace novel export
// dialog. Per repo convention (no jsdom/RTL), these read the component and
// page sources as text and pin the integration contract: two clearly
// separated export modes, preview-before-download, safe Blob download with
// object-URL revocation, and zero coupling to the editorial workflow.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../../", import.meta.url);
const source = (path: string) => readFileSync(new URL(path, root), "utf8");

describe("WorkspaceNovelExportDialog UI contract", () => {
  const dialog = source("client/src/pages/WorkspaceNovelExportDialog.tsx");

  it("exposes exactly two export modes with Thai-Novel Upload as default", () => {
    expect(dialog).toContain('data-testid="export-mode-thainovel"');
    expect(dialog).toContain('data-testid="export-mode-backup"');
    expect(dialog).toContain(`useState<ExportMode>("thainovel")`);
    expect(dialog).toContain("Thai-Novel Upload");
    expect(dialog).toContain("IpeNovel Backup / Re-import");
  });

  it("keeps mode settings separated (Thai-Novel options render only in thainovel mode)", () => {
    expect(dialog).toContain('{mode === "thainovel" && (');
    expect(dialog).toContain('data-testid="export-option-start-number"');
    expect(dialog).toContain('data-testid="export-option-title-prefix"');
    expect(dialog).toContain('data-testid="export-option-append-filename"');
    expect(dialog).toContain('data-testid="export-backup-explanation"');
    // Backup explanation is bound to backup mode, not rendered globally
    expect(dialog).toContain('{mode === "backup" && (');
  });

  it("renders a preview table derived from the server serializer before download", () => {
    expect(dialog).toContain('data-testid="export-preview-table"');
    expect(dialog).toContain("admin.novelExport.thaiNovelPreview.useQuery");
    expect(dialog).toContain("admin.novelExport.thaiNovelDownloadZip.useMutation");
    expect(dialog).toContain("admin.novelExport.preview.useQuery");
    expect(dialog).toContain("admin.novelExport.downloadZip.useMutation");
    // No serialization logic in the component - server owns entry building
    expect(dialog).not.toMatch(/padStart|manifest\.csv.*join|buildThaiNovel/);
  });

  it("supports whole-novel and selected-subset scopes", () => {
    expect(dialog).toContain('data-testid="export-scope-whole"');
    expect(dialog).toContain('data-testid="export-scope-subset"');
    expect(dialog).toContain("sourceEpisodes");
  });

  it("downloads via Blob with correct MIME and revokes the object URL", () => {
    expect(dialog).toContain("downloadBase64AsFile");
    expect(dialog).toContain("new Blob([bytes], { type: mimeType })");
    expect(dialog).toContain("URL.createObjectURL(blob)");
    expect(dialog).toContain("URL.revokeObjectURL(url)");
    expect(dialog).toContain("atob(contentBase64)");
  });

  it("disables download while invalid and shows bounded errors", () => {
    expect(dialog).toContain('data-testid="export-download-zip"');
    expect(dialog).toContain("disabled={downloadDisabled}");
    expect(dialog).toContain("const downloadDisabled =");
    expect(dialog).toContain("downloadError.message");
    expect(dialog).toContain("previewError.message");
  });

  it("documents the published-only boundary in the UI", () => {
    expect(dialog).toContain("ส่งออกเฉพาะตอนที่เผยแพร่แล้ว");
  });

  it("filters the novel list with a title/id search box (IPE-064R3)", () => {
    expect(dialog).toContain('data-testid="export-novel-search"');
    expect(dialog).toContain("ค้นหาชื่อเรื่อง / Novel ID");
    expect(dialog).toContain("filteredNovels");
    // Filtering is display-only: the current selection stays visible even
    // when the search excludes it.
    expect(dialog).toContain("const selectableNovels = useMemo(");
    expect(dialog).toContain("ไม่พบเรื่องที่ตรงกับการค้นหา");
  });

  it("surfaces an over-limit banner and blocks the whole-scope download (IPE-064R3)", () => {
    expect(dialog).toContain('data-testid="export-over-limit-banner"');
    expect(dialog).toContain("const thaiOverLimit = thaiPreview.data?.overLimit ?? null;");
    // The whole-scope ZIP stays fail-closed while the per-pack subset is the
    // advertised way out.
    expect(dialog).toContain('const wholeScopeOverLimit = Boolean(thaiOverLimit && scope === "whole");');
    expect(dialog).toContain("wholeScopeOverLimit;");
    expect(dialog).toContain("เลือกโหมด \"เลือกบางตอน\"");
  });
});

describe("WorkspacePage export integration contract", () => {
  const page = source("client/src/pages/WorkspacePage.tsx");
  const toolbar = source("client/src/pages/WorkspaceEditorialToolbar.tsx");

  it("mounts the export dialog and a compact trigger in the workspace utility row", () => {
    expect(page).toContain('from "./WorkspaceNovelExportDialog"');
    expect(page).toContain("WorkspaceNovelExportDialog");
    expect(page).toContain('data-testid="workspace-novel-export-trigger"');
    expect(page).toContain("ส่งออก");
  });

  it("keeps export out of the editorial primary progression", () => {
    // The editorial toolbar (Draft→Checker→QC→Confirm→Stage primary CTA)
    // must remain untouched by the export feature.
    expect(toolbar).not.toContain("Export");
    expect(toolbar).not.toContain("ส่งออก");
    expect(toolbar).not.toContain("novelExport");
  });

  it("does not trigger any editorial workflow action from the export wiring", () => {
    // Isolate the actual wiring block: from the trigger button to the end of
    // the dialog render - not the rest of the page.
    const triggerIndex = page.indexOf('data-testid="workspace-novel-export-trigger"');
    const dialogRenderIndex = page.indexOf("<WorkspaceNovelExportDialog");
    expect(triggerIndex).toBeGreaterThan(-1);
    expect(dialogRenderIndex).toBeGreaterThan(triggerIndex);
    const wiringBlock = page.slice(triggerIndex, dialogRenderIndex + 250);
    expect(wiringBlock).toContain("setExportDialogOpen(true)");
    expect(wiringBlock).not.toMatch(/saveDraft|runChecker|confirmChapter|stageChapter|publishChapter|\.mutate\(/);
  });

  it("derives the novel list from the full system catalog, not workspace bindings (IPE-064R3)", () => {
    // The exporter reads published episodes by novelId behind an admin gate —
    // the list must cover the ENTIRE catalog (same source as the intake
    // selector), never scoped to workspace bindings.
    expect(page).toContain("availablePublicationNovels.useQuery");
    expect(page).toContain("exportNovelOptions");
    expect(page).not.toContain("workspaceBoundNovels");
    expect(page).not.toContain("workspaceExportNovels");
    expect(page).not.toContain("bindings.list.useQuery");
  });
});
