import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("Editorial bulk Google Docs intake", () => {
  it("shows one novel selector with multiple episode-range + Google Docs rows", () => {
    const page = read("client/src/pages/WorkspacePage.tsx");
    expect(page).toContain('"bulk_docs"');
    expect(page).toContain("Google Docs หลายตอน");
    expect(page).toContain("Bulk Google Docs");
    expect(page).toContain("Bulk episode range");
    expect(page).toContain("Bulk Google Docs link");
    expect(page).toContain("เพิ่มแถว");
    expect(page).toContain("episodeGoogleBatchRows");
    expect(page).toContain("bulkImportGoogleDocs.useMutation");
  });

  it("imports each Google Docs row through the existing guarded source/Draft pipeline", () => {
    const router = read("server/workspace/router.ts");
    expect(router).toContain("bulkImportGoogleDocs: adminProcedure");
    expect(router).toContain("rows: z.array(z.object");
    expect(router).toContain("connectionId: z.number().int().positive()");
    expect(router).toContain("for (let rowIndex = 0; rowIndex < input.rows.length; rowIndex += 1)");
    expect(router).toContain("fetchEditorialGoogleDocSource({");
    expect(router).toContain("createEditorialEpisodeWorkItem({");
    expect(router).toContain('saleMode: "package"');
    expect(router).toContain("importEditorialSource({");
    expect(router).toContain("googleConnectionId: input.connectionId");
  });

  it("returns per-row results and preserves failed rows for retry", () => {
    const page = read("client/src/pages/WorkspacePage.tsx");
    const router = read("server/workspace/router.ts");
    expect(router).toContain("rowIndex,");
    expect(router).toContain("ok: true as const");
    expect(router).toContain("ok: false as const");
    expect(page).toContain("failedIndexes");
    expect(page).toContain(".filter((_row, index) => failedIndexes.has(index))");
    expect(page).toContain("นำเข้า Google Docs สำเร็จ");
  });

  it("caps one request to 30 Docs rows", () => {
    const page = read("client/src/pages/WorkspacePage.tsx");
    const router = read("server/workspace/router.ts");
    expect(router).toContain(")).min(1).max(30)");
    expect(page).toContain("episodeGoogleBatchRows.length >= 30");
  });
});
