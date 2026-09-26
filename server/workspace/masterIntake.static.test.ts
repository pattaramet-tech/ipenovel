import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

describe("M29 Workspace Master Intake safety", () => {
  it("persists Sheet row provenance and C/E/K links without touching publish/writeback", () => {
    const service = read("server/workspace/masterIntake.service.ts");
    const schema = read("drizzle/schema.ts");
    expect(schema).toContain("workspaceMasterIntakeRows");
    expect(schema).toContain("translationDocUrl");
    expect(schema).toContain("webSourceUrl");
    expect(schema).toContain("preparedSourceDocUrl");
    expect(service).toContain("workspace_master_intake_sync_v1");
    expect(service).toContain("allowPendingSaleMetadata: true");
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
  });
});
