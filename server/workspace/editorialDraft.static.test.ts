import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../..", import.meta.url);
const source = (path: string) => readFileSync(new URL(path, root), "utf8");

describe("Workspace Editorial source/draft static boundaries", () => {
  it("keeps migration 0047 additive and Workspace-only", () => {
    const migration = source(
      "drizzle/0047_workspace_editorial_source_draft.sql"
    );
    expect(migration).toContain("workspaceEditorialSources");
    expect(migration).toContain("workspaceEditorialSourceSnapshots");
    expect(migration).toContain("workspaceEditorialDrafts");
    expect(migration).toContain("workspaceEditorialDraftParagraphs");
    expect(migration).toContain("workspaceEditorialDraftTransforms");
    expect(migration).not.toMatch(/DROP TABLE|DROP COLUMN|DROP FOREIGN KEY/i);
    expect(migration).not.toMatch(
      /accountMerge|payment|wallet|episodePurchases|ALTER TABLE `episodes`/i
    );
  });

  it("stores originals separately and never mutates Google Docs", () => {
    const service = source("server/workspace/editorialDraft.service.ts");
    const google = source("server/workspace/editorialSource.googleDocs.ts");
    const googleDomain = source("server/workspace/googleDocs.domain.ts");
    expect(service).toContain("rawContentJson");
    expect(service).toContain("workspaceEditorialSourceSnapshots");
    expect(service).toContain("workspaceEditorialDraftTransforms");
    expect(service).toContain('.for("update")');
    expect(service).not.toMatch(
      /DocumentApp|batchUpdate|documents:batchUpdate/i
    );
    expect(googleDomain).toContain("documents.readonly");
    expect(googleDomain).toContain("drive.metadata.readonly");
    expect(google).toContain("document.revisionId");
    expect(google).not.toMatch(
      /DocumentApp|batchUpdate|documents:batchUpdate|method:\s*["']PATCH["']|method:\s*["']DELETE["']/i
    );
  });

  it("keeps content transforms separate from editor presentation", () => {
    const domain = source("server/workspace/editorialDraft.domain.ts");
    expect(domain).toContain('fontFamily: "Sarabun"');
    expect(domain).toContain("fontSizePt: 18");
    expect(domain).toContain("firstLineIndentPt: 36");
    expect(domain).toContain("spacingAfterPt: 10");
    expect(domain).toContain("presentation: EDITORIAL_DRAFT_PRESENTATION");
    expect(domain).not.toMatch(/setFontFamily|setFontSize|setIndentFirstLine/);
  });

  it("exposes source import/read endpoints only through admin procedures", () => {
    const router = source("server/workspace/router.ts");
    expect(router).toContain("sourceDraft: adminProcedure");
    expect(router).toContain("sourceSnapshot: adminProcedure");
    expect(router).toContain("importSource: adminProcedure");
    expect(router).toContain("importGoogleDoc: adminProcedure");
    expect(router).not.toContain("authenticatedProcedure");
  });

  it("does not couple C to checker, AI, approval, publish or publication episode mutation", () => {
    const service = source("server/workspace/editorialDraft.service.ts");
    const google = source("server/workspace/editorialSource.googleDocs.ts");
    expect(service).not.toMatch(
      /workspaceChecker|workspaceAi|workspacePublish|publishExecution|episodePurchases/
    );
    expect(google).not.toMatch(
      /workspaceChecker|workspaceAi|workspacePublish|publishExecution|episodePurchases/
    );
  });
});
