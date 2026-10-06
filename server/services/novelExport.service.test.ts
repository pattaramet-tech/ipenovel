// IPE-059-A - Export service tests: selection semantics, published-only
// source authority, ownership checks and DB→domain mapping. The DB layer
// (`../db`) is mocked entirely; serialization correctness lives in
// novelExport.domain.test.ts and round-trip proof in
// novelExport.roundTrip.test.ts.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db", () => ({
  getNovelById: vi.fn(),
  getEpisodesByNovelId: vi.fn(),
}));

import * as db from "../db";
import {
  NovelExportError,
  buildNovelExportPackage,
  buildNovelExportPreview,
  buildNovelTxtExport,
  buildNovelZipExport,
  buildThaiNovelZipExport,
} from "./novelExport.service";

const mockedDb = vi.mocked(db, true);

type EpisodeRow = {
  id: number;
  novelId: number;
  episodeNumber: string;
  title: string;
  content: string | null;
  price: string;
  isFree: boolean;
  isPublished: boolean;
  contentFormat: string | null;
  sortOrder: number | null;
  saleMode: string | null;
  fileUrl: string | null;
  description?: string | null;
};

function makeEpisode(overrides: Partial<EpisodeRow> = {}): EpisodeRow {
  return {
    id: 1,
    novelId: 1,
    episodeNumber: "1",
    title: "ตอนที่ 1",
    content: "เนื้อหาตอนที่ 1\nบรรทัดที่สอง",
    price: "0.00",
    isFree: true,
    isPublished: true,
    contentFormat: "plain_text",
    sortOrder: null,
    saleMode: "package",
    fileUrl: null,
    description: null,
    ...overrides,
  };
}

function mockNovel(novelId: number, title = "นิยายทดสอบ") {
  mockedDb.getNovelById.mockResolvedValue({ id: novelId, title } as any);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildNovelExportPackage - source authority (published only)", () => {
  it("exports only isPublished episodes; a newer unpublished draft row is never selected", async () => {
    mockNovel(1);
    mockedDb.getEpisodesByNovelId.mockResolvedValue([
      makeEpisode({ id: 10, episodeNumber: "1" }),
      // Workspace Draft / pending Stage analogue: not published.
      makeEpisode({ id: 11, episodeNumber: "2", isPublished: false, title: "ฉบับร่างที่ยังไม่เผยแพร่" }),
    ] as any);

    const { pkg, skippedItems } = await buildNovelExportPackage({ novelId: 1 });
    expect(pkg.items.map((i) => i.episodeId)).toEqual([10]);
    expect(skippedItems).toEqual([]);
  });

  it("maps sale metadata from canonical DB fields via resolveSaleMode fallback", async () => {
    mockNovel(1);
    mockedDb.getEpisodesByNovelId.mockResolvedValue([
      // explicit package saleMode
      makeEpisode({ id: 10, episodeNumber: "001-050", saleMode: "package", isFree: false, price: "25.00" }),
      // legacy row: no saleMode column value, range-style number -> package
      makeEpisode({ id: 11, episodeNumber: "051-100", saleMode: null, isFree: false, price: "30.00" }),
    ] as any);

    const { pkg } = await buildNovelExportPackage({ novelId: 1 });
    expect(pkg.items.map((i) => i.saleMode)).toEqual(["package", "package"]);
    expect(pkg.items.map((i) => i.price)).toEqual(["25.00", "30.00"]);
  });
});

describe("buildNovelExportPackage - whole-novel selection", () => {
  it("skips-and-reports legacy episodes without inline content instead of failing the whole export", async () => {
    mockNovel(1);
    mockedDb.getEpisodesByNovelId.mockResolvedValue([
      makeEpisode({ id: 10, episodeNumber: "1" }),
      makeEpisode({ id: 12, episodeNumber: "2", content: null }),
      makeEpisode({ id: 13, episodeNumber: "3", content: "   " }),
    ] as any);

    const { pkg, skippedItems } = await buildNovelExportPackage({ novelId: 1 });
    expect(pkg.items.map((i) => i.episodeId)).toEqual([10]);
    expect(skippedItems).toEqual([
      { episodeId: 12, episodeNumber: "2", title: "ตอนที่ 1", reason: "MISSING_CONTENT" },
      { episodeId: 13, episodeNumber: "3", title: "ตอนที่ 1", reason: "MISSING_CONTENT" },
    ]);
  });

  it("rejects a whole-novel export when nothing is exportable", async () => {
    mockNovel(1);
    mockedDb.getEpisodesByNovelId.mockResolvedValue([makeEpisode({ id: 10, content: null })] as any);

    await expect(buildNovelZipExport({ novelId: 1 })).rejects.toMatchObject({
      code: "EXPORT_EMPTY_SELECTION",
    } as Partial<NovelExportError>);
  });
});

