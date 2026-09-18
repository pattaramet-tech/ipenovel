import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../..", import.meta.url);
const source = (path: string) => readFileSync(new URL(path, root), "utf8");

describe("Workspace Editorial board B1/B2 static boundaries", () => {
  it("reuses transition-backed Kanban movement truth without publish/AI side effects", () => {
    const service = source("server/workspace/editorialBoard.service.ts");
    expect(service).toContain("workspaceKanbanBoards");
    expect(service).toContain("workspaceKanbanColumns");
    expect(service).toContain("workspaceKanbanCards");
    expect(service).toContain("workspaceKanbanTransitions");
    expect(service).toContain("workspaceEditorialWorkItems");
    expect(service).toContain("workspaceEditorialWorkItemEvents");
    expect(service).not.toMatch(
      /workspaceDocumentSnapshots|workspacePublish|workspaceAi/
    );
    expect(service).not.toMatch(/\bepisodes\b/);
  });

  it("keeps migration 0046 additive and Workspace-only", () => {
    const migration = source("drizzle/0046_workspace_editorial_work_items.sql");
    expect(migration).toContain("workspaceEditorialWorkItems");
    expect(migration).toContain("workspaceEditorialWorkItemEvents");
    expect(migration).not.toMatch(/DROP TABLE|DROP COLUMN|DROP FOREIGN KEY/i);
    expect(migration).not.toMatch(/accountMerge|payment|wallet|episodePurchases/i);
  });

  it("materializes story and episode metadata with idempotent identities", () => {
    const service = source("server/workspace/editorialBoard.service.ts");
    expect(service).toContain("editorialStoryLogicalKey");
    expect(service).toContain("editorialEpisodeLogicalKey");
    expect(service).toContain('workItemType: "new_story"');
    expect(service).toContain('workItemType: "new_episode"');
    expect(service).toContain('idempotencyKey: "metadata-initial"');
    expect(service).toContain('reason: "editorial_episode_intake"');
  });

  it("keeps intake admin-gated and creates new publication novels hidden", () => {
    const router = source("server/workspace/router.ts");
    const workspaceService = source("server/workspace/service.ts");
    expect(router).toContain("editorial: router({");
    expect(router).toContain("ensureBoard: adminProcedure");
    expect(router).toContain("createEpisode: adminProcedure");
    expect(router).toContain("assignWorkItem: adminProcedure");
    expect(router).toContain("createNovel: adminProcedure");
    expect(router).toContain("availablePublicationNovels: adminProcedure");
    expect(workspaceService).toContain('publicationStatus: "archived"');
    expect(workspaceService).not.toContain('publicationStatus: "published" as const');
  });
});
