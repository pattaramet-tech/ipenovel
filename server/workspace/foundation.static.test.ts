import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../..", import.meta.url);

function source(relativePath: string) {
  return readFileSync(new URL(relativePath, root), "utf8");
}

describe("workspace M01 static safety", () => {
  it("keeps the Workspace router on session auth rather than the Google migration gate", () => {
    const router = source("server/workspace/router.ts");
    expect(router).toContain("authenticatedProcedure");
    expect(router).not.toContain("protectedProcedure");
  });

  it("has no live Google, publishing, Checker, or AI Queue implementation surface", () => {
    const service = source("server/workspace/service.ts");
    expect(service).not.toMatch(/googleapis|drive\.files|docs\.documents|fetch\(/i);
    expect(service).not.toMatch(/publishRun|checkerRun|aiJob|outbox/i);
    expect(service).toContain('sourceKind: "synthetic"');
    expect(service).toContain("buildInitialMigrationOwnership");
  });

  it("registers a dedicated /workspace page without changing legacy routes", () => {
    const app = source("client/src/App.tsx");
    expect(app).toContain('<Route path={"/workspace"} component={WorkspacePage} />');
    expect(app).toContain('<Route path={"/admin"} component={AdminDashboard} />');
  });

  it("keeps every first-run migration owner as Sheets", () => {
    const schema = source("drizzle/schema.ts");
    expect(schema).toContain('owner: mysqlEnum("owner", ["sheets", "workspace", "paused"]).default("sheets")');
    expect(schema).toContain("workspaceReadOnlyBindings");
  });
});
