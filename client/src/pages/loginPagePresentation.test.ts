import { describe, expect, it } from "vitest";
import { isSessionExpiredStatus } from "./loginPagePresentation";

describe("isSessionExpiredStatus", () => {
  it("[required test 9] ?googleConnect=session_expired (exact value) -> true", () => {
    expect(isSessionExpiredStatus("?googleConnect=session_expired")).toBe(true);
  });

  it("[required test 9] any other value -> false, never shown for the wrong reason", () => {
    for (const search of [
      "?googleConnect=success",
      "?googleConnect=error",
      "?googleConnect=SESSION_EXPIRED",
      "?googleConnect=session-expired",
      "?googleConnect=",
      "?foo=bar",
      "",
    ]) {
      expect(isSessionExpiredStatus(search)).toBe(false);
    }
  });

  it("extra unrelated params alongside the valid one still parse correctly", () => {
    expect(isSessionExpiredStatus("?foo=bar&googleConnect=session_expired&baz=qux")).toBe(true);
  });
});
