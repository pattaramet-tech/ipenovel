import { describe, expect, it } from "vitest";
import { parseGoogleConnectStatus, shouldShowGoogleConnectSection } from "./profileGoogleConnectStatus";

describe("shouldShowGoogleConnectSection", () => {
  it('"google" -> true', () => {
    expect(shouldShowGoogleConnectSection("google")).toBe(true);
  });

  it('"transition" -> true', () => {
    expect(shouldShowGoogleConnectSection("transition")).toBe(true);
  });

  it('"manus" -> false (the section must not render at all in manus mode)', () => {
    expect(shouldShowGoogleConnectSection("manus")).toBe(false);
  });

  it("unset/typo/wrong case/empty -> false, exact-literal match only", () => {
    for (const value of [undefined, "Google", "GOOGLE", " google", "transitionn", ""]) {
      expect(shouldShowGoogleConnectSection(value)).toBe(false);
    }
  });
});

describe("parseGoogleConnectStatus", () => {
  it("?googleConnect=success -> \"success\"", () => {
    expect(parseGoogleConnectStatus("?googleConnect=success")).toBe("success");
  });

  it("?googleConnect=error -> \"error\"", () => {
    expect(parseGoogleConnectStatus("?googleConnect=error")).toBe("error");
  });

  it("no query string at all -> null", () => {
    expect(parseGoogleConnectStatus("")).toBeNull();
  });

  it("param missing -> null", () => {
    expect(parseGoogleConnectStatus("?foo=bar")).toBeNull();
  });

  it("an unrecognized value -> null, never assumed to be success or error", () => {
    expect(parseGoogleConnectStatus("?googleConnect=whatever")).toBeNull();
  });

  it("extra unrelated params alongside a valid one still parse correctly", () => {
    expect(parseGoogleConnectStatus("?foo=bar&googleConnect=success&baz=qux")).toBe("success");
  });
});
