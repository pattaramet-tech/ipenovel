import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("IPE-056-J Episode Pack guardrails", () => {
  const service = fs.readFileSync(path.resolve(process.cwd(), "server/workspace/editorialBoard.service.ts"), "utf8");
  const router = fs.readFileSync(path.resolve(process.cwd(), "server/workspace/router.ts"), "utf8");
  const page = fs.readFileSync(path.resolve(process.cwd(), "client/src/pages/WorkspacePage.tsx"), "utf8");

  it("blocks numeric duplicate/overlapping active episode packs", () => {
    expect(service).toContain("parseEpisodeSpan");
    expect(service).toContain("spansOverlap");
    expect(service).toContain("Episode range overlaps existing pack");
    expect(service).toContain('eq(workspaceKanbanCards.status, "active")');
  });

  it("only edits/removes pristine New packs and preserves durable source history", () => {
    expect(service).toContain("requireEditableEpisodePack");
    expect(service).toContain('row.column.key !== "new"');
    expect(service).toContain("Episode Pack already has source/Draft evidence");
    expect(service).toContain('set({ status: "archived" })');
    expect(service).not.toContain("delete(workspaceEditorialWorkItems)");
  });

  it("exposes edit/remove actions via the pack row menu (table retired, IPE-064)", () => {
    expect(router).toContain("updateEpisode: adminProcedure");
    expect(router).toContain("removeEpisode: adminProcedure");
    expect(page).toContain("updateEditorialEpisode");
    expect(page).toContain("removeEditorialEpisode");
    const menu = fs.readFileSync(path.resolve(process.cwd(), "client/src/pages/EditorialPackRowActionsMenu.tsx"), "utf8");
    expect(menu).toContain("แก้ช่วงตอน");
    expect(menu).toContain("นำออก");
  });
});
