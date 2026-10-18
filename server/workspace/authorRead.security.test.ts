import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("IPE-070R4A-R2 database authorization security contracts", () => {
  it("uses joined SQL authorization, not a disconnected JavaScript predicate", () => {
    const service = source("./authorRead.service.ts");
    for (const clause of [
      'eq(users.role, "author")',
      'eq(workspaceMembers.userId, actorUserId)',
      'eq(workspaceMembers.status, "active")',
      'eq(workspaceWorkspaces.status, "active")',
      'isNull(workspaceWorkspaces.deletedAt)',
      'eq(workspaceNovels.status, "active")',
      "eq(novels.authorUserId, actorUserId)",
    ]) expect(service).toContain(clause);
    expect(service).not.toContain("canReadAuthorWorkspaceRow");
    expect(service).toContain("authorScope(actorUserId)");
    expect(service).toContain("eq(workspaceEditorialWorkItems.id, workItemId)");
  });

  it("bounds each collection by safe keyset pagination and repeats the SQL scope", () => {
    const service = source("./authorRead.service.ts");
    const router = source("./authorRead.router.ts");
    expect(service).toContain("AUTHOR_READ_PAGE_MAX = 100");
    expect(service).toContain("selectDistinct");
    expect(service).toContain("nextCursor");
    expect(service).toContain("limit(limit + 1)");
    expect(service).toContain("gt(workspaceWorkspaces.id, cursor)");
    expect(service).toContain("gt(workspaceNovels.id, cursor)");
    expect(service).toContain("gt(workspaceEditorialWorkItems.id, cursor)");
    expect(service).not.toContain(".limit(1000)");
    expect(router).toContain("limit: z.number().int().min(1).max(100)");
  });

  it("exposes only Author queries, not Workspace mutations or global admin DTOs", () => {
    const router = source("./authorRead.router.ts");
    for (const name of ["list", "detail", "novels", "workItems", "draft"]) {
      expect(router).toContain(name + ": authorReadProcedure");
    }
    expect(router).toContain("authorContentProcedure.use");
    expect(router).toContain('ctx.user.role !== "author"');
    expect(router).not.toContain(".mutation(");
    expect(router).not.toContain("adminProcedure");
    expect(source("./authorRead.service.ts")).not.toContain("requireWorkspacePlatformAdmin");
  });

  it("keeps the existing Admin-only service/route boundaries intact", () => {
    const router = source("./router.ts");
    const adminAccess = source("./adminAccess.ts");
    expect(router).toContain('import { adminProcedure, router } from "../_core/trpc"');
    expect(router).toContain("authorRead: workspaceAuthorReadRouter");
    expect(router).toContain("authorEditorial: workspaceAuthorEditorialRouter");
    expect(router).toContain("requestExecution: adminProcedure");
    expect(router).toContain("cutover: adminProcedure");
    expect(router).toContain("rollback: adminProcedure");
    expect(router).toContain("requestPublish: adminProcedure");
    expect(adminAccess).toContain('user.role !== "admin"');
  });

  it("binds the truthful route adapter, preserves Admin Workspace and uses only paginated read queries", () => {
    const app = source("../../client/src/App.tsx");
    const entry = source("../../client/src/pages/WorkspaceRoutePage.tsx");
    const page = source("../../client/src/pages/AuthorWorkspacePage.tsx");
    expect(app).toContain('import WorkspaceRoutePage from "./pages/WorkspaceRoutePage"');
    expect(app).toContain('<Route path={"/workspace"} component={WorkspaceRoutePage} />');
    expect(entry).toContain('import WorkspacePage from "./WorkspacePage"');
    expect(entry).toContain('import AuthorWorkspacePage from "./AuthorWorkspacePage"');
    expect(entry).toContain('user?.role === "author"');
    expect(entry).toContain("<WorkspacePage />");
    expect(entry).toContain("<AuthorWorkspacePage />");
    expect(page).toContain("trpc.workspace.authorRead.list.useInfiniteQuery");
    expect(page).toContain("trpc.workspace.authorRead.novels.useInfiniteQuery");
    expect(page).toContain("trpc.workspace.authorRead.workItems.useInfiniteQuery");
    expect(page).toContain("trpc.workspace.authorRead.draft.useQuery");
    expect(page).toContain("trpc.workspace.authorEditorial.surface.useQuery");
    expect(page).toContain("trpc.workspace.authorEditorial.edit.useMutation");
    expect(page).toContain("trpc.workspace.authorEditorial.runChecker.useMutation");
    expect(page).toContain("trpc.workspace.authorEditorial.resolveFinding.useMutation");
    expect(page).toContain("trpc.workspace.authorEditorial.approve.useMutation");
    expect(page).toContain("trpc.workspace.authorEditorial.stage.useMutation");
    expect(page).toContain("stageActionReady");
    expect(page).toContain("confirmDiscardUnsavedEdits");
    expect(page).toContain("authorCanvasFindings");
    expect(page).toContain("authorMutationNotice");
    expect(page).not.toContain("!data.approval.stageReady");
    expect(page).toContain("fetchNextPage()");
    expect(page).not.toContain("trpc.workspace.editorial");
    expect(page).not.toContain("requestPublish");
    expect(page).not.toContain("publishCutover");
    expect(page).not.toContain("authorEditorial.publish");
  });
});
