import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../..", import.meta.url);
const source = (path: string) => readFileSync(new URL(path, root), "utf8");

describe("Workspace Editorial editor static boundaries", () => {
  it("keeps migration 0049 additive and Workspace-only", () => {
    const migration = source("drizzle/0049_workspace_editorial_editor.sql");
    expect(migration).toContain("workspaceEditorialDraftEditEvents");
    expect(migration).not.toMatch(/DROP TABLE|DROP COLUMN|DROP FOREIGN KEY/i);
    expect(migration).not.toMatch(
      /accountMerge|payment|wallet|episodePurchases|ALTER TABLE `episodes`/i
    );
  });

  it("keeps migration 0059 additive while extending the editor audit enum", () => {
    const migration = source("drizzle/0059_workspace_editorial_tab_editor.sql");
    expect(migration).toContain("'replace_tab'");
    expect(migration).toContain("workspaceEditorialDraftEditEvents");
    expect(migration).not.toMatch(/DROP TABLE|DROP COLUMN|DROP FOREIGN KEY/i);
  });

  it("binds every edit to exact Draft id/version/hash and paragraph/range expectations", () => {
    const service = source("server/workspace/editorialEditor.service.ts");
    const domain = source("server/workspace/editorialEditor.domain.ts");
    expect(service).toContain("current.id !== input.expectedDraftId");
    expect(service).toContain("current.version !== input.expectedDraftVersion");
    expect(service).toContain(
      "current.draftSha256 !== input.expectedDraftSha256"
    );
    expect(domain).toContain("expectedParagraphFingerprint");
    expect(domain).toContain("beforeText.slice(startOffset, endOffset)");
    expect(domain).toContain("command.expectedText !== beforeText");
  });

  it("creates immutable manual Draft versions instead of mutating source or prior Draft rows", () => {
    const service = source("server/workspace/editorialEditor.service.ts");
    expect(service).toContain('origin: "manual"');
    expect(service).toContain('transformCode: "manual_edit"');
    expect(service).toContain('transformCode: "manual_undo"');
    expect(service).toContain("workspaceEditorialDraftEditEvents");
    expect(service).not.toMatch(
      /update\(workspaceEditorialDraftParagraphs\)|delete\(workspaceEditorialDraftParagraphs\)/
    );
  });

  it("keeps editor manual-first and free of AI, Docs write-back, publish and episode side effects", () => {
    const service = source("server/workspace/editorialEditor.service.ts");
    const domain = source("server/workspace/editorialEditor.domain.ts");
    expect(service + domain).not.toMatch(
      /workspaceAi|workspacePublish|DocumentApp|documents:batchUpdate|insert\(episodes\)|update\(episodes\)|fetch\(|openai|gemini/i
    );
  });

  it("projects only the current Draft: manual edits to editing and deterministic recheck to needs-fix or pending-confirm", () => {
    const editor = source("server/workspace/editorialEditor.service.ts");
    const checker = source(
      "server/workspace/editorialForeignChecker.service.ts"
    );
    const projection = source(
      "server/workspace/editorialQcProjection.service.ts"
    );
    expect(editor).toContain('targetColumnKey: "editing"');
    expect(editor).toContain("expectedDraftId: persisted.draftId");
    expect(checker).toContain(
      'readModel.blockingIssueCount > 0 ? "needs_fix" : "pending_confirm"'
    );
    expect(checker).toContain("expectedDraftId: result.draftId");
    expect(projection).toContain("latestDraft.id !== input.expectedDraftId");
    expect(projection).toContain('"STALE_DRAFT"');
  });

  it("requires finding id/key as one guarded pair and prevents undo from toggling an undo Draft", () => {
    const editor = source("server/workspace/editorialEditor.service.ts");
    expect(editor).toContain(
      "Boolean(input.findingKey) !== Boolean(input.findingId)"
    );
    expect(editor).toContain('currentEdit.editKind === "undo"');
    expect(editor).toContain('lastEdit?.editKind !== "undo"');
  });

  it("exposes editor read/edit/undo only through admin procedures", () => {
    const router = source("server/workspace/router.ts");
    expect(router).toContain("editor: adminProcedure");
    expect(router).toContain("editorEdit: adminProcedure");
    expect(router).toContain("editorUndo: adminProcedure");
  });

  it("provides sentence edit, paragraph edit, autosave, recheck and undo UX without requiring AI", () => {
    const page = source("client/src/pages/WorkspacePage.tsx");
    expect(page).toContain("Workspace Editor");
    expect(page).toContain("แก้ประโยค");
    expect(page).toContain("แก้ย่อหน้า");
    expect(page).toContain("editorTarget && editorTarget.findingId === finding.id");
    expect(page).toContain("editorTarget && !editorTarget.findingId");
    expect(page).toContain('submitEditorEdit("autosave")');
    expect(page).toContain("บันทึกทันที + ตรวจซ้ำ");
    expect(page).toContain("Workspace Editor");
    expect(page).toContain('id="workspace-chapter-editor"');
    expect(page).toContain("Workspace Editor ·");
    expect(page).toContain("แท็บใน Draft");
    expect(page).toContain("แท็บที่นำออก");
    expect(page).toContain("เครื่องมือแก้ไขรายย่อหน้า");
    expect(page).not.toContain("Draft structure ·");
    expect(page).not.toContain("Draft tabs");
    expect(page).toContain("Undo");
    expect(page).toContain("Chapter Editor");
    expect(page).toContain("เติมเนื้อหา");
    expect(page).toContain('kind: "replace_tab"');
    expect(page).toContain("ChapterEditorParagraphBlock");
    expect(page).toContain("pasteChapterEditorParagraphs");
    expect(page).toContain("วางจาก ChatGPT/Google Docs จะตัดบรรทัดว่างออกอัตโนมัติ");
    expect(page).toContain("ไฮไลต์คำต่างประเทศ");
    expect(page).toContain("chapterEditorTabStatus");
    expect(page).toContain("ก่อนหน้า");
    expect(page).toContain("ถัดไป");
    expect(page).toContain("Ctrl/Cmd+S = บันทึก");
    expect(page).toContain("beforeunload");
    expect(page).toContain("sessionStorage");
    expect(page).toContain("ยังไม่บันทึก");
    expect(page).toContain("savedChapterTarget");
    expect(page).toContain("Finding / Inline QC");
    expect(page).toContain("Previous finding");
    expect(page).toContain("Next finding");
    expect(page).toContain("navigateChapterEditorIssue");
    expect(page).toContain("ไปยัง structural issue");
    expect(page).toContain("StatusPill");
    expect(page).toContain("ไม่ Publish อัตโนมัติ");
  });
});
