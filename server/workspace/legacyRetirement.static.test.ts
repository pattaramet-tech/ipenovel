import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const domain = readFileSync(new URL("./legacyRetirement.domain.ts", import.meta.url), "utf8");
const service = readFileSync(new URL("./legacyRetirement.service.ts", import.meta.url), "utf8");
const router = readFileSync(new URL("./router.ts", import.meta.url), "utf8");

describe("workspace M06 legacy retirement candidate static boundaries", () => {
  it("is candidate/read-only only and encodes separate approval plus fallback retention", () => {
    expect(domain).toContain('WORKSPACE_LEGACY_RETIREMENT_CANDIDATE_CONTRACT = "workspace-legacy-retirement-candidate-v1"');
    expect(domain).toContain("separateHumanApprovalRequired: true");
    expect(domain).toContain("retirementApplied: false");
    expect(domain).toContain("automaticRetirement: false");
    expect(domain).toContain("legacyPathsRetained: true");
    expect(domain).toContain("zipFallbackRetained: true");
    expect(domain).toContain("readExportFallbackRetained: true");
  });

  it("never mutates ownership, publish delivery, legacy paths, or ZIP services", () => {
    expect(service).not.toMatch(/\.insert\(|\.update\(|\.delete\(/);
    expect(service).not.toMatch(/packageZipImportService|importPackageZip|parsePackageZip|multiNovel/i);
    expect(service).not.toMatch(/cutoverPublishOwnership|rollbackPublishOwnership|requestPublishExecution/);
    expect(service).toContain("legacyMutationApplied: false");
    expect(service).toContain("zipMutationApplied: false");
    expect(service).toContain("registryMutationApplied: false");
    expect(service).toContain("publishDeliveryApplied: false");
  });

  it("exposes only query procedures for the M06 package/readiness gate", () => {
    expect(router).toContain("legacyRetirement: router({");
    const block = router.slice(router.indexOf("legacyRetirement: router({"), router.indexOf("kanban: router({"));
    expect(block).toContain("package: authenticatedProcedure");
    expect(block).toContain("requireCandidateReadiness: authenticatedProcedure");
    expect(block).toContain(".query(async");
    expect(block).not.toContain(".mutation(async");
  });
});
