// IPE-059-C — Thai-Novel service tests.
// DB is mocked; these tests pin published-only authority, pack expansion,
// selection safety, preview/download parity, and flat Naruto-style filenames.

import { beforeEach, describe, expect, it, vi } from "vitest";
import AdmZip from "adm-zip";

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

function makePackContent(start: number, end: number, counter = "001"): string {
  const chapters = Array.from({ length: end - start + 1 }, (_, index) => {
    const chapter = start + index;
    return `บทที่ ${chapter} จ้าวกลยุทธ์โปเกมอน\n\nเนื้อหาบท ${chapter}`;
  });
  return `แพ็กตอน ${start} - ${end} ${counter}\n\n${chapters.join("\n\n")}`;
}

function mockNovel(novelId: number, title = "ตำนานมังกร") {
  mockedDb.getNovelById.mockResolvedValue({ id: novelId, title } as any);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Thai-Novel preview - published-only authority", () => {
  it("lists and exports only published Episodes; drafts never leak", async () => {
    mockNovel(1);
    mockedDb.getEpisodesByNovelId.mockResolvedValue([
      makeEpisode({ id: 10, episodeNumber: "1", title: "บทที่ 1", content: "บทที่ 1 จุดเริ่มต้น\n\nเนื้อหา" }),
      makeEpisode({ id: 11, episodeNumber: "2", isPublished: false, title: "ฉบับร่าง" }),
    ] as any);

    const preview = await buildThaiNovelExportPreview({ novelId: 1 });
    expect(preview.sourceEpisodes.map((entry) => entry.episodeId)).toEqual([10]);
    expect(preview.entries.map((entry) => entry.filename)).toEqual(["บทที่ 1 จุดเริ่มต้น.txt"]);
    expect(JSON.stringify(preview)).not.toContain("ฉบับร่าง");
    expect(JSON.stringify(preview)).not.toContain("เนื้อหา");
  });

  it("preview derives from the exact same expanded serializer as download", async () => {
    mockNovel(1);
    mockedDb.getEpisodesByNovelId.mockResolvedValue([
      makeEpisode({
        id: 10,
        episodeNumber: "141 - 143",
        title: "แพ็กตอน 141 - 143 001",
        content: makePackContent(141, 143),
      }),
    ] as any);

    const preview = await buildThaiNovelExportPreview({ novelId: 1 });
    const zip = await buildThaiNovelZipExport({ novelId: 1 });

    expect(preview.sourceEpisodes).toHaveLength(1);
    expect(preview.entries).toHaveLength(3);
    expect(zip.entries).toEqual(preview.entries);
    expect(zip.filename).toBe("ตำนานมังกร-thainovel.zip");
    expect(zip.entryFilenames).toEqual([
      "บทที่ 141 จ้าวกลยุทธ์โปเกมอน.txt",
      "บทที่ 142 จ้าวกลยุทธ์โปเกมอน.txt",
      "บทที่ 143 จ้าวกลยุทธ์โปเกมอน.txt",
    ]);
  });
});

describe("Thai-Novel pack split", () => {
  it("turns one published pack Episode into one TXT per embedded chapter and removes the pack wrapper", async () => {
    mockNovel(1, "เกิดใหม่ในโลกโปเกมอน เส้นทางจ้าวกลยุทธ์");
    mockedDb.getEpisodesByNovelId.mockResolvedValue([
      makeEpisode({
        id: 50,
        episodeNumber: "141 - 143",
        title: "แพ็กตอน 141 - 143 001",
        content: makePackContent(141, 143),
      }),
    ] as any);

    const result = await buildThaiNovelZipExport({ novelId: 1 });
    expect(result.itemCount).toBe(3);

    const zip = new AdmZip(result.content);
    const first = zip.getEntry("บทที่ 141 จ้าวกลยุทธ์โปเกมอน.txt")!.getData().toString("utf8");
    expect(first).toBe("บทที่ 141 จ้าวกลยุทธ์โปเกมอน\n\nเนื้อหาบท 141");
    expect(first).not.toContain("แพ็กตอน");
  });

  it("fails closed if a pack range and embedded chapter sequence disagree", async () => {
    mockNovel(1);
    mockedDb.getEpisodesByNovelId.mockResolvedValue([
      makeEpisode({
        id: 50,
        episodeNumber: "141 - 143",
        content: "แพ็กตอน 141 - 143 001\n\nบทที่ 141 A\n\nหนึ่ง\n\nบทที่ 143 C\n\nสาม",
      }),
    ] as any);

    await expect(buildThaiNovelZipExport({ novelId: 1 })).rejects.toMatchObject({
      code: "EXPORT_INVALID_EPISODE_IDENTITY",
    });
  });
});

