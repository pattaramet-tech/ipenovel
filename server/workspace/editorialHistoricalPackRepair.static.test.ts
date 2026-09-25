import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(path, "utf8");

describe("Workspace historical Episode Pack repair planning", () => {
  it("derives candidate coverage from the Workspace pack range instead of guessing boundaries", () => {
    const service = source("server/workspace/editorialHistoricalPackRepair.service.ts");
    expect(service).toContain("requestedEpisodeNumber");
    expect(service).toContain("expectedNumbers");
    expect(service).toContain("exactCoverage");
    expect(service).toContain("LEGACY_CHAPTER_COVERAGE_MISMATCH");
    expect(service).toContain('row.saleMode !== "chapter"');
  });

  it("blocks destructive repair planning when historical entitlements exist", () => {
    const service = source("server/workspace/editorialHistoricalPackRepair.service.ts");
    expect(service).toContain("episodePurchases");
    expect(service).toContain("purchases");
    expect(service).toContain("adminGiftEntitlements");
    expect(service).toContain("LEGACY_CHAPTER_ENTITLEMENTS_PRESENT");
  });

  it("requires exact previewed ids, no entitlements, and web content before mutation", () => {
    const service = source("server/workspace/editorialHistoricalPackRepair.service.ts");
    expect(service).toContain("Historical repair chapter IDs changed after preview");
    expect(service).toContain("Legacy chapter entitlements appeared during repair");
    expect(service).toContain("A legacy chapter has no web-reader content");
    expect(service).toContain("Legacy chapter content format is not plain_text");
    expect(service).toContain("affected !== expectedIds.length");
    expect(service).toContain("workspace_historical_pack_repaired_v1");
  });

  it("requires explicit package sale metadata and exposes preview/repair through the admin router", () => {
    const service = source("server/workspace/editorialHistoricalPackRepair.service.ts");
    const router = source("server/workspace/router.ts");
    expect(service).toContain('context.workItem.saleMode === "package"');
    expect(service).toContain("SALE_METADATA_MISSING_OR_INVALID");
    expect(router).toContain("historicalPackRepairPreview: adminProcedure");
    expect(router).toContain("getHistoricalPackRepairPreview");
    expect(router).toContain("repairHistoricalPack: adminProcedure");
    expect(router).toContain("requireWorkspacePublishEnvironmentSafety()");
    expect(router).toContain("repairHistoricalPublishedPack");
    expect(service).toContain("requireWorkspacePublishEnvironmentSafety()");
  });
});
