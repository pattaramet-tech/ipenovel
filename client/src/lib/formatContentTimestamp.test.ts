import { describe, expect, it } from "vitest";
import { formatContentTimestamp, publishedEpisodeDisplayTime } from "./formatContentTimestamp";

describe("formatContentTimestamp", () => {
  it("uses Bangkok timezone instead of the device's timezone", () => {
    const text = formatContentTimestamp("2026-11-06T08:42:00.000Z");
    expect(text).toContain("15:42");
    expect(text).toContain("2569");
  });

  it("hides null and invalid values", () => {
    expect(formatContentTimestamp(null)).toBeNull();
    expect(formatContentTimestamp("not-a-date")).toBeNull();
  });

  it("uses publication time when draft preparation predates publishing", () => {
    const at = publishedEpisodeDisplayTime({
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-10-02T00:00:00Z",
      publishedAt: "2026-11-06T12:00:00Z",
    });
    expect(at?.toISOString()).toBe("2026-11-06T12:00:00.000Z");
  });

  it("shows later content update after publication", () => {
    const at = publishedEpisodeDisplayTime({
      createdAt: "2026-10-01T00:00:00Z",
      publishedAt: "2026-11-01T00:00:00Z",
      updatedAt: "2026-11-06T12:00:00Z",
    });
    expect(at?.toISOString()).toBe("2026-11-06T12:00:00.000Z");
  });

  it("falls back to createdAt when publishedAt is null, and ignores invalid inputs", () => {
    expect(publishedEpisodeDisplayTime({
      createdAt: "2026-10-01T00:00:00Z",
      publishedAt: null,
      updatedAt: "not-a-date",
    })?.toISOString()).toBe("2026-10-01T00:00:00.000Z");
    expect(publishedEpisodeDisplayTime({ createdAt: "bad", updatedAt: "bad" })).toBeNull();
  });
});
