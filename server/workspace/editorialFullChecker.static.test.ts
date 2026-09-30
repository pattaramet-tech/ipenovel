import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../..", import.meta.url);
const source = (path: string) => readFileSync(new URL(path, root), "utf8");

describe("IPE-058-D Full Checker static boundaries", () => {
  it("binds apply to exact Draft and preview identity before creating a revision", () => {
    const service = source("server/workspace/editorialEditor.service.ts");
    expect(service).toContain("current.id !== input.expectedDraftId");
    expect(service).toContain("current.version !== input.expectedDraftVersion");
    expect(service).toContain("current.draftSha256 !== input.expectedDraftSha256");
    expect(service).toContain("preview.transformId !== input.expectedTransformId");
    expect(service).toContain("!preview.idempotent");
    expect(service).toContain('transformCode: "full_checker_transform"');
    expect(service).toContain("parentDraftId: current.id");
    expect(service).toContain("version: current.version + 1");
  });

  it("reuses the established idempotency and QC-currentness boundary without a new schema enum", () => {
    const service = source("server/workspace/editorialEditor.service.ts");
    expect(service).toContain("workspaceEditorialDraftEditEvents.idempotencyKey");
    expect(service).toContain('editKind: "bulk_cleanup"');
    expect(service).toContain('reason: "workspace_full_checker_transform"');
    expect(service).toContain('targetColumnKey: "editing"');
    expect(service).toContain("expectedDraftId: persisted.draftId");
  });

  it("keeps Full Checker pure from publish, Stage and external-runtime mutation", () => {
    const domain = source("server/workspace/editorialFullChecker.domain.ts");
    expect(domain).not.toMatch(
      /DocumentApp|SpreadsheetApp|documents:batchUpdate|workspacePublish|insert\(episodes\)|update\(episodes\)|fetch\(|openai|gemini/i
    );
  });

  it("exposes read/preview and explicit apply only through admin Workspace procedures", () => {
    const router = source("server/workspace/router.ts");
    expect(router).toContain("fullChecker: adminProcedure");
    expect(router).toContain("fullCheckerApply: adminProcedure");
    expect(router).toContain("expectedTransformId");
    expect(router).toContain('"all_safe"');
  });

  it("renders bounded findings, preview diff and explicit Draft-revision apply in the single editor surface", () => {
    const page = source("client/src/pages/WorkspacePage.tsx");
    expect(page).toContain("Full Checker vNext");
    expect(page).toContain("Safe Transform Preview");
    expect(page).toContain("Preview เท่านั้น · ไม่มีการ apply อัตโนมัติ");
    expect(page).toContain("ก่อน:");
    expect(page).toContain("หลัง:");
    expect(page).toContain("Apply เป็น Draft revision ใหม่");
    expect(page).toContain("expectedTransformId: preview.transformId");
  });
});
