import { describe, expect, it } from "vitest";
import { parseGoogleDocId } from "./editorialSource.googleDocs";

describe("Editorial Google Docs source identity", () => {
  it("accepts a stable document id or canonical Docs URL", () => {
    const id = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
    expect(parseGoogleDocId(id)).toBe(id);
    expect(
      parseGoogleDocId(`https://docs.google.com/document/d/${id}/edit?tab=t.0`)
    ).toBe(id);
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
