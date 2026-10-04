// IPE-064R3 — draft outline static contract. The pack/chapter tree renders
// from a light per-tab outline (no paragraph text) instead of blocking on
// the full sourceDraft read model. Per repo convention these read sources.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../..", import.meta.url);
const source = (path: string) => readFileSync(new URL(path, root), "utf8").replace(/\r\n/g, "\n");

describe("IPE-064R3 draft outline static contract", () => {
  it("exposes the light outline procedure for the pack/chapter tree", () => {
    const router = source("server/workspace/router.ts");
    expect(router).toContain("sourceDraftOutline: adminProcedure");
    expect(router).toContain("getEditorialDraftOutline");
  });

  it("ships no paragraph text — identity, counts and the edited flag only", () => {
    const service = source("server/workspace/editorialDraft.service.ts");
    const fn = service.slice(
      service.indexOf("export async function getEditorialDraftOutline"),
      service.indexOf("export async function getEditorialSourceSnapshot")
    );
    // The shape aggregation selects counts/fingerprints, never text rows.
    expect(fn).toContain("paragraphCount");
    expect(fn).toContain("editedCount");
    expect(fn).not.toMatch(
      /\.select\(\)\s*\n\s*\.from\(workspaceEditorialDraftParagraphs\)/
    );
  });

  it("the page tree and review summary render from the outline", () => {
    const page = source("client/src/pages/WorkspacePage.tsx");
    expect(page).toContain("sourceDraftOutline.useQuery");
    expect(page).toContain("chapters={packTreeChapters}");
    expect(page).toContain("const reviewChapters = packOutlineRows.map(entry => entry.row);");
    // The per-tab status derivation is memoized — no per-keystroke rescans.
    expect(page).toContain("const chapterEditorStatusByTab = useMemo(");
  });
});
