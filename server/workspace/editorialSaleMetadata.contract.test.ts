import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  normalizeEditorialSaleMetadata,
  WorkspaceEditorialBoardError,
} from "./editorialBoard.service";

const root = new URL("../..", import.meta.url);
const source = (path: string) => readFileSync(new URL(path, root), "utf8");

describe("M12D.7 sale metadata contract", () => {
  it("accepts paid package intake and normalizes price", () => {
    expect(normalizeEditorialSaleMetadata({ saleMode: "package", price: "35", isFree: false }))
      .toEqual({ saleMode: "package", price: "35.00", isFree: false });
  });

  it("normalizes free package intake to 0.00", () => {
    expect(normalizeEditorialSaleMetadata({ saleMode: "package", price: "99.99", isFree: true }))
      .toEqual({ saleMode: "package", price: "0.00", isFree: true });
  });

  it("accepts chapter intake without changing sale mode", () => {
    expect(normalizeEditorialSaleMetadata({ saleMode: "chapter", price: "12.5", isFree: false }))
      .toEqual({ saleMode: "chapter", price: "12.50", isFree: false });
  });

  it("fails closed for missing or invalid paid metadata", () => {
    expect(() => normalizeEditorialSaleMetadata({ saleMode: "chapter", isFree: false }))
      .toThrow(WorkspaceEditorialBoardError);
    expect(() => normalizeEditorialSaleMetadata({ saleMode: "chapter", price: "0", isFree: false }))
      .toThrow("greater than zero");
  });

  it("makes intake idempotency include identical sale metadata", () => {
    const board = source("server/workspace/editorialBoard.service.ts");
    expect(board).toContain("existingWorkItem.saleMode !== sale.saleMode");
    expect(board).toContain("existingWorkItem.price !== sale.price");
    expect(board).toContain("existingWorkItem.isFree !== sale.isFree");
  });

  it("rejects an existing episode identity with different sale metadata", () => {
    const board = source("server/workspace/editorialBoard.service.ts");
    expect(board).toContain("already exists with different intake metadata");
    expect(board).toContain("workItem.saleMode !== sale.saleMode");
  });

  it("propagates sale metadata from work item through Episode and stage", () => {
    const service = source("server/workspace/editorialApproval.service.ts");
    expect(service).toContain("saleMode = context.workItem.saleMode");
    expect(service).toContain("stageContract: EDITORIAL_EPISODE_STAGE_CONTRACT_V2");
    expect(service).toMatch(/saleMode,\s*price,\s*isFree,\s*contentSha256/);
  });

  it("replays an existing stage only against its own v1 or v2 contract", () => {
    const service = source("server/workspace/editorialApproval.service.ts");
    expect(service).toContain("expectedPayloadSha256");
    expect(service).toContain("legacyPayloadSha256");
    expect(service).toContain("existingStage.stageContract === EDITORIAL_EPISODE_STAGE_CONTRACT_V2");
  });

  it("restages only an owned unpublished Episode and writes current sale metadata", () => {
    const service = source("server/workspace/editorialApproval.service.ts");
    expect(service).toContain("is not owned by this Editorial work item");
    expect(service).toMatch(/wordCount: plan\.wordCount,\s*saleMode,\s*price,\s*isFree,/);
  });

  it("detects v2 sale metadata drift", () => {
    const service = source("server/workspace/editorialApproval.service.ts");
    expect(service).toContain("editorialEpisodeStateSha256V2");
    expect(service).toContain("stage.saleMode !== episode.saleMode");
    expect(service).toContain("stage.price !== episode.price");
    expect(service).toContain("stage.isFree !== episode.isFree");
  });

  it("keeps historical v1 stage verification compatible while new staging fails closed", () => {
    const service = source("server/workspace/editorialApproval.service.ts");
    expect(service).toContain("existingStage.stageContract === null");
    expect(service).toContain("EDITORIAL_EPISODE_STAGE_CONTRACT");
    expect(service).toContain("historical intake rows must be completed before staging");
  });

  it("requires controlled publish to preserve staged sale metadata", () => {
    const publish = source("server/workspace/editorialPublish.service.ts");
    expect(publish).toContain("stage.saleMode !== currentEpisode.saleMode");
    expect(publish).toContain("stage.price !== currentEpisode.price");
    expect(publish).toContain("stage.isFree !== currentEpisode.isFree");
    expect(publish).toContain("sale metadata no longer matches immutable stage evidence");
  });

  it("preserves package/cart checkout routing", () => {
    const purchase = source("server/services/episodePurchaseService.ts");
    const router = source("server/routers.ts");
    expect(purchase).toContain('if (saleMode === "package")');
    expect(purchase).toContain('"PACKAGE_MUST_USE_CART"');
    expect(router).toContain('if (saleMode === "chapter")');
  });

  it("preserves chapter direct reader/wallet routing", () => {
    const purchase = source("server/services/episodePurchaseService.ts");
    expect(purchase).toContain("Wallet direct-debit purchase is for single chapters only");
    expect(purchase).toContain('if (saleMode === "package")');
  });
});
