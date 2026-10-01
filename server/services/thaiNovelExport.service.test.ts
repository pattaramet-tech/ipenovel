// IPE-059-B - Thai-Novel export service tests: published-only authority and
// selection safety shared with IPE-059-A, exercised through the Thai-Novel
// preview/ZIP builders. The DB layer (`../db`) is mocked entirely.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../db", () => ({
  getNovelById: vi.fn(),
  getEpisodesByNovelId: vi.fn(),
}));

import * as db from "../db";
import { buildThaiNovelExportPreview, buildThaiNovelZipExport } from "./novelExport.service";

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
};

function makeEpisode(overrides: Partial<EpisodeRow> = {}): EpisodeRow {
  return {
    id: 1,
    novelId: 1,
    episodeNumber: "1",
    title: "ตอนที่ 1",
    content: "เนื้อหา",
    price: "0.00",
    isFree: true,
    isPublished: true,
    contentFormat: "plain_text",
    sortOrder: null,
    saleMode: "package",
    fileUrl: null,
    ...overrides,
  };
}

function mockNovel(novelId: number, title = "ตำนานมังกร") {
  mockedDb.getNovelById.mockResolvedValue({ id: novelId, title } as any);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Thai-Novel preview - published-only authority", () => {
  it("lists and exports only published episodes; drafts never leak", async () => {
    mockNovel(1);
    mockedDb.getEpisodesByNovelId.mockResolvedValue([
      makeEpisode({ id: 10, episodeNumber: "1" }),
      makeEpisode({ id: 11, episodeNumber: "2", isPublished: false, title: "ฉบับร่าง" }),
    ] as any);

    const preview = await buildThaiNovelExportPreview({ novelId: 1 });
    expect(preview.sourceEpisodes.map((e) => e.episodeId)).toEqual([10]);
    expect(preview.entries.map((e) => e.filename)).toEqual(["001.txt"]);
    expect(JSON.stringify(preview)).not.toContain("ฉบับร่าง");
    expect(JSON.stringify(preview)).not.toContain("เนื้อหา"); // no content over the wire
  });

  it("preview derives from the same serializer as the download", async () => {
    mockNovel(1);
    mockedDb.getEpisodesByNovelId.mockResolvedValue([
      makeEpisode({ id: 10, episodeNumber: "1", title: "การพบกันอีกครั้ง" }),
    ] as any);

    const preview = await buildThaiNovelExportPreview({ novelId: 1 }, { titlePrefix: "ตอนที่" });
    const zip = await buildThaiNovelZipExport({ novelId: 1 }, { titlePrefix: "ตอนที่" });

    expect(preview.entries[0].title).toBe("ตอนที่ การพบกันอีกครั้ง");
    expect(zip.entries).toEqual(preview.entries);
    expect(zip.filename).toBe("ตำนานมังกร-thainovel.zip");
  });
});

describe("Thai-Novel export - selection safety", () => {
  it("exports an explicit subset with renumbering, same novel only", async () => {
    mockNovel(1);
    mockedDb.getEpisodesByNovelId.mockResolvedValue([
      makeEpisode({ id: 10, episodeNumber: "5" }),
      makeEpisode({ id: 11, episodeNumber: "7" }),
      makeEpisode({ id: 12, episodeNumber: "10" }),
    ] as any);

    const preview = await buildThaiNovelExportPreview({ novelId: 1, episodeIds: [11] }, { startEpisodeNumber: 101 });
    expect(preview.mode).toBe("explicit_subset");
    expect(preview.entries.map((e) => [e.sourceEpisodeNumber, e.filename])).toEqual([["7", "101.txt"]]);
  });

  it("fails closed on unknown episode ids", async () => {
    mockNovel(1);
    mockedDb.getEpisodesByNovelId.mockResolvedValue([makeEpisode({ id: 10 })] as any);

    await expect(buildThaiNovelZipExport({ novelId: 1, episodeIds: [999] })).rejects.toMatchObject({
      code: "EXPORT_UNKNOWN_EPISODE",
    });
  });

  it("fails closed on cross-novel episode ids", async () => {
    mockNovel(1);
    mockedDb.getEpisodesByNovelId.mockResolvedValue([makeEpisode({ id: 10, novelId: 2 })] as any);

    await expect(buildThaiNovelZipExport({ novelId: 1, episodeIds: [10] })).rejects.toMatchObject({
      code: "EXPORT_EPISODE_NOT_IN_NOVEL",
    });
  });

  it("fails closed when a subset member has no canonical content", async () => {
    mockNovel(1);
    mockedDb.getEpisodesByNovelId.mockResolvedValue([
      makeEpisode({ id: 10, content: null }),
      makeEpisode({ id: 11, episodeNumber: "2" }),
    ] as any);

    await expect(buildThaiNovelZipExport({ novelId: 1, episodeIds: [10, 11] })).rejects.toMatchObject({
      code: "EXPORT_EPISODE_MISSING_CONTENT",
    });
  });

  it("skips-and-reports missing content for whole-novel exports", async () => {
    mockNovel(1);
    mockedDb.getEpisodesByNovelId.mockResolvedValue([
      makeEpisode({ id: 10, episodeNumber: "1" }),
      makeEpisode({ id: 11, episodeNumber: "2", content: null }),
    ] as any);

    const zip = await buildThaiNovelZipExport({ novelId: 1 });
    expect(zip.itemCount).toBe(1);
    expect(zip.skippedItems.map((s) => s.episodeId)).toEqual([11]);
  });

  it("rejects a nonexistent novel", async () => {
    mockedDb.getNovelById.mockResolvedValue(undefined as any);
    await expect(buildThaiNovelExportPreview({ novelId: 42 })).rejects.toMatchObject({
      code: "EXPORT_NOVEL_NOT_FOUND",
    });
  });
});

describe("Thai-Novel ZIP download contract", () => {
  it("returns a flat-root archive with deterministic filename", async () => {
    mockNovel(1);
    mockedDb.getEpisodesByNovelId.mockResolvedValue([
      makeEpisode({ id: 10, episodeNumber: "1" }),
      makeEpisode({ id: 11, episodeNumber: "2" }),
    ] as any);

    const zip = await buildThaiNovelZipExport({ novelId: 1 }, { startEpisodeNumber: 100 });
    expect(zip.mimeType).toBe("application/zip");
    expect(zip.entryFilenames).toEqual(["100.txt", "101.txt"]);
    expect(zip.filename).toBe("ตำนานมังกร-thainovel.zip");
  });
});