describe("buildNovelExportPackage - explicit subset", () => {
  it("exports exactly the requested subset without broadening", async () => {
    mockNovel(1);
    mockedDb.getEpisodesByNovelId.mockResolvedValue([
      makeEpisode({ id: 10, episodeNumber: "1" }),
      makeEpisode({ id: 11, episodeNumber: "2" }),
      makeEpisode({ id: 12, episodeNumber: "3" }),
    ] as any);

    const { pkg } = await buildNovelExportPackage({ novelId: 1, episodeIds: [11] });
    expect(pkg.items.map((i) => i.episodeId)).toEqual([11]);
  });

  it("rejects unknown episode ids", async () => {
    mockNovel(1);
    mockedDb.getEpisodesByNovelId.mockResolvedValue([makeEpisode({ id: 10 })] as any);

    await expect(buildNovelExportPackage({ novelId: 1, episodeIds: [999] })).rejects.toMatchObject({
      code: "EXPORT_UNKNOWN_EPISODE",
    });
  });

  it("rejects episodes belonging to another novel (cross-novel selection)", async () => {
    mockNovel(1);
    mockedDb.getEpisodesByNovelId.mockResolvedValue([makeEpisode({ id: 10, novelId: 1 })] as any);

    await expect(buildNovelExportPackage({ novelId: 1, episodeIds: [10, 9999] })).rejects.toMatchObject({
      code: "EXPORT_UNKNOWN_EPISODE",
    });

    // Direct cross-novel case: id exists but is owned by novel 2.
    mockedDb.getEpisodesByNovelId.mockResolvedValue([makeEpisode({ id: 10, novelId: 2 })] as any);
    await expect(buildNovelExportPackage({ novelId: 1, episodeIds: [10] })).rejects.toMatchObject({
      code: "EXPORT_EPISODE_NOT_IN_NOVEL",
    });
  });

  it("rejects duplicate selection ids", async () => {
    mockNovel(1);
    mockedDb.getEpisodesByNovelId.mockResolvedValue([makeEpisode({ id: 10 })] as any);

    await expect(buildNovelExportPackage({ novelId: 1, episodeIds: [10, 10] })).rejects.toMatchObject({
      code: "EXPORT_DUPLICATE_SELECTION",
    });
  });

  it("fails closed when a subset member has no canonical content", async () => {
    mockNovel(1);
    mockedDb.getEpisodesByNovelId.mockResolvedValue([
      makeEpisode({ id: 10, content: null }),
      makeEpisode({ id: 11, episodeNumber: "2" }),
    ] as any);

    await expect(buildNovelExportPackage({ novelId: 1, episodeIds: [10, 11] })).rejects.toMatchObject({
      code: "EXPORT_EPISODE_MISSING_CONTENT",
    });
  });

  it("fails closed when a subset member is not published", async () => {
    mockNovel(1);
    mockedDb.getEpisodesByNovelId.mockResolvedValue([
      makeEpisode({ id: 10, isPublished: false }),
      makeEpisode({ id: 11, episodeNumber: "2" }),
    ] as any);

    await expect(buildNovelExportPackage({ novelId: 1, episodeIds: [10, 11] })).rejects.toMatchObject({
      code: "EXPORT_EPISODE_MISSING_CONTENT",
    });
  });
});

describe("buildNovelExportPackage - novel resolution", () => {
  it("rejects a nonexistent novel", async () => {
    mockedDb.getNovelById.mockResolvedValue(undefined as any);
    await expect(buildNovelExportPackage({ novelId: 42 })).rejects.toMatchObject({
      code: "EXPORT_NOVEL_NOT_FOUND",
    });
  });

  it("resolves the novel without the public-only filter (archived novels remain admin-exportable)", async () => {
    mockNovel(7);
    mockedDb.getEpisodesByNovelId.mockResolvedValue([makeEpisode({ id: 10 })] as any);

    await buildNovelExportPackage({ novelId: 7 });
    expect(mockedDb.getNovelById).toHaveBeenCalledWith(7, false);
  });
});

