import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parseGoogleDocId } from "./editorialSource.googleDocs";

describe("Editorial Google Docs source identity", () => {
  it("accepts a stable document id or canonical Docs URL", () => {
    const id = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
    expect(parseGoogleDocId(id)).toBe(id);
    expect(
      parseGoogleDocId(`https://docs.google.com/document/d/${id}/edit?tab=t.0`)
    ).toBe(id);
  });

  it("imports directly through Docs API without a Drive metadata preflight", () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), "server/workspace/editorialSource.googleDocs.ts"),
      "utf8"
    );
    expect(source).toContain("docs.googleapis.com/v1/documents");
    expect(source).toContain("includeTabsContent=true");
    expect(source).not.toContain("drive/v3/files");
    expect(source).toContain("document.title");
  });

  it("rejects non-Docs hosts, short ids and unrelated paths", () => {
    expect(
      parseGoogleDocId("https://example.com/document/d/abc/edit")
    ).toBeNull();
    expect(parseGoogleDocId("short-id")).toBeNull();
    expect(
      parseGoogleDocId(
        "https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/edit"
      )
    ).toBeNull();
  });
});