describe("Thai-Novel selection safety", () => {
  it("an explicit subset selects source Episodes; selecting one pack exports all chapters inside that selected pack", async () => {
    mockNovel(1);
    mockedDb.getEpisodesByNovelId.mockResolvedValue([
      makeEpisode({ id: 10, episodeNumber: "5", title: "บทที่ 5", content: "บทที่ 5 ห้า\n\nห้า" }),
      makeEpisode({
        id: 11,
        episodeNumber: "141 - 143",
        title: "แพ็กตอน 141 - 143 001",
        content: makePackContent(141, 143),
      }),
      makeEpisode({ id: 12, episodeNumber: "200", title: "บทที่ 200", content: "บทที่ 200 สองร้อย\n\nสองร้อย" }),
    ] as any);

    const preview = await buildThaiNovelExportPreview({ novelId: 1, episodeIds: [11] });
    expect(preview.mode).toBe("explicit_subset");
    expect(preview.entries.map((entry) => entry.sourceChapterNumber)).toEqual(["141", "142", "143"]);
  });

  it("supports an explicit start-number override after pack expansion", async () => {
    mockNovel(1);
    mockedDb.getEpisodesByNovelId.mockResolvedValue([
      makeEpisode({
        id: 11,
        episodeNumber: "141 - 143",
        title: "แพ็กตอน 141 - 143 001",
        content: makePackContent(141, 143),
      }),
    ] as any);

    const preview = await buildThaiNovelExportPreview(
      { novelId: 1, episodeIds: [11] },
      { startEpisodeNumber: 391 }
    );
    expect(preview.entries.map((entry) => entry.filename)).toEqual([
      "บทที่ 391 จ้าวกลยุทธ์โปเกมอน.txt",
      "บทที่ 392 จ้าวกลยุทธ์โปเกมอน.txt",
      "บทที่ 393 จ้าวกลยุทธ์โปเกมอน.txt",
    ]);
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
      makeEpisode({ id: 10, episodeNumber: "1", title: "หนึ่ง" }),
      makeEpisode({ id: 11, episodeNumber: "2", content: null }),
    ] as any);

    const zip = await buildThaiNovelZipExport({ novelId: 1 });
    expect(zip.itemCount).toBe(1);
    expect(zip.skippedItems.map((entry) => entry.episodeId)).toEqual([11]);
  });

  it("rejects a nonexistent novel", async () => {
    mockedDb.getNovelById.mockResolvedValue(undefined as any);
    await expect(buildThaiNovelExportPreview({ novelId: 42 })).rejects.toMatchObject({
      code: "EXPORT_NOVEL_NOT_FOUND",
    });
  });
});

describe("Thai-Novel ZIP download contract", () => {
  it("returns a flat-root archive whose filenames mirror chapter headings", async () => {
    mockNovel(1);
    mockedDb.getEpisodesByNovelId.mockResolvedValue([
      makeEpisode({ id: 10, episodeNumber: "1", title: "หนึ่ง", content: "บทที่ 1 หนึ่ง\n\nเนื้อหา" }),
      makeEpisode({ id: 11, episodeNumber: "2", title: "สอง", content: "บทที่ 2 สอง\n\nเนื้อหา" }),
    ] as any);

    const zip = await buildThaiNovelZipExport({ novelId: 1 });
    expect(zip.mimeType).toBe("application/zip");
    expect(zip.entryFilenames).toEqual(["บทที่ 1 หนึ่ง.txt", "บทที่ 2 สอง.txt"]);
    expect(zip.entryFilenames.every((name) => !name.includes("/"))).toBe(true);
    expect(zip.filename).toBe("ตำนานมังกร-thainovel.zip");
  });
});

describe("IPE-064R3 over-limit preview", () => {
  it("whole-novel preview over MAX_EXPORT_ITEMS returns overLimit + sourceEpisodes instead of throwing", async () => {
    mockNovel(1, "เรื่องใหญ่");
    mockedDb.getEpisodesByNovelId.mockResolvedValue([
      makeEpisode({ id: 10, episodeNumber: "1 - 250", content: makePackContent(1, 250) }),
      makeEpisode({ id: 11, episodeNumber: "251 - 501", content: makePackContent(251, 501) }),
    ] as any);

    const preview = await buildThaiNovelExportPreview({ novelId: 1 });
    expect(preview.overLimit).toEqual({ itemCount: 501, maxItems: 500 });
    expect(preview.entries).toHaveLength(0);
    expect(preview.sourceEpisodes).toHaveLength(2);
  });

  it("an explicit subset over the limit still fails closed", async () => {
    mockNovel(1, "เรื่องใหญ่");
    mockedDb.getEpisodesByNovelId.mockResolvedValue([
      makeEpisode({ id: 10, episodeNumber: "1 - 300", content: makePackContent(1, 300) }),
      makeEpisode({ id: 11, episodeNumber: "301 - 600", content: makePackContent(301, 600) }),
    ] as any);

    await expect(
      buildThaiNovelExportPreview({ novelId: 1, episodeIds: [10, 11] })
    ).rejects.toMatchObject({ code: "EXPORT_LIMIT_ITEMS" });
  });
});
