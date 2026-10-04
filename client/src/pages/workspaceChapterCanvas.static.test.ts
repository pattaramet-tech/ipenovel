import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../../", import.meta.url);
const source = (path: string) => readFileSync(new URL(path, root), "utf8");

/**
 * IPE-058-C static UI regression: the Chapter Editor must stay a SINGLE
 * continuous editing surface (one canvas textarea), never regress to one
 * textarea per paragraph, and must not touch Stage/Publish surfaces.
 */
describe("Workspace chapter editor single-canvas static contract", () => {
  const page = source("client/src/pages/WorkspacePage.tsx");

  it("renders exactly one canvas editing surface with the canonical model", () => {
    expect(page).toContain("workspace-chapter-editor-canvas");
    expect(page).toContain("ChapterEditorCanvas");
    expect(page).toContain("applyChapterCanvasChange");
    expect(page).toContain("serializeChapterCanvasForSave");
  });

  it("does not render per-paragraph textareas in the chapter editor", () => {
    expect(page).not.toContain("ChapterEditorParagraphBlock");
    expect(page).not.toContain("chapter-editor-paragraph-");
    expect(page).not.toContain("onSplit=");
    expect(page).not.toContain("onMergePrevious=");
    expect(page).not.toContain("onPasteParagraphs=");
  });

  it("keeps the guarded replace_tab save boundary with explicit identity", () => {
    expect(page).toContain('kind: "replace_tab"');
    expect(page).toContain("replacementParagraphKeys:");
    expect(page).toContain("expectedTabStructuralSha256:");
    expect(page).toContain("expectedDraftSha256: chapterEditorTarget.draftSha256");
  });

  it("keeps keyboard, dirty-guard and checker-currentness behavior", () => {
    expect(page).toContain("Ctrl/Cmd+S = บันทึก");
    expect(page).toContain("Ctrl/Cmd+Z / Ctrl+Y = เลิก/ทำซ้ำ");
    expect(page).toContain("beforeUnload");
    expect(page).toContain("editorialCheckerRunStale");
    expect(page).toContain("runEditorialForeignChecker");
  });

  it("keeps the save-draft boundary explicit in the editor surface", () => {
    // IPE-064: the Stage/Publish diagnostics sections were retired from the
    // page — Stage runs through the action bar (bulk) / toolbar CTA, and the
    // canvas save boundary stays the explicit Draft-revision button.
    expect(page).toContain("บันทึก Draft + ตรวจซ้ำ");
    expect(page).not.toContain('data-testid="workspace-stage-section"');
    expect(page).not.toContain('data-testid="workspace-publish-section"');
  });
});
