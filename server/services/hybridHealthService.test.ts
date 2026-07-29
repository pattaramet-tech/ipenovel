import { beforeEach, describe, expect, it, vi } from "vitest";

const dbMock = vi.hoisted(() => ({
  getNovelById: vi.fn(),
}));
vi.mock("../db", () => dbMock);

const queriesMock = vi.hoisted(() => ({
  queryEpisodeHealthRowsForNovel: vi.fn(),
  queryHybridHealthGlobalSummary: vi.fn(),
  queryHybridHealthNovelOverview: vi.fn(),
}));
vi.mock("./hybridHealthQueries", () => queriesMock);

import { computeContentFlags } from "./readerService";
import {
  classifyContentStatus,
  classifyPriority,
  getHybridHealthDetail,
  getHybridHealthOverview,
  NovelNotFoundError,
  type EpisodeHealthDetail,
} from "./hybridHealthService";
import type { EpisodeHealthRow } from "./hybridHealthQueries";

/**
 * The dashboard computes hasPlaintext/hasLegacyFile in SQL
 * (TRIM(COALESCE(x, '')) <> ''), never in JS - see hybridHealthQueries.ts.
 * These tests build fixture rows using the exact booleans that SQL
 * expression would produce for a given raw `content` value, and separately
 * assert readerService.computeContentFlags() (the JS single source of
 * truth used everywhere else) agrees on every case - closing the loop that
 * the two independently-evaluated definitions never diverge.
 */
function hasPlaintextForRawContent(content: string | null | undefined): boolean {
  return computeContentFlags({ content }).hasContent;
}

function makeRow(overrides: Partial<EpisodeHealthRow> = {}): EpisodeHealthRow {
  return {
    episodeId: 1,
    novelId: 1,
    episodeNumber: "1",
    episodeTitle: "Episode 1",
    saleMode: "chapter",
    isPublished: false,
    price: "0.00",
    sortOrder: null,
    contentFormat: "plain_text",
    hasPlaintext: true,
    hasLegacyFile: false,
    trimmedContentLength: 10,
    isPurchased: false,
    ...overrides,
  };
}

describe("computeContentFlags <-> SQL hasPlaintext equivalence", () => {
  it.each([
    ["NULL content", null, false],
    ["empty string", "", false],
    ["whitespace-only", "   \n\t  ", false],
    ["non-empty plain text", "Chapter one text", true],
    ["non-empty markdown", "# Chapter one", true],
    ["non-empty html", "<p>Chapter one</p>", true],
  ])("%s -> hasPlaintext=%s", (_label, content, expected) => {
    expect(hasPlaintextForRawContent(content as any)).toBe(expected);
  });
});

describe("classifyContentStatus", () => {
  it("hasPlaintext + no file -> PLAINTEXT_ONLY", () => {
    expect(classifyContentStatus(true, false)).toBe("PLAINTEXT_ONLY");
  });
  it("hasPlaintext + file -> HYBRID", () => {
    expect(classifyContentStatus(true, true)).toBe("HYBRID");
  });
  it("no plaintext + file -> LEGACY_ONLY", () => {
    expect(classifyContentStatus(false, true)).toBe("LEGACY_ONLY");
  });
  it("no plaintext + no file -> MISSING_BOTH", () => {
    expect(classifyContentStatus(false, false)).toBe("MISSING_BOTH");
  });
});

describe("classifyPriority", () => {
  it("MISSING_BOTH + purchased -> CRITICAL", () => {
    expect(classifyPriority(false, false, false, true)).toBe("CRITICAL");
  });
  it("published + missing plaintext (not purchased) -> HIGH", () => {
    expect(classifyPriority(false, false, true, false)).toBe("HIGH");
    expect(classifyPriority(false, true, true, false)).toBe("HIGH");
  });
  it("LEGACY_ONLY, draft, unpurchased -> MEDIUM", () => {
    expect(classifyPriority(false, true, false, false)).toBe("MEDIUM");
  });
  it("MISSING_BOTH, draft, unpurchased -> MEDIUM (not yet exposed to anyone)", () => {
    expect(classifyPriority(false, false, false, false)).toBe("MEDIUM");
  });
  it("hasPlaintext -> always HEALTHY regardless of other flags", () => {
    expect(classifyPriority(true, false, false, false)).toBe("HEALTHY");
    expect(classifyPriority(true, true, true, true)).toBe("HEALTHY");
  });
});

