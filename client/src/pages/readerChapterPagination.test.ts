import { describe, expect, it } from "vitest";
import { parsePackageToc } from "@/utils/packageTocUtils";
import {
  findSegmentIndexByAnchorId,
  findSegmentIndexByChapterNumber,
  packageOverallPercent,
  resolveChapterRestoreScrollTop,
  resolveInitialChapterIndex,
  segmentPackageChapters,
  segmentPackageChaptersFromLines,
  shouldPaginatePackage,
} from "./readerChapterPagination";

const MULTI_CHAPTER = [
  "คำนำของแพ็ก",
  "",
  "บทที่ 1 จุดเริ่มต้น",
  "เนื้อหาบทหนึ่ง ก",
  "เนื้อหาบทหนึ่ง ข",
  "",
  "บทที่ 2 ทางแยก",
  "เนื้อหาบทสอง",
  "",
  "ตอนที่ 3 ปลายทาง",
  "เนื้อหาบทสาม",
].join("\n");

describe("segmentPackageChapters", () => {
  it("splits a multi-chapter package into one segment per heading, intro first", () => {
    const segments = segmentPackageChapters(MULTI_CHAPTER);
    expect(segments).toHaveLength(4);

    expect(segments[0]).toMatchObject({
      entry: null,
      chapterNumber: null,
      startLine: 0,
      endLine: 2,
    });
    expect(segments[0].lines).toEqual(["คำนำของแพ็ก", ""]);

    expect(segments[1]).toMatchObject({
      chapterNumber: "1",
      title: "บทที่ 1 จุดเริ่มต้น",
      startLine: 2,
      endLine: 6,
    });
    expect(segments[1].lines[0]).toBe("บทที่ 1 จุดเริ่มต้น");

    expect(segments[2]).toMatchObject({ chapterNumber: "2", startLine: 6, endLine: 9 });
    expect(segments[3]).toMatchObject({ chapterNumber: "3", startLine: 9, endLine: 11 });
    expect(segments[3].lines).toEqual(["ตอนที่ 3 ปลายทาง", "เนื้อหาบทสาม"]);
  });

  it("keeps global line indexes stable: anchor ids come from the full content", () => {
    const segments = segmentPackageChapters(MULTI_CHAPTER);
    const toc = parsePackageToc(MULTI_CHAPTER);
    // The intro segment has no anchor; the numbered ones keep the exact
    // global (full-content) anchor ids the TOC drawer links to.
    expect(segments.filter((s) => s.anchorId !== null).map((s) => s.anchorId)).toEqual(
      toc.map((e) => e.anchorId)
    );
    expect(segments[1].anchorId).toBe(toc[0].anchorId);
  });

  it("returns a single fallback segment (legacy rendering) for heading-less content", () => {
    const content = "ย่อหน้าแรก\nย่อหน้าสอง\n";
    const segments = segmentPackageChapters(content);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({
      entry: null,
      chapterNumber: null,
      startLine: 0,
      endLine: 3,
    });
    expect(segments[0].lines).toEqual(content.split("\n"));
    expect(shouldPaginatePackage(segments)).toBe(false);
  });

  it("has no intro segment when content starts with the first heading", () => {
    const segments = segmentPackageChapters("บทที่ 1 ต้น\nก\nบทที่ 2 ต่อ\nข");
    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({ chapterNumber: "1", startLine: 0, endLine: 2 });
    expect(segments[1]).toMatchObject({ chapterNumber: "2", startLine: 2, endLine: 4 });
  });

  it("supports every recognized heading format and decimal numbers", () => {
    const segments = segmentPackageChapters(
      ["Chapter 1 a", "x", "#2.5 b", "y", "บทที่12 ซ", "z", "ตอนที่ 3.5 ว"].join("\n")
    );
    expect(segments.map((s) => s.chapterNumber)).toEqual(["1", "2.5", "12", "3.5"]);
  });

  it("returns no segments for empty content", () => {
    expect(segmentPackageChapters("")).toEqual([]);
    expect(segmentPackageChaptersFromLines([], [])).toEqual([]);
  });
});

