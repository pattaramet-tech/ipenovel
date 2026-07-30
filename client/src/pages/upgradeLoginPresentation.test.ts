import { describe, expect, it } from "vitest";
import { resolveSupportUrl } from "./upgradeLoginPresentation";

describe("resolveSupportUrl", () => {
  it("a configured URL is returned as-is (trimmed)", () => {
    expect(resolveSupportUrl("https://support.example.com")).toBe("https://support.example.com");
    expect(resolveSupportUrl("  https://support.example.com  ")).toBe("https://support.example.com");
  });

  it.each([undefined, "", "   "])("%j (unset/empty/whitespace-only) -> null - never a guessed/fabricated URL", (raw) => {
    expect(resolveSupportUrl(raw)).toBeNull();
  });
});
