import { describe, expect, it } from "vitest";
import { resolveNovelDisplayUpdatedAt } from "./novelDisplayTimestamp";

describe("resolveNovelDisplayUpdatedAt", () => {
  const novelTime = new Date("2026-11-01T10:00:00.000Z");

  it("keeps the novel creation time when no published episode exists", () => {
    expect(resolveNovelDisplayUpdatedAt(novelTime, null)).toEqual(novelTime);
  });

  it("takes the latest published episode timestamp when newer", () => {
    expect(resolveNovelDisplayUpdatedAt(novelTime, "2026-11-06T12:00:00.000Z").toISOString())
      .toBe("2026-11-06T12:00:00.000Z");
  });

  it("does not move the time backwards for older episode updates", () => {
    expect(resolveNovelDisplayUpdatedAt(novelTime, new Date("2026-10-01T12:00:00Z")))
      .toEqual(novelTime);
  });

  it("ignores invalid timestamp values", () => {
    expect(resolveNovelDisplayUpdatedAt(novelTime, "invalid")).toEqual(novelTime);
  });

  it("does not treat a novel-row metadata edit as an episode update", () => {
    const novelCreatedAt = new Date("2026-10-01T00:00:00Z");
    const latestPublishedEpisodeActivityAt = new Date("2026-11-01T00:00:00Z");
    // The UI calculation does not take novels.updatedAt at all.
    expect(resolveNovelDisplayUpdatedAt(novelCreatedAt, latestPublishedEpisodeActivityAt))
      .toEqual(latestPublishedEpisodeActivityAt);
  });
});
