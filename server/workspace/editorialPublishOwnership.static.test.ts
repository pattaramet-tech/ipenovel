import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("IPE-056-G guarded publish ownership preparation", () => {
  it("uses the existing dry-run and ownership cutover gates without enabling execution", () => {
    const publish = fs.readFileSync(path.resolve(process.cwd(), "server/workspace/editorialPublish.service.ts"), "utf8");
    const router = fs.readFileSync(path.resolve(process.cwd(), "server/workspace/router.ts"), "utf8");
    expect(publish).toContain("prepareEditorialPublishOwnership");
    expect(publish).toContain("createPublishDryRun");
    expect(publish).toContain("cutoverPublishOwnership");
    expect(publish).toContain('readinessPhase: "pre_publish"');
    expect(publish).toContain('expectedOwner: "sheets"');
    expect(publish).toContain("expectedCutoverEpoch: 0");
    expect(router).toContain("preparePublishOwnership: adminProcedure");
    expect(router).toContain("requireWorkspacePublishRequestPolicy");
  });
});
