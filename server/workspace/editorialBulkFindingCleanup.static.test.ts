import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

describe("M29.1 Bulk Finding Cleanup safety", () => {
  it("has preview-first grouped cleanup and stale-preview protection", () => {
    const service = read(
      "server/workspace/editorialBulkFindingCleanup.service.ts"
    );
    const router = read("server/workspace/router.ts");
    expect(service).toContain("previewEditorialBulkFindingCleanup");
    expect(service).toContain("applyEditorialBulkFindingCleanup");
    expect(service).toContain("expectedPreviewFingerprint");
    expect(service).toContain("PREVIEW_STALE");
    expect(router).toContain("bulkFindingCleanupPreview");
    expect(router).toContain("bulkFindingCleanupApply");
  });

  it("creates one bulk cleanup Draft revision and keeps undo support", () => {
    const editor = read("server/workspace/editorialEditor.service.ts");
    const schema = read("drizzle/schema.ts");
    expect(editor).toContain('transformCode: "bulk_finding_cleanup"');
    expect(editor).toContain('editKind: "bulk_cleanup"');
    expect(schema).toContain('"bulk_cleanup"');
    expect(editor).toContain("undoEditorialEditorEdit");
  });

  it("reruns the checker after each changed work item", () => {
    const service = read(
      "server/workspace/editorialBulkFindingCleanup.service.ts"
    );
    expect(service).toContain("runEditorialForeignChecker");
    expect(service).toContain("expectedDraftId: edited.draft.id");
  });

  it("does not mutate Google Docs, Sheets, or Publish paths", () => {
    const service = read(
      "server/workspace/editorialBulkFindingCleanup.service.ts"
    );
    const editor = read("server/workspace/editorialEditor.service.ts");
    const combined = service + editor;
    expect(combined).not.toMatch(
      /fetchEditorialGoogleDocSource|refreshWorkspaceGoogle|batchUpdateValues|writeRange|requestEditorialPublish|requestPublishExecution/
    );
  });

  it("stores audit metadata without raw finding text", () => {
    const service = read(
      "server/workspace/editorialBulkFindingCleanup.service.ts"
    );
    expect(service).toContain("workspace_editorial_bulk_cleanup_v1");
    expect(service).toContain("errorSha256");
    expect(service).not.toContain("metadataJson: JSON.stringify({\n      fullContent");
  });

  it("registers migration 0057 exactly once", () => {
    const journal = JSON.parse(read("drizzle/meta/_journal.json"));
    const entries = journal.entries.filter(
      (entry: any) => entry.tag === "0057_workspace_editorial_bulk_cleanup"
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].idx).toBe(57);
    expect(read("drizzle/0057_workspace_editorial_bulk_cleanup.sql")).toContain(
      "bulk_cleanup"
    );
  });

  it("surfaces grouped cleanup controls in Workspace", () => {
    const page = read("client/src/pages/WorkspacePage.tsx");
    expect(page).toContain("3.1 จัดกลุ่ม / ลบซ้ำ");
    expect(page).toContain("ลบ Source Junk ทั้งหมด");
    expect(page).toContain("ลบทั้งหมด {group.occurrenceCount} จุด");
    expect(page).toContain("สร้าง Draft ใหม่ 1 version ต่อ Episode Pack");
  });
});
