import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../..", import.meta.url);
const source = (path: string) => readFileSync(new URL(path, root), "utf8");

describe("Workspace Editorial approval + Episode staging static boundaries", () => {
  it("keeps migration 0050 additive and scoped to editorial approval/staging", () => {
    const migration = source(
      "drizzle/0050_workspace_editorial_approval_episode_stage.sql"
    );
    expect(migration).toContain("workspaceEditorialDraftApprovals");
    expect(migration).toContain("workspaceEditorialEpisodeStages");
    expect(migration).not.toMatch(/DROP TABLE|DROP COLUMN|DROP FOREIGN KEY/i);
    expect(migration).not.toMatch(
      /accountMerge|payments|wallet|episodePurchases|ALTER TABLE `episodes`/i
    );
  });

  it("migration 0051 widens approval staging cardinality only to approval + episode", () => {
    const migration = source(
      "drizzle/0051_workspace_editorial_multitab_stage.sql"
    );
    expect(migration).toContain("DROP INDEX `wees_approval_unique`");
    expect(migration).toContain("wees_approval_episode_unique");
    expect(migration).toContain("UNIQUE(`approvalId`,`episodeNumber`)");
    expect(migration).not.toMatch(/DROP TABLE|DROP COLUMN|ALTER TABLE `episodes`/i);
  });

  it("keeps migration 0052 additive and scoped to nullable Editorial sale metadata", () => {
    const migration = source("drizzle/0054_workspace_editorial_sale_metadata.sql");
    expect(migration).toContain("workspaceEditorialWorkItems");
    expect(migration).toContain("workspaceEditorialEpisodeStages");
    expect(migration).toContain("`saleMode` enum('chapter','package')");
    expect(migration).toContain("`price` decimal(10,2)");
    expect(migration).toContain("`isFree` boolean");
    expect(migration).toContain("`stageContract` varchar(100)");
    expect(migration).not.toMatch(/DROP TABLE|DROP COLUMN|DROP FOREIGN KEY|ALTER TABLE `episodes`/i);
    const journal = source("drizzle/meta/_journal.json");
    expect(journal).toContain('"idx": 54');
    expect(journal).toContain('"tag": "0054_workspace_editorial_sale_metadata"');
  });

  it("binds approval to exact Draft id/version/hash, checker run and QC evidence", () => {
    const service = source("server/workspace/editorialApproval.service.ts");
    expect(service).toContain("draft.id !== input.expectedDraftId");
    expect(service).toContain("draft.version !== input.expectedDraftVersion");
    expect(service).toContain(
      "draft.draftSha256 !== input.expectedDraftSha256.toLowerCase()"
    );
    expect(service).toContain("qc.run.id !== input.expectedCheckerRunId");
    expect(service).toContain(
      "qc.qcEvidenceSha256 !== input.expectedQcEvidenceSha256.toLowerCase()"
    );
    expect(service).toContain("unresolvedCount === 0");
  });

  it("invalidates old approvals by comparing them against the current Draft and current QC evidence", () => {
    const service = source("server/workspace/editorialApproval.service.ts");
    expect(service).toContain("input.approval.draftId !== input.draft.id");
    expect(service).toContain(
      "input.approval.approvedDraftSha256 !== input.draft.draftSha256"
    );
    expect(service).toContain(
      "input.approval.qcEvidenceSha256 !== input.qc.qcEvidenceSha256"
    );
  });

  it("stages only a NEW_EPISODE and never makes it reader-visible", () => {
    const domain = source("server/workspace/editorialApproval.domain.ts");
    const service = source("server/workspace/editorialApproval.service.ts");
    expect(domain).toContain('input.workItemType !== "new_episode"');
    expect(service).toContain("isPublished: false");
    expect(service).toContain("publishedAt: null");
    expect(service).not.toMatch(/isPublished:\s*true|publishedAt:\s*new Date/);
  });

  it("does not overwrite an unrelated or externally modified unpublished Episode", () => {
    const service = source("server/workspace/editorialApproval.service.ts");
    expect(service).toContain("is not owned by this Editorial work item");
    expect(service).toContain(
      "existingState !== previousStage.episodeStateSha256"
    );
    expect(service).toContain(
      "drifted after its previous Workspace stage"
    );
  });

  it("moves a newly staged Episode to ready_to_publish only after the stage record is persisted", () => {
    const service = source("server/workspace/editorialApproval.service.ts");
    const stageInsert = service.indexOf("const stageId = insertId");
    const finalProjection = service.lastIndexOf(
      'targetColumnKey: "ready_to_publish"'
    );
    expect(stageInsert).toBeGreaterThan(-1);
    expect(finalProjection).toBeGreaterThan(stageInsert);
  });

  it("exposes approval/read/staging only through admin procedures", () => {
    const router = source("server/workspace/router.ts");
    expect(router).toContain("approval: adminProcedure");
    expect(router).toContain("approveDraft: adminProcedure");
    expect(router).toContain("stageEpisodeDraft: adminProcedure");
  });

  it("keeps F independent from AI, Google Docs write-back and publish execution", () => {
    const service = source("server/workspace/editorialApproval.service.ts");
    const domain = source("server/workspace/editorialApproval.domain.ts");
    expect(service + domain).not.toMatch(
      /workspaceAi|DocumentApp|documents:batchUpdate|requestPublishExecution|workspaceOutbox|openai|gemini|fetch\(/i
    );
  });

  it("derives and stages a fail-closed multi-tab Episode batch atomically", () => {
    const domain = source("server/workspace/editorialApproval.domain.ts");
    const service = source("server/workspace/editorialApproval.service.ts");
    expect(domain).toContain("analyzeEditorialEpisodeDraftBatch");
    expect(domain).toContain('"COUNT_MISMATCH"');
    expect(domain).toContain('"TAB_NUMBER_DUPLICATE"');
    expect(domain).toContain('"EXPECTED_EPISODE_MISSING"');
    expect(service).toContain("buildEditorialEpisodePackPlan(batchPlan)");
    expect(service).toContain("for (const plan of [packPlan])");
    expect(service).toContain("staged.length !== 1");
    expect(service).toContain("saleMode,");
    expect(service).toContain("price,");
    expect(service).toContain("isFree,");
    expect(service).toContain("stageItemIdempotencyKey");
  });

  it("shows explicit Confirm and unpublished Episode staging controls in Workspace", () => {
    const page = source("client/src/pages/WorkspacePage.tsx");
    expect(page).toContain("Confirm + Episode Draft Staging");
    expect(page).toContain("ยืนยัน Draft ปัจจุบัน");
    expect(page).toContain("Stage Episode Draft");
    expect(page).toContain("unpublished");
  });
});
