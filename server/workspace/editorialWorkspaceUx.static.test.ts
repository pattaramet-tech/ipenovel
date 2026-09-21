import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../..", import.meta.url);
const page = () =>
  readFileSync(new URL("client/src/pages/WorkspacePage.tsx", root), "utf8");
const workspaceService = () =>
  readFileSync(new URL("server/workspace/service.ts", root), "utf8");

describe("Workspace Editorial Preview UX", () => {
  it("uses a collapsed Novel-grouped Episode Pack table with durable notes", () => {
    const source = page();
    expect(source).toContain("Editorial Workspace");
    expect(source).toContain("editorialNovelGroups.map");
    expect(source).toContain("<details key={group.workspaceNovelId");
    expect(source).toContain("เรื่อง / ช่วงตอน");
    expect(source).toContain("หมายเหตุ");
    expect(source).toContain("updateWorkItemNote.useMutation");
    expect(source).not.toContain("Editorial assignee filter");
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

  it("supports table search, quick filters and searchable episode intake", () => {
    const source = page();
    expect(source).toContain("Editorial pack search");
    expect(source).toContain("ค้นหาชื่อเรื่อง / Novel ID / ช่วงตอน / ชื่อตอน / หมายเหตุ");
    expect(source).toContain('["new","มาใหม่"]');
    expect(source).toContain('["unchecked","ยังไม่ตรวจ"]');
    expect(source).toContain('["needs_fix","ต้องแก้"]');
    expect(source).toContain('["awaiting_confirm","รอยืนยัน"]');
    expect(source).toContain('["ready_stage","พร้อม Stage"]');
    expect(source).toContain('["ready_publish","พร้อมลง"]');
    expect(source).toContain('["published","ลงแล้ว"]');
    expect(source).toContain("ค้นหาเรื่องด้วยชื่อ / Novel ID");
    expect(source).toContain("searchableWorkspaceNovelOptions");
  });

  it("binds table status columns and quick filters to durable evidence", () => {
    const source = page();
    expect(source).toContain("editorial.evidenceStatuses.useQuery");
    expect(source).toContain("card.evidence?.checkerRan");
    expect(source).toContain("card.evidence?.checker");
    expect(source).toContain("card.evidence?.approval");
    expect(source).toContain("card.evidence?.stage");
    expect(source).toContain("card.evidence?.readyToPublish");
    expect(source).toContain("card.evidence?.published");
    expect(source).toContain("Publish run + receipt + outbox + reader visibility ครบ");
    expect(source).toContain('card.evidence?.publishedSource === "published_episode"');
    expect(source).toContain("historical/legacy publication");
    expect(source).toContain('aria-label={passed ? "ผ่าน" : "ยังไม่ผ่าน"}');
    expect(source).toContain('border-emerald-500 bg-emerald-600 text-white');
    expect(source).toContain('border-slate-300 bg-white text-slate-300');
    expect(source).toContain('bg-cyan-50 text-cyan-800');
    expect(source).toContain('bg-violet-50 text-violet-800');
    expect(source).toContain('bg-blue-50 text-blue-800');
    expect(source).toContain('bg-emerald-50 text-emerald-800');
    expect(source).toContain("โหลดสถานะตารางไม่สำเร็จ");
    expect(source).toContain("ขายรายตอน · ฿");
    expect(source).toContain("แพ็กเกจ · ฿");
    expect(source).toContain("ยังไม่กำหนดการขาย");
    expect(source).toContain('aria-label="เลือก Episode Pack ที่มองเห็นทั้งหมด"');
    expect(source).toContain("เลือกยังไม่ตรวจ");
    expect(source).toContain("เลือกพร้อมลง");
    expect(source).toContain("3. ตรวจ / ตรวจซ้ำ");
    expect(source).toContain("4. ยืนยัน Draft ปัจจุบัน");
    expect(source).toContain("5. Stage");
    expect(source).toContain("6. Publish");
    expect(source).toContain("bulkRunChecker.useMutation");
    expect(source).toContain("bulkCheckerSummary");
    expect(source).toContain("สรุปผลตรวจ");
    expect(source).toContain("ค้างตรวจ");
    expect(source).toContain("openFindings");
    expect(source).toContain("groupBulkCheckerParagraphs");
    expect(source).toContain("แก้ย่อหน้านี้");
    expect(source).toContain("บันทึก + ตรวจซ้ำ");
    expect(source).toContain('kind: "replace_paragraph"');
    expect(source).toContain("bulkEditEditorialFinding");
    expect(source).toContain("rerunBulkEditedChecker");
    expect(source).toContain("bulkAllowEditorialFinding");
    expect(source).toContain("rerunBulkAfterAllow");
    expect(source).toContain("ยกเว้นคำ “");
    expect(source).toContain("สำหรับ Checker ทั้ง Workspace?");
    expect(source).toContain("bulk-allow:");
    expect(source).toContain("ตรวจไม่สำเร็จ:");
    expect(source).toContain("bulkApproveDrafts.useMutation");
    expect(source).toContain("const firstError = failed.find");
    expect(source).toContain("bulkStageDrafts.useMutation");
    expect(source).toContain("bulkRequestPublish.useMutation");
    expect(source).toContain("ส่งเผยแพร่ ${results.length - failed.length}/${results.length} ตอน");
    expect(source).toContain("const firstError = failed.find");
    expect(source).toContain("bulkBusy");
    expect(source).toContain("refreshBulkEditorial");
    expect(source).toContain("พร้อมลง ${readyCount} ตอน · ยังไม่พร้อม ${blockedCount} ตอน");
    expect(source).toContain("bg-emerald-50");
    expect(source).toContain("bg-blue-50");
  });

  it("applies Preview feedback for compact Workspace, container-only novel intake and guarded ownership prep", () => {
    const source = page();
    expect(source).toContain('aria-label="Workspace"');
    expect(source).toContain('<Card className="hidden">');
    expect(source).toContain('card.workItemType !== "NEW_STORY"');
    expect(source).toContain("1. สร้างเรื่องใหม่");
    expect(source).toContain("2. เพิ่มตอนใหม่");
    expect(source).not.toContain("สร้าง Novel container เท่านั้น");
    expect(source).not.toContain("newNovelGoogleDocUrl");
    expect(source).toContain("preparePublishOwnership.useMutation");
    expect(source).toContain("Prepare Publish Ownership");
  });

  it("defaults to Table with Kanban parity and collapses operator evidence", () => {
    const source = page();
    expect(source).toContain('useState<"table" | "kanban">("table")');
    expect(source).toContain('setEditorialView("table")');
    expect(source).toContain('setEditorialView("kanban")');
    expect(source).toContain('editorialView === "kanban"');
    expect(source).toContain("Operations / Advanced");
    expect(source).not.toContain("publish runs/outbox · ownership evidence");
  });

  it("exposes the table-selected Episode Pack detail workflow with numbered actions and no helper paragraph", () => {
    const source = page();
    expect(source).toContain("Episode Pack Detail");
    expect(source).toContain("3. ตรวจ / ตรวจซ้ำ");
    expect(source).toContain("4. ยืนยัน Draft ปัจจุบัน");
    expect(source).toContain("5. Stage");
    expect(source).toContain("6. Publish");
    expect(source).toContain("คลิกช่วงตอนในตารางเพื่อเปิด Episode Pack Detail");
    expect(source).not.toContain("Google Docs Import → Draft → Checker → แก้ประโยค → Confirm → Stage → Controlled Publish");
  });

  it("keeps Google Docs quick import on Episode Pack intake without helper prose", () => {
    const source = page();
    expect(source).toContain("Google Docs สำหรับ Quick Import");
    expect(source).not.toContain("newNovelGoogleDocUrl");
    expect(source).toContain("episodeGoogleDocUrl");
    expect(source).toContain("เพิ่มตอนและนำเข้า Google Docs แล้ว");
    expect(source).not.toContain("รองรับ Google Docs ที่มีหลายแท็บในลิงก์เดียว");
  });

  it("supports importing multiple Episode Pack text files in one intake action", () => {
    const source = page();
    const router = readFileSync(new URL("server/workspace/router.ts", root), "utf8");
    expect(source).toContain("parseEpisodeRangeFromFileName");
    expect(source).toContain('aria-label="Import multiple Episode Pack files"');
    expect(source).toContain("multiple");
    expect(source).toContain("bulkImportEpisodeFiles.useMutation");
    expect(source).toContain("นำเข้า ${episodeBatchFiles.length} ไฟล์");
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

  it("puts deterministic checker before the collapsible Draft structure", () => {
    const source = page();
    const checker = source.indexOf("3. ตรวจ / ตรวจซ้ำ");
    const draft = source.indexOf("Draft structure ·");
    expect(checker).toBeGreaterThan(-1);
    expect(draft).toBeGreaterThan(checker);
    expect(source).toContain('<details className="rounded-md border bg-muted/10">');
  });
  it("keeps Draft structure anomaly details visible while collapsed", () => {
    const source = page();
    expect(source).toContain("เลขแท็บไม่เรียง");
    expect(source).toContain("แท็บว่าง");
    expect(source).toContain("ไม่มีเลขแท็บ");
    expect(source).toContain("เนื้อหาสั้นผิดปกติ");
    expect(source).toContain("ไม่มีเนื้อหา:");
    expect(source).toContain("สั้นผิดปกติ:");
  });

  it("keeps finding-triggered sentence editing inline with the finding", () => {
    const source = page();
    expect(source).toContain("editorTarget && editorTarget.findingId === finding.id");
    expect(source).toContain("แก้ตรง finding นี้");
  });
});
