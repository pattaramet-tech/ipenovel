import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("IPE-056-L current fingerprint reconciliation", () => {
  const service = fs.readFileSync(path.resolve(process.cwd(), "server/workspace/editorialPublish.service.ts"), "utf8");

  it("scopes a Google Docs publish anchor to the current Episode Pack source", () => {
    expect(service).toContain("async function loadAnchor(db: any, workspaceNovelId: number, workItemId: number)");
    expect(service).toContain("eq(workspaceEditorialSources.workItemId, workItemId)");
    expect(service).toContain('eq(workspaceEditorialSources.sourceKind, "google_doc")');
    expect(service).toContain("eq(workspaceDocuments.providerFileId, workspaceEditorialSources.providerDocumentId)");
    expect(service).toContain("eq(workspaceDocumentBindings.workspaceNovelId, workspaceNovelId)");
    expect(service).toContain("const anchor = await loadAnchor(db, context.workspaceNovel.id, input.workItemId)");
  });

  it("fails closed for ambiguous or missing current Google source fingerprints", () => {
    expect(service).toContain("if (rows.length === 1) return rows[0]");
    expect(service).toContain("if (activeGoogleSources.length > 0) return null");
    expect(service).toContain("Publish ownership preparation requires exactly one current active document fingerprint.");
  });

  it("keeps the legacy single-anchor path only for work items without active Google sources", () => {
    expect(service).toContain("Legacy/uploaded-file work items have no provider document identity");
    expect(service).toContain("return legacyRows.length === 1 ? legacyRows[0] : null");
  });
});
