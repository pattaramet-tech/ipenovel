import fs from "node:fs";

import { describe, expect, it } from "vitest";

function source(path: string): string {
  return fs.readFileSync(path, "utf8");
}

describe("Workspace NQA Auto-Link composition isolation", () => {
  it("keeps Workspace Docs OAuth scopes read-only and separate from Auto-Link Sheets credentials", () => {
    const docs = source("server/workspace/googleDocs.domain.ts");
    const runtime = source("server/workspace/nqaAutolink.runtime.ts");

    expect(docs).toContain(
      '"https://www.googleapis.com/auth/drive.metadata.readonly"'
    );
    expect(docs).toContain(
      '"https://www.googleapis.com/auth/documents.readonly"'
    );
    expect(docs).not.toContain(
      '"https://www.googleapis.com/auth/spreadsheets"'
    );

    expect(runtime).toContain("NQA_AUTOLINK_GOOGLE_READ_ACCESS_TOKEN");
    expect(runtime).toContain("NQA_AUTOLINK_GOOGLE_WRITE_ACCESS_TOKEN");
    expect(runtime).toContain("READ_WRITE_CREDENTIALS_NOT_DISTINCT");
  });

  it("does not broaden NQA default enabled permission tiers or auto-bind/publish Workspace", () => {
    const controlPlane = source("server/nqa/controlPlane.ts");
    const runtime = source("server/workspace/nqaAutolink.runtime.ts");

    expect(controlPlane).toMatch(
      /NQA_V1_ENABLED_PERMISSION_TIERS\s*=\s*\[\s*"READ",\s*"QA_OPERATE",?\s*\]/
    );
    expect(runtime).not.toMatch(/bindPublicationNovel\s*\(/);
    expect(runtime).not.toMatch(/requestPublishExecution\s*\(/);
  });

  it("exposes status, preview, and confirm only through the admin-only Workspace router", () => {
    const router = source("server/workspace/router.ts");
    const block = router.slice(
      router.indexOf("nqaNovelLink: router({"),
      router.indexOf("migrationOwnership: adminProcedure")
    );

    expect(block).toContain("status: adminProcedure.query");
    expect(block).toContain("preview: adminProcedure");
    expect(block).toContain("confirmBackfill: adminProcedure");
    expect(block).not.toContain("publicProcedure");
    expect(block).not.toContain("protectedProcedure");
  });
});
