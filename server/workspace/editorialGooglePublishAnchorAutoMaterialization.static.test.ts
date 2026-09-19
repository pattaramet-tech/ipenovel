import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const source = readFileSync("server/workspace/editorialPublish.service.ts", "utf8");

describe("IPE-056-R Google Docs publish anchor auto-materialization", () => {
  it("materializes a missing anchor while building the publish read model", () => {
    expect(source).toContain("let anchor = await loadAnchor");
    expect(source).toContain("anchor = await materializeEditorialGoogleAnchor(db");
    expect(source).toContain("workspaceNovelId: context.workspaceNovel.id");
    expect(source).toContain("workItemId: input.workItemId");
  });

  it("keeps source identity scoped by provider document and durable Google connection", () => {
    expect(source).toContain("eq(workspaceDocuments.providerFileId, workspaceEditorialSources.providerDocumentId)");
    expect(source).toContain("eq(workspaceDocuments.connectionId, workspaceEditorialSources.googleConnectionId)");
    expect(source).toContain("sources.length !== 1 || !sources[0]?.providerDocumentId");
  });

  it("reactivates the exact existing binding instead of creating an ambiguous duplicate", () => {
    expect(source).toContain('else if (binding.status !== "active")');
    expect(source).toContain('set({ status: "active", version: binding.version + 1, updatedAt: new Date() })');
  });
});
