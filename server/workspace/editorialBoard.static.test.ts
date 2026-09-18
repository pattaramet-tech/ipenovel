import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../..", import.meta.url);
const source = (path: string) => readFileSync(new URL(path, root), "utf8");

describe("Workspace Editorial board B1 static boundaries", () => {
  it("reuses transition-backed Kanban storage without introducing a migration", () => {
    const service = source("server/workspace/editorialBoard.service.ts");
    expect(service).toContain("workspaceKanbanBoards");
    expect(service).toContain("workspaceKanbanColumns");
    expect(service).toContain("workspaceKanbanCards");
    expect(service).toContain("workspaceKanbanTransitions");
    expect(service).not.toMatch(
      /workspaceDocumentSnapshots|workspacePublish|workspaceAi/
    );
  });

  it("materializes NEW STORY cards without resetting moved cards", () => {
    const service = source("server/workspace/editorialBoard.service.ts");
    expect(service).toContain("editorialStoryLogicalKey");
    expect(service).toContain("workspaceKanbanCards.id");
    expect(service).toContain('idempotencyKey: "editorial-initial"');
    expect(service).toContain('reason: "editorial_story_bound"');
  });

  it("keeps the new surface admin-gated and exposes existing novel options", () => {
    const router = source("server/workspace/router.ts");
    expect(router).toContain("editorial: router({");
    expect(router).toContain("ensureBoard: adminProcedure");
    expect(router).toContain("availablePublicationNovels: adminProcedure");
  });
});
