import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const source = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "AdminNovelsPage.tsx"),
  "utf8"
).replace(/\r\n/g, "\n");

describe("IPE-063R4 AdminNovelsPage author preview contract", () => {
  it("A/B. create preview resolves the effective pen name from authorProfile.get", () => {
    expect(source).toContain("trpc.admin.authorProfile.get.useQuery");
    expect(source).toContain("authorProfileQuery.data?.effectiveAuthorName");
    // Session account name is no longer the create preview source.
    expect(source).not.toContain("user?.name || \"\"");
  });

  it("C. loading state shows a safe placeholder (no misleading session name)", () => {
    expect(source).toContain("Loading Author profile…");
  });

  it("D. profile error shows an unavailable state and blocks creation", () => {
    expect(source).toContain("Unable to load Author profile");
    expect(source).toContain("authorProfileQuery.isError");
    expect(source).toContain("authorProfileReady = authorProfileQuery.isSuccess");
    expect(source).toContain("!editingNovelId && !authorProfileReady");
    // No silent session-name fallback in the error branch.
    expect(source).not.toMatch(/isError[\s\S]{0,400}user\?\.name/);
  });

  it("E. edit mode keeps the novel's persisted author (not the acting admin's profile)", () => {
    expect(source).toContain(
      'novels?.find((novel: any) => novel.id === editingNovelId)?.author || "Unassigned"'
    );
  });

  it("F. the Author control stays read-only — no editable author/owner selector", () => {
    expect(source).toContain("readOnly");
    expect(source).toContain('data-testid="novel-author-preview"');
    expect(source).not.toMatch(/authorUserId\s*:/);
    expect(source).not.toMatch(/onChange=\{[^}]*setFormData\(\{ \.\.\.formData, author/);
  });
});
