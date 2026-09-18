import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../..", import.meta.url);
const source = (path: string) => readFileSync(new URL(path, root), "utf8");

describe("Workspace Editorial foreign-word checker static boundaries", () => {
  it("keeps migration 0048 additive and Workspace-only", () => {
    const migration = source(
      "drizzle/0048_workspace_editorial_foreign_checker.sql"
    );
    expect(migration).toContain("workspaceEditorialCheckerRuns");
    expect(migration).toContain("workspaceEditorialCheckerFindings");
    expect(migration).toContain("workspaceEditorialCheckerFindingStates");
    expect(migration).toContain("workspaceEditorialCheckerAllowWords");
    expect(migration).not.toMatch(/DROP TABLE|DROP COLUMN|DROP FOREIGN KEY/i);
    expect(migration).not.toMatch(
      /accountMerge|payment|wallet|episodePurchases|ALTER TABLE `episodes`/i
    );
  });

  it("ports Production foreign-script, kaomoji and long-English rules without GAS writes", () => {
    const domain = source("server/workspace/editorialForeignChecker.domain.ts");
    expect(domain).toContain("\\u0600-\\u06FF");
    expect(domain).toContain("\\u3040-\\u30FF");
    expect(domain).toContain("\\uAC00-\\uD7AF");
    expect(domain).toContain("words.length >= 8");
    expect(domain).toContain("latinCount >= 45");
    expect(domain).toContain("trim().length >= 60");
    expect(domain).toContain("isLikelyKaomoji");
    expect(domain).not.toMatch(/SpreadsheetApp|DocumentApp|setBackgroundColor/);
  });

  it("adds short ASCII-word detection as a separate deterministic rule and stores whole sentence/context", () => {
    const domain = source("server/workspace/editorialForeignChecker.domain.ts");
    expect(domain).toContain('latinWord: "latin_word"');
    expect(domain).toContain('if (/^[A-Za-z]$/.test(latinMatch[0])) continue;');
    expect(domain).toContain("sentenceText");
    expect(domain).toContain("contextText");
    expect(domain).toContain('offsetEncoding: "utf16"');
  });

  it("keeps checker execution local and independent from AI, publish and legacy checker queues", () => {
    const service = source(
      "server/workspace/editorialForeignChecker.service.ts"
    );
    expect(service).toContain("evaluateEditorialForeignDraft");
    expect(service).toContain("workspaceEditorialDraftParagraphs");
    expect(service).not.toMatch(
      /workspaceAi|workspacePublish|queueCheckerRun|workspaceCheckerRuns|DocumentApp/
    );
  });

  it("rechecks draft freshness under the work-item lock and never resurrects an allow word from an old replay", () => {
    const service = source(
      "server/workspace/editorialForeignChecker.service.ts"
    );
    expect(service).toContain(
      "const currentDraft = await latestDraft(tx, input.workItemId);"
    );
    expect(service).toContain("if (!state.replayed)");
    expect(
      service.indexOf("const state = await persistFindingState(tx")
    ).toBeLessThan(
      service.indexOf(".insert(workspaceEditorialCheckerAllowWords)")
    );
  });

  it("exposes run, allow and resolution operations only through admin procedures", () => {
    const router = source("server/workspace/router.ts");
    expect(router).toContain("foreignChecker: adminProcedure");
    expect(router).toContain("foreignCheckerRun: adminProcedure");
    expect(router).toContain("foreignCheckerResolve: adminProcedure");
    expect(router).toContain("foreignCheckerAllow: adminProcedure");
    expect(router).toContain("foreignCheckerUnallow: adminProcedure");
  });

  it("provides a minimal sentence-finding QC surface without introducing the full editor early", () => {
    const page = source("client/src/pages/WorkspacePage.tsx");
    expect(page).toContain("Deterministic Foreign-word Checker");
    expect(page).toContain("finding.sentenceText");
    expect(page).toContain("editorTarget && editorTarget.findingId === finding.id");
    expect(page).toContain("แก้ตรง finding นี้");
    expect(page).toContain("ยอมรับคำนี้");
    expect(page).toContain("Mark fixed");
    expect(page).not.toContain("contentEditable");
  });
});
