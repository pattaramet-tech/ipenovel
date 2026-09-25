import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("IPE-056-K Draft tab exclusion / restore", () => {
  const service = fs.readFileSync(path.resolve(process.cwd(), "server/workspace/editorialEditor.service.ts"), "utf8");
  const router = fs.readFileSync(path.resolve(process.cwd(), "server/workspace/router.ts"), "utf8");
  const page = fs.readFileSync(path.resolve(process.cwd(), "client/src/pages/WorkspacePage.tsx"), "utf8");

  it("creates immutable manual Draft revisions rather than deleting source tabs", () => {
    expect(service).toContain('"manual_tab_exclude"');
    expect(service).toContain('"manual_tab_restore"');
    expect(service).toContain("parentDraftId: current.id");
    expect(service).toContain("Draft must keep at least one tab");
    expect(service).not.toContain("delete(workspaceEditorialDraftTabs)");
  });

  it("restores excluded tabs from Draft ancestry", () => {
    expect(service).toContain("Excluded tab could not be restored from Draft history");
    expect(service).toContain("excludedTabs");
    expect(service).toContain("workspace_editor_tab_");
  });

  it("requires optimistic Draft identity and explicit confirmation in UI", () => {
    expect(router).toContain("editorExcludeTab: adminProcedure");
    expect(router).toContain("editorRestoreTab: adminProcedure");
    expect(page).toContain("window.confirm");
    expect(page).toContain("นำออก");
    expect(page).toContain("คืนแท็บ");
  });
});
