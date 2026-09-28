import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

describe("M29 Workspace Master Intake safety", () => {
  it("persists Sheet row provenance and C/E with optional O without touching publish/writeback", () => {
    const service = read("server/workspace/masterIntake.service.ts");
    const schema = read("drizzle/schema.ts");
    expect(schema).toContain("workspaceMasterIntakeRows");
    expect(schema).toContain("translationDocUrl");
    expect(schema).toContain("webSourceUrl");
    expect(schema).toContain("preparedSourceDocUrl");
    expect(service).toContain("workspace_master_intake_sync_v1");
    expect(service).toContain("defaultEditorialEpisodePackSaleFromRange");
    expect(service).toContain("saleMode: defaultSale.saleMode");
    expect(service).toContain("price: defaultSale.price");
    expect(service).toContain("isFree: defaultSale.isFree");
    expect(service).not.toContain("allowPendingSaleMetadata: true");
    expect(service).not.toMatch(/requestEditorialPublish|requestPublishExecution|confirmNqaAdminWriteback|writeRange|batchUpdateValues/);
  });

  it("keeps preview separate from sync and requires a stale-preview fingerprint", () => {
    const service = read("server/workspace/masterIntake.service.ts");
    const router = read("server/workspace/router.ts");
    expect(service).toContain("previewWorkspaceMasterIntake");
    expect(service).toContain("expectedPreviewFingerprint");
    expect(service).toContain("STALE_PREVIEW");
    expect(router).toContain("masterIntakePreview");
    expect(router).toContain("masterIntakeSync");
    expect(router).toContain("expectedPreviewFingerprint");
  });

  it("caps bulk reads at 100 rows and creates new novels archived through the existing service", () => {
    const domain = read("server/workspace/masterIntake.domain.ts");
    const service = read("server/workspace/masterIntake.service.ts");
    const workspaceService = read("server/workspace/service.ts");
    expect(domain).toContain("MASTER_INTAKE_MAX_ROWS = 100");
    expect(service).toContain("createWorkspacePublicationNovel");
    expect(workspaceService).toContain('publicationStatus: "archived"');
  });

  it("fails closed on batch overlap, shifted provenance and advanced-pack refresh", () => {
    const service = read("server/workspace/masterIntake.service.ts");
    expect(service).toContain("DUPLICATE_BATCH_EPISODE_IDENTITY");
    expect(service).toContain("BATCH_EPISODE_RANGE_OVERLAP");
    expect(service).toContain("WORK_ITEM_ALREADY_LINKED_TO_SHEET_ROW");
    expect(service).toContain("EXISTING_PACK_NOT_EDITABLE");
    expect(service).toContain("SOURCE_ALREADY_LINKED");
    expect(service).toContain("provenanceSourceAlreadyLinked");
  });

  it("reuses a novel created earlier in the same bulk sync", () => {
    const service = read("server/workspace/masterIntake.service.ts");
    expect(service).toContain("normalizeMasterIntakeNovelTitle(row.novelTitle!)");
    expect(service).toContain("matching.length === 1");
    expect(service).toContain("bindPublicationNovel");
  });

  it("reads prepared source from optional O, ignores K notes, and ignores malformed/non-link O", () => {
    const service = read("server/workspace/masterIntake.service.ts");
    expect(service).toContain('\":O\" +');
    expect(service).toContain('String(cells[13] ?? "").trim()');
    expect(service).not.toContain('String(cells[9] ?? "").trim()');
    expect(service).toContain("const preparedSourceDocUrl = preparedSourceDocumentId ? preparedSourceRaw : \"\"");
    expect(service).toContain("preparedSourceDocUrl: preparedSourceDocUrl || null");
    expect(service).not.toContain("PREPARED_SOURCE_DOC_INVALID");
    const page = read("client/src/pages/WorkspacePage.tsx");
    expect(page).toContain('href={row.preparedSourceDocUrl} target="_blank" rel="noreferrer">O</a>');
    expect(page).not.toContain('href={row.preparedSourceDocUrl} target="_blank" rel="noreferrer">K</a>');
    const migration = read("drizzle/0056_workspace_master_intake_optional_prepared_source.sql");
    expect(migration).toContain("preparedSourceDocUrl");
    expect(migration).toContain("preparedSourceDocumentId");
    expect(migration).toContain("NULL");
  });

  it("applies the same default pricing contract during Master Intake and Stage", () => {
    const intake = read("server/workspace/masterIntake.service.ts");
    const approval = read("server/workspace/editorialApproval.service.ts");
    expect(intake).toContain("defaultEditorialEpisodePackSaleFromRange");
    expect(approval).toContain("resolveEditorialEpisodePackSale");
    expect(approval).toContain("effectiveSale.usesDefault");
  });

  it("restores a removed MATCH pack through the shared Episode intake path", () => {
    const service = read("server/workspace/masterIntake.service.ts");
    const board = read("server/workspace/editorialBoard.service.ts");
    expect(service).toContain("createEditorialEpisodeWorkItem");
    expect(board).toContain('existingCard.status === "archived"');
    expect(board).toContain('reason: "editorial_episode_restore"');
  });

  it("registers migration 0055 exactly once", () => {
    const journal = JSON.parse(read("drizzle/meta/_journal.json"));
    const entries = journal.entries.filter(
      (entry: any) => entry.tag === "0055_workspace_master_intake_sync"
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].idx).toBe(55);
    expect(read("drizzle/0055_workspace_master_intake_sync.sql")).toContain(
      "workspaceMasterIntakeRows"
    );
    const optionalKEntries = journal.entries.filter(
      (entry: any) => entry.tag === "0056_workspace_master_intake_optional_prepared_source"
    );
    expect(optionalKEntries).toHaveLength(1);
    expect(optionalKEntries[0].idx).toBe(56);
  });
});