describe("preview", () => {
  it("reports counts, skip reasons and canonical filename order without content", async () => {
    mockNovel(1, "เรื่องยาว");
    mockedDb.getEpisodesByNovelId.mockResolvedValue([
      makeEpisode({ id: 3, episodeNumber: "10" }),
      makeEpisode({ id: 1, episodeNumber: "1" }),
      makeEpisode({ id: 2, episodeNumber: "2" }),
      makeEpisode({ id: 4, episodeNumber: "001-050" }),
      makeEpisode({ id: 5, episodeNumber: "5", content: null }),
    ] as any);

    const preview = await buildNovelExportPreview({ novelId: 1 });
    expect(preview.mode).toBe("whole_novel");
    expect(preview.exportItemCount).toBe(4);
    expect(preview.skippedItems.map((s) => s.episodeId)).toEqual([5]);
    expect(preview.filenames).toEqual(["001.txt", "002.txt", "010.txt", "001-050.txt"]);
    expect(preview.limits.maxItems).toBeGreaterThan(0);
  });
});

describe("TXT export", () => {
  it("exports one published episode with canonical content", async () => {
    mockNovel(1);
    mockedDb.getEpisodesByNovelId.mockResolvedValue([makeEpisode({ id: 10, episodeNumber: "7", content: "สวัสดี\r\nโลก" })] as any);

    const result = await buildNovelTxtExport(1, 10);
    expect(result.filename).toBe("007.txt");
    expect(result.content.toString("utf8")).toBe("สวัสดี\nโลก");
    expect(result.mimeType).toBe("text/plain; charset=utf-8");
  });

  it("refuses TXT export for an episode missing content (subset semantics)", async () => {
    mockNovel(1);
    mockedDb.getEpisodesByNovelId.mockResolvedValue([makeEpisode({ id: 10, content: null })] as any);

    await expect(buildNovelTxtExport(1, 10)).rejects.toMatchObject({ code: "EXPORT_EPISODE_MISSING_CONTENT" });
  });
});

describe("ZIP export - sale metadata integrity", () => {
  it("rejects non-free episodes with zero price before archive construction", async () => {
    mockNovel(1);
    mockedDb.getEpisodesByNovelId.mockResolvedValue([makeEpisode({ id: 10, isFree: false, price: "0.00" })] as any);

    await expect(buildNovelZipExport({ novelId: 1 })).rejects.toMatchObject({ code: "EXPORT_INVALID_SALE_METADATA" });
  });

  it("returns skipped legacy items alongside a successful ZIP", async () => {
    mockNovel(1);
    mockedDb.getEpisodesByNovelId.mockResolvedValue([
      makeEpisode({ id: 10, episodeNumber: "1" }),
      makeEpisode({ id: 11, episodeNumber: "2", content: null }),
    ] as any);

    const result = await buildNovelZipExport({ novelId: 1 });
    expect(result.itemCount).toBe(1);
    expect(result.skippedItems.map((s) => s.episodeId)).toEqual([11]);
    expect(result.mimeType).toBe("application/zip");
  });

  // IPE-064R4B review round 23 (P2): a contentless published episode still
  // owns its DECLARED identity — a selected range pack overrunning into that
  // number must fail the collision check even though the empty episode is
  // skipped from the archive itself.
  it("fails the Thai ZIP when a selected range pack overruns into a contentless published episode", async () => {
    mockNovel(1);
    mockedDb.getEpisodesByNovelId.mockResolvedValue([
      makeEpisode({
        id: 10,
        episodeNumber: "141-190",
        content: "บทที่ 141 เริ่มต้น\nเนื้อหา\nบทที่ 191 ล้นช่วง\nเนื้อหาล้น",
      }),
      makeEpisode({ id: 11, episodeNumber: "191", content: null }),
    ] as any);

    await expect(buildThaiNovelZipExport({ novelId: 1, episodeIds: [10] })).rejects.toMatchObject({
      code: "EXPORT_INVALID_EPISODE_IDENTITY",
    } as Partial<NovelExportError>);
  });
});
