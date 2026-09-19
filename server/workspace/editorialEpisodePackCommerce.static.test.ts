import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const source = (path: string) => readFileSync(path, "utf8");

describe("IPE-056-Q Episode Pack commerce + reader entitlement", () => {
  it("stages one package product instead of one chapter product per Docs tab", () => {
    const service = source("server/workspace/editorialApproval.service.ts");
    const domain = source("server/workspace/editorialApproval.domain.ts");
    expect(service).toContain("buildEditorialEpisodePackPlan(batchPlan)");
    expect(service).toContain('saleMode: "package"');
    expect(service).toContain("price: packPlan.price");
    expect(domain).toContain("billableTabCount * EDITORIAL_EPISODE_PACK_PRICE_PER_TAB_BAHT");
  });

  it("routes package purchase through cart/checkout and package entitlement", () => {
    const routers = source("server/routers.ts");
    const purchase = source("server/services/episodePurchaseService.ts");
    const reader = source("server/services/readerService.ts");
    expect(routers).toContain('if (saleMode === "chapter")');
    expect(purchase).toContain('if (saleMode === "package")');
    expect(purchase).toContain('"PACKAGE_MUST_USE_CART"');
    expect(reader).toContain("hasPurchasedEpisode(userId, episodeId)");
  });

  it("keeps in-package chapter headings for Reader TOC navigation", () => {
    const domain = source("server/workspace/editorialApproval.domain.ts");
    const toc = source("client/src/utils/packageTocUtils.ts");
    expect(domain).toContain("item.sourceTitleLine");
    expect(toc).toContain("parsePackageToc");
    expect(toc).toContain("Chapter");
  });
});
