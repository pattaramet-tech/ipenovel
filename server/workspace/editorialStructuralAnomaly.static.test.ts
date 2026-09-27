import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");

describe("M29.2 Structural Anomaly Check safety", () => {
  it("runs structural analysis together with checker v5", () => {
    const checker = read("server/workspace/editorialForeignChecker.service.ts");
    const domain = read("server/workspace/editorialStructuralAnomaly.domain.ts");
    expect(checker).toContain("evaluateEditorialStructuralAnomalies");
    expect(checker).toContain("structural.summary.tabCount");
    expect(checker).toContain("blockingAnomalyCount");
    expect(domain).toContain('"duplicate_content_near"');
    expect(domain).toContain('"end_only_tab"');
    expect(domain).toContain('"source_note_only"');
    expect(domain).toContain('"missing_expected_chapter"');
  });

  it("persists structural anomaly evidence per checker run", () => {
    const schema = read("drizzle/schema.ts");
    const checker = read("server/workspace/editorialForeignChecker.service.ts");
    expect(schema).toContain("workspaceEditorialCheckerAnomalies");
    expect(schema).toContain('tabCount: int("tabCount")');
    expect(schema).toContain('blockingAnomalyCount: int("blockingAnomalyCount")');
    expect(checker).toContain("workspaceEditorialCheckerAnomalies");
    expect(checker).toContain("relatedSourceTabIdsJson");
    expect(checker).toContain("detailsJson");
  });

  it("blocks approval on error anomalies while retaining warning-only duplicate review", () => {
    const approval = read("server/workspace/editorialApproval.service.ts");
    const domain = read("server/workspace/editorialStructuralAnomaly.domain.ts");
    expect(approval).toContain("blockingAnomalyCount");
    expect(approval).toContain("blocking structural anomalies");
    expect(domain).toContain('anomalyType: "duplicate_content_near"');
    expect(domain).toContain('severity: "warning"');
  });

  it("surfaces tab count and grouped anomalies in bulk checker summary", () => {
    const page = read("client/src/pages/WorkspacePage.tsx");
    const router = read("server/workspace/router.ts");
    expect(router).toContain("structuralSummary: checker.structuralSummary");
    expect(router).toContain("anomalies: checker.anomalies");
    expect(page).toContain("รวม {totalTabs} แท็บ");
    expect(page).toContain("บทที่หาย:");
    expect(page).toContain("แท็บมีเฉพาะ “จบตอน”");
    expect(page).toContain("หมายเหตุจากต้นฉบับ:");
    expect(page).toContain("เนื้อหาซ้ำ/คล้ายซ้ำ:");
  });

  it("does not mutate Draft, Google Docs, Sheets, or Publish", () => {
    const domain = read("server/workspace/editorialStructuralAnomaly.domain.ts");
    const checker = read("server/workspace/editorialForeignChecker.service.ts");
    const combined = domain + checker;
    expect(combined).not.toMatch(
      /update\(workspaceEditorialDraft|delete\(workspaceEditorialDraft|fetchEditorialGoogleDocSource|batchUpdateValues|writeRange|requestEditorialPublish|requestPublishExecution/
    );
  });

  it("registers migration 0058 exactly once", () => {
    const journal = JSON.parse(read("drizzle/meta/_journal.json"));
    const entries = journal.entries.filter(
      (entry: any) =>
        entry.tag === "0058_workspace_editorial_structural_anomalies"
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].idx).toBe(58);
    const migration = read(
      "drizzle/0058_workspace_editorial_structural_anomalies.sql"
    );
    expect(migration).toContain("workspaceEditorialCheckerAnomalies");
    expect(migration).toContain("blockingAnomalyCount");
  });
});
