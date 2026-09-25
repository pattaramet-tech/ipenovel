import { describe, expect, it } from "vitest";
import { summarizeEditorialDraftTabs } from "../../client/src/pages/workspaceEditorialDraftSummary";

function tab(
  title: string,
  text: string,
  tabOrder: number,
  warnings: string[] = []
) {
  return {
    title,
    tabOrder,
    warnings,
    paragraphs: text
      ? [{ text, sourceParagraphIndex: 1 }]
      : [{ text: "จบตอน", sourceParagraphIndex: 0 }],
  };
}

describe("Workspace Editorial Draft structure summary", () => {
  it("reports empty, unusually short and numbering gaps without treating generated end markers as content", () => {
    const normal = "ก".repeat(1000);
    const summary = summarizeEditorialDraftTabs([
      tab("แท็บ 49", normal, 0),
      tab("แท็บ 51", "", 1),
      tab("แท็บ 52", "สั้นมาก", 2),
      tab("แท็บ 53", normal, 3, ["SOURCE_NO_CHAPTER_NOTE"]),
    ]);
    expect(summary.totalTabs).toBe(4);
    expect(summary.emptyTabs.map(row => row.title)).toEqual(["แท็บ 51"]);
    expect(summary.shortTabs.map(row => row.title)).toEqual(["แท็บ 52"]);
    expect(summary.sequenceIssues).toEqual(["ขาดเลข 50"]);
    expect(summary.unnumberedTabs).toEqual([]);
    expect(summary.warningTabs.map(row => row.title)).toEqual(["แท็บ 53"]);
  });

  it("reports reversed and duplicated tab numbering deterministically", () => {
    const body = "ข".repeat(300);
    const summary = summarizeEditorialDraftTabs([
      tab("10", body, 0),
      tab("9", body, 1),
      tab("9", body, 2),
    ]);

    expect(summary.sequenceIssues).toEqual(["ลำดับย้อน 10→9", "เลขซ้ำ 9"]);
  });
});