describe("getHybridHealthDetail - classification via the full episode set", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbMock.getNovelById.mockResolvedValue({ id: 1, title: "Test Novel", publicationStatus: "published" });
  });

  async function detailFor(rows: EpisodeHealthRow[]): Promise<EpisodeHealthDetail[]> {
    queriesMock.queryEpisodeHealthRowsForNovel.mockResolvedValue(rows);
    const result = await getHybridHealthDetail({ novelId: 1, status: "all", pageSize: 100 });
    return result.episodes;
  }

  it("content non-empty + no file -> PLAINTEXT_ONLY, no MISSING_PLAINTEXT warning", async () => {
    const [ep] = await detailFor([makeRow({ hasPlaintext: true, hasLegacyFile: false })]);
    expect(ep.contentStatus).toBe("PLAINTEXT_ONLY");
    expect(ep.hasPlaintext).toBe(true);
    expect(ep.warnings.some((w) => w.code === "MISSING_PLAINTEXT")).toBe(false);
  });

  it("content non-empty + file -> HYBRID", async () => {
    const [ep] = await detailFor([makeRow({ hasPlaintext: true, hasLegacyFile: true })]);
    expect(ep.contentStatus).toBe("HYBRID");
  });

  it("no content + file -> LEGACY_ONLY, with LEGACY_ONLY + MISSING_PLAINTEXT warnings", async () => {
    const [ep] = await detailFor([makeRow({ hasPlaintext: false, hasLegacyFile: true })]);
    expect(ep.contentStatus).toBe("LEGACY_ONLY");
    expect(ep.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(["MISSING_PLAINTEXT", "LEGACY_ONLY"]));
    expect(ep.warnings.some((w) => w.code === "MISSING_BOTH")).toBe(false);
  });

  it("no content + no file -> MISSING_BOTH, with MISSING_BOTH + MISSING_PLAINTEXT warnings", async () => {
    const [ep] = await detailFor([makeRow({ hasPlaintext: false, hasLegacyFile: false })]);
    expect(ep.contentStatus).toBe("MISSING_BOTH");
    expect(ep.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(["MISSING_PLAINTEXT", "MISSING_BOTH"]));
  });

  it("purchased + MISSING_BOTH -> PURCHASED_BUT_UNREADABLE warning and CRITICAL priority", async () => {
    const [ep] = await detailFor([makeRow({ hasPlaintext: false, hasLegacyFile: false, isPurchased: true })]);
    expect(ep.warnings.some((w) => w.code === "PURCHASED_BUT_UNREADABLE")).toBe(true);
    expect(ep.priority).toBe("CRITICAL");
  });

  it("published + missing plaintext -> PUBLISHED_WITHOUT_PLAINTEXT warning and HIGH priority", async () => {
    const [ep] = await detailFor([makeRow({ hasPlaintext: false, hasLegacyFile: true, isPublished: true })]);
    expect(ep.warnings.some((w) => w.code === "PUBLISHED_WITHOUT_PLAINTEXT")).toBe(true);
    expect(ep.priority).toBe("HIGH");
  });

  it("markdown/html content that is non-empty -> hasPlaintext=true but NON_PLAIN_TEXT_FORMAT info warning, not counted as missing", async () => {
    const [ep] = await detailFor([
      makeRow({ hasPlaintext: true, hasLegacyFile: false, contentFormat: "markdown" }),
    ]);
    expect(ep.hasPlaintext).toBe(true);
    expect(ep.contentStatus).toBe("PLAINTEXT_ONLY");
    const warning = ep.warnings.find((w) => w.code === "NON_PLAIN_TEXT_FORMAT");
    expect(warning).toBeDefined();
    expect(warning?.severity).toBe("info");
    expect(ep.warnings.some((w) => w.code === "MISSING_PLAINTEXT")).toBe(false);
  });

  it("plain_text format never triggers NON_PLAIN_TEXT_FORMAT", async () => {
    const [ep] = await detailFor([makeRow({ hasPlaintext: true, contentFormat: "plain_text" })]);
    expect(ep.warnings.some((w) => w.code === "NON_PLAIN_TEXT_FORMAT")).toBe(false);
  });

  it("duplicate normalized ranges within the same novel produce DUPLICATE_RANGE warnings on both", async () => {
    const rows = await detailFor([
      makeRow({ episodeId: 1, episodeNumber: "51 - 100", saleMode: "package" }),
      makeRow({ episodeId: 2, episodeNumber: "051-100", saleMode: "package" }),
    ]);
    expect(rows[0].warnings.some((w) => w.code === "DUPLICATE_RANGE")).toBe(true);
    expect(rows[1].warnings.some((w) => w.code === "DUPLICATE_RANGE")).toBe(true);
  });

  it("package episode with an unparseable range gets UNPARSEABLE_RANGE", async () => {
    const [ep] = await detailFor([makeRow({ episodeNumber: "special", saleMode: "package" })]);
    expect(ep.warnings.some((w) => w.code === "UNPARSEABLE_RANGE")).toBe(true);
  });

  it("throws NovelNotFoundError when the novel does not exist", async () => {
    dbMock.getNovelById.mockResolvedValue(undefined);
    queriesMock.queryEpisodeHealthRowsForNovel.mockResolvedValue([]);
    await expect(getHybridHealthDetail({ novelId: 999 })).rejects.toBeInstanceOf(NovelNotFoundError);
  });

  it("a novel with zero episodes gets totalEpisodes=0 and missingPlaintextCount=0", async () => {
    queriesMock.queryEpisodeHealthRowsForNovel.mockResolvedValue([]);
    const result = await getHybridHealthDetail({ novelId: 1 });
    expect(result.novel.totalEpisodes).toBe(0);
    expect(result.novel.missingPlaintextCount).toBe(0);
    expect(result.total).toBe(0);
  });

  it("status filter defaults to missing_plaintext (excludes PLAINTEXT_ONLY/HYBRID)", async () => {
    queriesMock.queryEpisodeHealthRowsForNovel.mockResolvedValue([
      makeRow({ episodeId: 1, hasPlaintext: true, hasLegacyFile: false }),
      makeRow({ episodeId: 2, hasPlaintext: false, hasLegacyFile: true }),
      makeRow({ episodeId: 3, hasPlaintext: false, hasLegacyFile: false }),
    ]);
    const result = await getHybridHealthDetail({ novelId: 1 });
    expect(result.episodes.map((e) => e.episodeId).sort()).toEqual([2, 3]);
  });

  it("never exposes content or fileUrl fields on the response", async () => {
    queriesMock.queryEpisodeHealthRowsForNovel.mockResolvedValue([makeRow()]);
    const result = await getHybridHealthDetail({ novelId: 1, status: "all" });
    for (const ep of result.episodes) {
      expect(ep).not.toHaveProperty("content");
      expect(ep).not.toHaveProperty("fileUrl");
    }
  });
});

