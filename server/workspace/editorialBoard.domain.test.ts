import { describe, expect, it } from "vitest";
import {
  EDITORIAL_BOARD_SLUG,
  EDITORIAL_COLUMNS,
  editorialEpisodeLogicalKey,
  editorialStoryLogicalKey,
  isCanonicalEditorialColumn,
  normalizeEditorialEpisodeKey,
  parseEditorialEpisodeLogicalKey,
  parseEditorialLogicalKey,
  parseEditorialStoryLogicalKey,
} from "./editorialBoard.domain";

describe("Workspace Editorial board domain", () => {
  it("defines the canonical Google-Sheets-like editorial workflow", () => {
    expect(EDITORIAL_BOARD_SLUG).toBe("editorial");
    expect(EDITORIAL_COLUMNS.map(column => column.key)).toEqual([
      "new",
      "pending_check",
      "needs_fix",
      "editing",
      "pending_confirm",
      "ready_to_publish",
      "published",
    ]);
    expect(EDITORIAL_COLUMNS.map(column => column.position)).toEqual([
      0, 1, 2, 3, 4, 5, 6,
    ]);
  });

  it("uses a durable NEW STORY logical identity per workspace novel", () => {
    expect(editorialStoryLogicalKey(42)).toBe("story:42");
    expect(parseEditorialStoryLogicalKey("story:42")).toEqual({
      workItemType: "NEW_STORY",
      workspaceNovelId: 42,
    });
    expect(parseEditorialStoryLogicalKey("episode:42:10")).toBeNull();
    expect(() => editorialStoryLogicalKey(0)).toThrow();
  });

  it("uses a normalized durable NEW EPISODE logical identity", () => {
    expect(normalizeEditorialEpisodeKey("  ตอน  10  ")).toBe("ตอน 10");
    expect(editorialEpisodeLogicalKey(42, "  ตอน  10  ")).toBe(
      "episode:42:ตอน 10"
    );
    expect(parseEditorialEpisodeLogicalKey("episode:42:ตอน 10")).toEqual({
      workItemType: "NEW_EPISODE",
      workspaceNovelId: 42,
      itemKey: "ตอน 10",
    });
    expect(parseEditorialLogicalKey("episode:42:ตอน 10")?.workItemType).toBe(
      "NEW_EPISODE"
    );
    expect(() => editorialEpisodeLogicalKey(42, "   ")).toThrow();
  });

  it("detects canonical column drift instead of silently redefining workflow", () => {
    expect(isCanonicalEditorialColumn(EDITORIAL_COLUMNS[0])).toBe(true);
    expect(
      isCanonicalEditorialColumn({ key: "new", name: "Inbox", position: 0 })
    ).toBe(false);
  });
});
