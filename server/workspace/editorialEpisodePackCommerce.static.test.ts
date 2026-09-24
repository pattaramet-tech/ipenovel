import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const source = (path: string) => readFileSync(path, "utf8");

describe("IPE-056-Q Episode Pack commerce + reader entitlement", () => {
  it("stages one package product and binds the Workspace-configured commerce metadata", () => {
    const service = source("server/workspace/editorialApproval.service.ts");
    const board = source("server/workspace/editorialBoard.service.ts");
    const router = source("server/workspace/router.ts");
    expect(service).toContain("buildEditorialEpisodePackPlan(batchPlan)");
    expect(service).toContain("for (const plan of [packPlan])");
    expect(service).toContain("const saleMode = context.workItem.saleMode");
    expect(service).toContain("const price = context.workItem.price");
    expect(service).toContain("const isFree = context.workItem.isFree");
    expect(service).toContain("price: sale?.price ?? pack.price");
    expect(board).toContain("Workspace Episode Pack intake supports package commerce only.");
    expect(router).toContain('saleMode: z.literal("package").default("package")');
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
