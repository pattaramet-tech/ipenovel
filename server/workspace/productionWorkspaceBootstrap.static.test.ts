import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../..", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");

describe("M12D.11 Production Workspace bootstrap", () => {
  it("shows first-run Workspace creation instead of a permanently hidden form", () => {
    const page = read("client/src/pages/WorkspacePage.tsx");
    expect(page).toContain(
      'workspaces.data?.length ? "hidden" : "space-y-4 p-5"'
    );
    expect(page).toContain("create.mutate({ name })");
    expect(page).toContain("setSelectedWorkspaceId(workspaceId)");
    expect(page).toContain('placeholder="Workspace name"');
  });

  it("exposes a self-service Google Docs connect action and fixed callback flow", () => {
    const page = read("client/src/pages/WorkspacePage.tsx");
    const oauth = read("server/workspace/googleDocs.oauth.ts");
    const index = read("server/_core/index.ts");

    expect(page).toContain('window.location.assign("/api/workspace/google/start")');
    expect(page).toContain("เชื่อม Google Docs");
    expect(oauth).toContain('app.get("/api/workspace/google/start"');
    expect(oauth).toContain("app.get(WORKSPACE_DOCS_CALLBACK_PATH");
    expect(oauth).toContain("consumeGoogleConsentAttempt");
    expect(oauth).toContain("saveGoogleConnection");
    expect(oauth).not.toMatch(/req\.headers\.(host|origin)|x-forwarded-host/i);
    expect(oauth).not.toContain("returnTo");
    expect(index.indexOf("registerWorkspaceGoogleDocsOAuthRoutes(app)")).toBeLessThan(
      index.indexOf('app.use(\r\n    "/api/trpc"')
    );
  });
});
