import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../..", import.meta.url);
const page = () =>
  readFileSync(new URL("client/src/pages/WorkspacePage.tsx", root), "utf8");
const intake = () =>
  readFileSync(new URL("client/src/pages/WorkspaceIntakePage.tsx", root), "utf8");
const actionBar = () =>
  readFileSync(new URL("client/src/pages/WorkspaceActionBar.tsx", root), "utf8");
const workspaceService = () =>
  readFileSync(new URL("server/workspace/service.ts", root), "utf8");

describe("Workspace Editorial Preview UX", () => {
  it("keeps durable notes editable from the pack row actions menu", () => {
    const source = page();
    expect(source).toContain("updateWorkItemNote.useMutation");
    const menu = readFileSync(new URL("client/src/pages/EditorialPackRowActionsMenu.tsx", root), "utf8");
    expect(menu).toContain("แก้หมายเหตุ");
    expect(menu).toContain("disabled={!card.workItemId || !card.workItemVersion || editNotePending}");
  });

  it("does not truncate the publication novel selector to 200 rows", () => {
    const source = workspaceService();
    expect(source).toContain("export async function listPublicationNovelOptions");
    const functionBody = source.slice(
      source.indexOf("export async function listPublicationNovelOptions"),
      source.indexOf("export async function createWorkspacePublicationNovel")
    );
    expect(functionBody).not.toContain(".limit(200)");
  });

  it("moves the searchable episode intake to the intake page (IPE-064)", () => {
    const source = page();
    const intakeSource = intake();
    // The daily work area keeps no intake forms.
    expect(source).not.toContain("ค้นหาเรื่องด้วยชื่อ / Novel ID");
    expect(source).not.toContain("searchableWorkspaceNovelOptions");
    expect(intakeSource).toContain("ค้นหาเรื่องด้วยชื่อ / Novel ID");
    expect(intakeSource).toContain("searchableWorkspaceNovelOptions");
    expect(intakeSource).toContain("1. สร้างเรื่องใหม่");
    expect(intakeSource).toContain("2. เพิ่มตอนใหม่");
  });

  it("binds the publish confirm dialog to durable evidence", () => {
    const source = page();
    expect(source).toContain("editorial.evidenceStatuses.useQuery");
    expect(source).toContain("card.evidence?.readyToPublish");
    expect(source).toContain("card.evidence?.published");
    expect(source).toContain("พร้อมลง ${readyCount} ตอน · ยังไม่พร้อม ${blockedCount} ตอน");
  });

  it("keeps the bulk action bar wired to the bulk endpoints", () => {
    const source = page();
    const bar = actionBar();
    expect(bar).toContain("3. ตรวจ");
    expect(bar).toContain("4. ยืนยัน");
    expect(bar).toContain("5. Stage");
    expect(bar).toContain("6. Publish");
    expect(source).toContain("bulkRunChecker");
    expect(source).toContain("bulkBusy");
    expect(source).toContain("refreshBulkEditorial");
    expect(source).toContain("bulkApproveDrafts.useMutation");
    expect(source).toContain("bulkStageDrafts.useMutation");
    expect(source).toContain("bulkRequestPublish.useMutation");
    expect(source).toContain("ส่งเผยแพร่ ${results.length - failed.length}/${results.length} ตอน");
    // Ghost-selection pruning keeps the board as server truth.
    expect(source).toContain('refetchOnMount: "always"');
    expect(source).toContain("editorialBoardWorkItemIdKey");
    expect(source).toContain("!activeWorkItemIds.has(selectedSourceWorkItemId)");
  });

  it("surfaces allow-list checker staleness instead of a misleading current pass", () => {
    const source = page();
    const findingCard = readFileSync(new URL("client/src/pages/WorkspaceFindingActions.tsx", root), "utf8");
    expect(source).toContain("editorialCheckerStaleReason");
    expect(source).toContain("currentAllowListSha256");
    expect(source).toContain("editorialCheckerRunStale");
    // IPE-064: the stale hint moved into the finding actions card.
    expect(findingCard).toContain("checkerStale");
    expect(findingCard).toContain("ผลตรวจเก่า");
  });

  it("keeps the workspace picker and moves novel intake to the intake page", () => {
    const source = page();
    const intakeSource = intake();
    expect(source).toContain('aria-label="Workspace"');
    expect(source).toContain('workspaces.data?.length ? "hidden" : "space-y-4 p-5"');
    expect(intakeSource).toContain("1. สร้างเรื่องใหม่");
    expect(intakeSource).not.toContain("สร้าง Novel container เท่านั้น");
    expect(intakeSource).not.toContain("newNovelGoogleDocUrl");
  });

  it("exposes the editor-first chapter workflow with numbered actions and no helper paragraph", () => {
    const source = page();
    const bar = actionBar();
    expect(source).toContain("Chapter Editor");
    expect(source).toContain('data-testid="workspace-main-editor"');
    expect(source).not.toContain(">Episode Pack Detail</h2>");
    expect(source).toContain("<WorkspaceActionBar");
    expect(bar).toContain('data-testid="workspace-action-bar"');
    expect(source).toContain("เลือกแพ็กจากรายการด้านซ้ายเพื่อเริ่มแก้ตอน");
    expect(source).not.toContain("Google Docs Import → Draft → Checker → แก้ประโยค → Confirm → Stage → Controlled Publish");
  });

  it("keeps Google Docs quick import on Episode Pack intake (intake page)", () => {
    const intakeSource = intake();
    expect(intakeSource).toContain("Google Docs สำหรับ Quick Import");
    expect(intakeSource).not.toContain("newNovelGoogleDocUrl");
    expect(intakeSource).toContain("episodeGoogleDocUrl");
    expect(intakeSource).toContain("เพิ่มตอนและนำเข้า Google Docs แล้ว");
    expect(intakeSource).not.toContain("รองรับ Google Docs ที่มีหลายแท็บในลิงก์เดียว");
  });

  it("supports importing multiple Episode Pack text files in one intake action", () => {
    const intakeSource = intake();
    const router = readFileSync(new URL("server/workspace/router.ts", root), "utf8");
    expect(intakeSource).toContain("parseEpisodeRangeFromFileName");
    expect(intakeSource).toContain('aria-label="Import multiple Episode Pack files"');
    expect(intakeSource).toContain("multiple");
    expect(intakeSource).toContain("bulkImportEpisodeFiles.useMutation");
    expect(intakeSource).toContain("นำเข้า ${episodeBatchFiles.length} ไฟล์");
    expect(router).toContain("bulkImportEpisodeFiles: adminProcedure");
    expect(router).toContain("createEditorialEpisodeWorkItem");
    expect(router).toContain("importEditorialSource");
    expect(router).toContain("sourceKey: `uploaded-file:work-item-${card.workItemId}`");
  });

  it("removes persistent explanatory prose from the primary Editorial operator flow", () => {
    const source = page();
    expect(source).not.toContain("Kanban transitions:");
    expect(source).not.toContain("Card history also includes immutable assignment events");
    expect(source).not.toContain("Table เป็นมุมมองหลัก");
    expect(source).not.toContain("Bulk actions ใช้ workflow เดิม");
    expect(source).not.toContain("เปิดแถว Episode Pack จากตาราง แล้วทำงานตามลำดับ");
    expect(source).not.toContain("ตรวจ Draft ปัจจุบันแบบไม่ใช้ AI/API");
    expect(source).not.toContain("การยืนยันผูกกับ Draft SHA256");
  });

  it("keeps the deterministic checker and the consolidated editor in one workflow (editor-first center)", () => {
    const source = page();
    // IPE-062R4D + IPE-064: the main editor is the primary center surface
    // with the action bar above it and the finding card in the right rail.
    const editor = source.indexOf('data-testid="workspace-main-editor"');
    const bar = source.indexOf("<WorkspaceActionBar");
    const findingCard = source.indexOf("<WorkspaceFindingActions");
    expect(editor).toBeGreaterThan(-1);
    expect(bar).toBeGreaterThan(-1);
    expect(bar).toBeLessThan(editor);
    expect(findingCard).toBeGreaterThan(editor);
    expect(source).toContain('id="workspace-chapter-editor"');
  });

  it("keeps Workspace Editor structure anomaly details visible while collapsed", () => {
    const source = page();
    expect(source).toContain("เลขแท็บไม่เรียง");
    expect(source).toContain("แท็บว่าง");
    expect(source).toContain("ไม่มีเลขแท็บ");
    expect(source).toContain("เนื้อหาสั้นผิดปกติ");
    expect(source).toContain("ไม่มีเนื้อหา:");
    expect(source).toContain("สั้นผิดปกติ:");
  });

  it("keeps the pack/chapter tree as the navigation surface with finding counters", () => {
    const source = page();
    // IPE-064: the finding quick-editor is retired; the finding workflow is
    // the WorkspaceFindingActions card and the canvas.
    expect(source).not.toContain("แก้ตรง finding นี้");
    const findingCard = readFileSync(new URL("client/src/pages/WorkspaceFindingActions.tsx", root), "utf8");
    expect(findingCard).toContain('data-testid="workspace-finding-ignore"');
    expect(findingCard).toContain('data-testid="workspace-finding-allow"');
    expect(findingCard).toContain('data-testid="workspace-finding-confirm-note"');
    expect(findingCard).toContain('data-testid="workspace-finding-save-draft"');
  });
});