describe("resolveInitialChapterIndex", () => {
  const segments = segmentPackageChapters(MULTI_CHAPTER);

  it("jumps straight to the requested ?chapter= deep link", () => {
    expect(resolveInitialChapterIndex(segments, { requestedChapter: "2" })).toBe(2);
    expect(resolveInitialChapterIndex(segments, { requestedChapter: "3" })).toBe(3);
  });

  it("lands on the first page without a request", () => {
    expect(resolveInitialChapterIndex(segments)).toBe(0);
    expect(resolveInitialChapterIndex(segments, { requestedChapter: null })).toBe(0);
  });

  it("fails safe to the first page for unknown chapter numbers", () => {
    expect(resolveInitialChapterIndex(segments, { requestedChapter: "99" })).toBe(0);
    expect(resolveInitialChapterIndex(segments, { requestedChapter: "1.5" })).toBe(0);
  });

  it("returns 0 for empty segments", () => {
    expect(resolveInitialChapterIndex([], { requestedChapter: "1" })).toBe(0);
  });
});

describe("findSegmentIndex helpers", () => {
  const segments = segmentPackageChapters(MULTI_CHAPTER);

  it("finds segments by chapter number and anchor id, -1 otherwise", () => {
    expect(findSegmentIndexByChapterNumber(segments, "2")).toBe(2);
    expect(findSegmentIndexByChapterNumber(segments, null)).toBe(-1);
    expect(findSegmentIndexByChapterNumber(segments, "404")).toBe(-1);
    // The intro segment has no entry - never matched by chapter lookups.
    expect(findSegmentIndexByChapterNumber(segments, "คำนำของแพ็ก")).toBe(-1);

    expect(findSegmentIndexByAnchorId(segments, segments[3].anchorId)).toBe(3);
    expect(findSegmentIndexByAnchorId(segments, null)).toBe(-1);
  });
});

describe("resolveChapterRestoreScrollTop", () => {
  const metrics = { scrollHeight: 5000, clientHeight: 1000 };

  it("restores an exact within-chapter offset that fits the page", () => {
    expect(resolveChapterRestoreScrollTop({ scrollTop: 2400 }, metrics)).toBe(2400);
    expect(resolveChapterRestoreScrollTop({ scrollTop: 4000 }, metrics)).toBe(4000);
  });

  it("falls back to the chapter top for a legacy whole-package offset", () => {
    // 12000px was a valid offset in the old one-long-scroll layout, but no
    // chapter page is that tall - landing at the bottom would be wrong.
    expect(resolveChapterRestoreScrollTop({ scrollTop: 12000 }, metrics)).toBe(0);
  });

  it("returns 0 for zero/negative/corrupt offsets and unmeasurable containers", () => {
    expect(resolveChapterRestoreScrollTop({ scrollTop: 0 }, metrics)).toBe(0);
    expect(resolveChapterRestoreScrollTop({ scrollTop: -5 }, metrics)).toBe(0);
    expect(resolveChapterRestoreScrollTop({ scrollTop: Number.NaN }, metrics)).toBe(0);
    expect(resolveChapterRestoreScrollTop({ scrollTop: null }, metrics)).toBe(0);
    expect(resolveChapterRestoreScrollTop({ scrollTop: 100 }, null)).toBe(0);
    // Content shorter than the viewport: nothing to scroll, stay at top.
    expect(
      resolveChapterRestoreScrollTop({ scrollTop: 400 }, { scrollHeight: 300, clientHeight: 1000 })
    ).toBe(0);
  });
});

describe("packageOverallPercent", () => {
  it("maps page index + within-page percent onto the whole package", () => {
    expect(packageOverallPercent(0, 0, 10)).toBe(0);
    expect(packageOverallPercent(0, 100, 10)).toBe(10);
    expect(packageOverallPercent(4, 50, 10)).toBe(45);
    expect(packageOverallPercent(9, 100, 10)).toBe(100);
  });

  it("stores as an INTEGER (the reading_progress column is int - no schema change)", () => {
    expect(packageOverallPercent(1, 33.3333, 3)).toBe(44);
    expect(packageOverallPercent(2, 0, 3)).toBe(67);
    expect(Number.isInteger(packageOverallPercent(1, 17.77, 4))).toBe(true);
    // A clamped-out-of-range page index keeps its within-page progress.
    expect(packageOverallPercent(-5, 50, 10)).toBe(5);
    expect(packageOverallPercent(99, 50, 10)).toBe(95);
    expect(packageOverallPercent(0, 150, 10)).toBe(10);
    expect(packageOverallPercent(0, 0, 0)).toBe(0);
  });
});