describe("getHybridHealthOverview - defaults", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queriesMock.queryHybridHealthNovelOverview.mockResolvedValue({ novels: [], total: 0 });
    queriesMock.queryHybridHealthGlobalSummary.mockResolvedValue({
      totalNovels: 0,
      novelsMissingPlaintext: 0,
      totalEpisodes: 0,
      plaintextCount: 0,
      missingPlaintextCount: 0,
      legacyOnlyCount: 0,
      missingBothCount: 0,
      publishedMissingPlaintextCount: 0,
      purchasedMissingPlaintextCount: 0,
    });
  });

  it("applies documented defaults when called with no input", async () => {
    await getHybridHealthOverview();
    expect(queriesMock.queryHybridHealthNovelOverview).toHaveBeenCalledWith(
      expect.objectContaining({
        page: 1,
        pageSize: 50,
        status: "missing_plaintext",
        sortBy: "missingPlaintextCount",
        sortOrder: "desc",
      })
    );
  });

  it("computes plaintextCoveragePercent per novel, 0% for a novel with zero episodes", async () => {
    queriesMock.queryHybridHealthNovelOverview.mockResolvedValue({
      novels: [
        {
          novelId: 1,
          title: "Empty Novel",
          publicationStatus: "published",
          totalEpisodes: 0,
          plaintextCount: 0,
          missingPlaintextCount: 0,
          plaintextOnlyCount: 0,
          hybridCount: 0,
          legacyOnlyCount: 0,
          missingBothCount: 0,
          publishedMissingPlaintextCount: 0,
          purchasedMissingPlaintextCount: 0,
          packageMissingPlaintextCount: 0,
          chapterMissingPlaintextCount: 0,
          riskyEpisodeCount: 0,
        },
        {
          novelId: 2,
          title: "Half Done",
          publicationStatus: "published",
          totalEpisodes: 4,
          plaintextCount: 3,
          missingPlaintextCount: 1,
          plaintextOnlyCount: 3,
          hybridCount: 0,
          legacyOnlyCount: 1,
          missingBothCount: 0,
          publishedMissingPlaintextCount: 0,
          purchasedMissingPlaintextCount: 0,
          packageMissingPlaintextCount: 0,
          chapterMissingPlaintextCount: 1,
          riskyEpisodeCount: 0,
        },
      ],
      total: 2,
    });
    const result = await getHybridHealthOverview();
    expect(result.novels[0].plaintextCoveragePercent).toBe(0);
    expect(result.novels[1].plaintextCoveragePercent).toBe(75);
  });
});
