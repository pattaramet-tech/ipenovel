import { describe, it, expect } from "vitest";
import AdmZip from "adm-zip";
import * as dbHelpers from "./db";
import { getDb } from "./db";
import {
  parseMultiNovelPackageZip,
  buildMultiNovelImportPreview,
  importMultiNovelPackageRows,
  normalizeNovelTitleForMatching,
  buildNovelTitleMatchCandidates,
  resolveNovelMatchForRows,
  type MultiNovelPackageImportRow,
  type AdminNovelForMatching,
} from "./services/packageZipImportService";

/**
 * Safety-net for the Multi-Novel Package ZIP Import feature (1 ZIP = many
 * novels, matched per-row via novelId or novel title). Covers:
 * - title normalization + colon-candidate matching (fandom prefix stripping)
 * - exact-match-only resolution: ambiguous/not_found block, never fuzzy
 * - duplicate episodeNumber detection scoped per resolved novel, not per zip
 * - preview never writing to the DB; a real import preserving fileUrl and
 *   enforcing create_only the same way the single-novel importer does
 */

function buildMultiNovelTestZip(csvBody: string, contentFiles: Record<string, string>) {
  const zip = new AdmZip();
  const csv = `novelTitle,novelMatchTitle,episodeNumber,episodeTitle,price,isFree,contentFile\n${csvBody}`;
  zip.addFile("manifest.csv", Buffer.from(csv, "utf-8"));
  for (const [path, content] of Object.entries(contentFiles)) {
    zip.addFile(path, Buffer.from(content, "utf-8"));
  }
  return zip.toBuffer();
}

describe("normalizeNovelTitleForMatching", () => {
  it("lowercases, trims, collapses whitespace, and strips a trailing chapter-range label", () => {
    expect(normalizeNovelTitleForMatching("  วันพีซ   001 - 080  ")).toBe("วันพีซ");
    expect(normalizeNovelTitleForMatching("Naruto 001-050")).toBe("naruto");
    expect(normalizeNovelTitleForMatching("นารูโตะ ตอนที่ 001 - 050")).toBe("นารูโตะ");
  });

  it("converts Thai digits to Arabic before matching", () => {
    expect(normalizeNovelTitleForMatching("วันพีซ ๐๐๑ - ๐๘๐")).toBe("วันพีซ");
  });

  it("strips decorative bracket symbols but keeps their contents", () => {
    expect(normalizeNovelTitleForMatching("[Hot] วันพีซ (Special)")).toBe("hot วันพีซ special");
  });
});

describe("buildNovelTitleMatchCandidates - colon-based fandom prefix stripping", () => {
  it("produces a colon-stripped candidate and a suffix-only candidate", () => {
    const candidates = buildNovelTitleMatchCandidates("วันพีซ: กองเรือโจรสลัดหญิงที่แข็งแกร่งที่สุด");
    expect(candidates).toContain(normalizeNovelTitleForMatching("วันพีซ กองเรือโจรสลัดหญิงที่แข็งแกร่งที่สุด"));
    expect(candidates).toContain(normalizeNovelTitleForMatching("กองเรือโจรสลัดหญิงที่แข็งแกร่งที่สุด"));
  });

  it("returns just the normalized title when there is no colon", () => {
    expect(buildNovelTitleMatchCandidates("นารูโตะ")).toEqual(["นารูโตะ"]);
  });

  it("returns an empty list for a blank title", () => {
    expect(buildNovelTitleMatchCandidates("")).toEqual([]);
  });
});

function makeRow(overrides: Partial<MultiNovelPackageImportRow>): MultiNovelPackageImportRow {
  return {
    row: 2,
    episodeNumber: "1-50",
    episodeTitle: "Test Pack",
    price: "100",
    isFree: false,
    isPublished: true,
    saleMode: "package",
    contentFile: "contents/1-50.txt",
    contentFormat: "plain_text",
    content: "เนื้อหา",
    contentLength: 5,
    novelMatchStatus: "not_found",
    ...overrides,
  };
}

describe("resolveNovelMatchForRows - pure matching logic (no DB)", () => {
  const adminNovels: AdminNovelForMatching[] = [
    { id: 10, title: "กองเรือโจรสลัดหญิงที่แข็งแกร่งที่สุด" },
    { id: 11, title: "อัจฉริยะผู้นี้ช่างธรรมดาสามัญ" },
  ];

  it("matches via novelId when it exists in the admin list", () => {
    const [resolved] = resolveNovelMatchForRows([makeRow({ novelId: 11 })], adminNovels);
    expect(resolved.novelMatchStatus).toBe("matched");
    expect(resolved.matchedNovelId).toBe(11);
  });

  it("blocks as invalid when novelId is given but doesn't exist", () => {
    const [resolved] = resolveNovelMatchForRows([makeRow({ novelId: 999 })], adminNovels);
    expect(resolved.novelMatchStatus).toBe("invalid");
    expect(resolved.matchedNovelId).toBeUndefined();
  });

  it("matches a title with a fandom prefix via the after-colon candidate (the ZIP example scenario)", () => {
    const [resolved] = resolveNovelMatchForRows(
      [makeRow({ novelTitle: "วันพีซ: กองเรือโจรสลัดหญิงที่แข็งแกร่งที่สุด 001 - 080", novelMatchTitle: undefined })],
      adminNovels
    );
    expect(resolved.novelMatchStatus).toBe("matched");
    expect(resolved.matchedNovelId).toBe(10);
  });

  it("blocks as not_found when no candidate matches any admin novel", () => {
    const [resolved] = resolveNovelMatchForRows([makeRow({ novelMatchTitle: "ไม่มีนิยายนี้ในระบบ" })], adminNovels);
    expect(resolved.novelMatchStatus).toBe("not_found");
  });

  it("blocks as ambiguous when a candidate matches more than one admin novel, and never fuzzy-picks one", () => {
    const dupeAdminNovels: AdminNovelForMatching[] = [
      { id: 20, title: "นารูโตะ" },
      { id: 21, title: "นารูโตะ" },
    ];
    const [resolved] = resolveNovelMatchForRows([makeRow({ novelMatchTitle: "นารูโตะ" })], dupeAdminNovels);
    expect(resolved.novelMatchStatus).toBe("ambiguous");
    expect(resolved.matchedNovelId).toBeUndefined();
  });

  it("applies a manual titleOverrideMap to resolve an otherwise not_found title", () => {
    const [resolved] = resolveNovelMatchForRows(
      [makeRow({ novelMatchTitle: "ไม่มีนิยายนี้ในระบบ" })],
      adminNovels,
      { "ไม่มีนิยายนี้ในระบบ": 11 }
    );
    expect(resolved.novelMatchStatus).toBe("matched");
    expect(resolved.matchedNovelId).toBe(11);
  });
});

describe("parseMultiNovelPackageZip - row-level validation (no DB)", () => {
  it("requires novelId or novelTitle/novelMatchTitle per row", () => {
    const csvBody = ",,1-50,No Novel Identifier,100,false,contents/1-50.txt";
    const zipBuffer = buildMultiNovelTestZip(csvBody, { "contents/1-50.txt": "เนื้อหา" });
    const parsed = parseMultiNovelPackageZip(zipBuffer);
    expect(parsed.rows).toHaveLength(0);
    expect(parsed.errors[0]?.code).toBe("MISSING_NOVEL_IDENTIFIER");
  });

  it("still enforces saleMode = package only", () => {
    const zip = new AdmZip();
    const csv =
      "novelTitle,episodeNumber,episodeTitle,price,isFree,saleMode,contentFile\n" +
      "นารูโตะ,1,Single Chapter,10,false,chapter,contents/1.txt";
    zip.addFile("manifest.csv", Buffer.from(csv, "utf-8"));
    zip.addFile("contents/1.txt", Buffer.from("เนื้อหา", "utf-8"));

    const parsed = parseMultiNovelPackageZip(zip.toBuffer());
    expect(parsed.rows).toHaveLength(0);
    expect(parsed.errors[0]?.field).toBe("saleMode");
  });

  it("does not dedupe episodeNumber across the whole file (deferred to preview, scoped per novel)", () => {
    const csvBody = [
      "นิยาย A,,1-50,Pack A,100,false,contents/a/1-50.txt",
      "นิยาย B,,1-50,Pack B,100,false,contents/b/1-50.txt",
    ].join("\n");
    const zipBuffer = buildMultiNovelTestZip(csvBody, {
      "contents/a/1-50.txt": "เนื้อหา A",
      "contents/b/1-50.txt": "เนื้อหา B",
    });
    const parsed = parseMultiNovelPackageZip(zipBuffer);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.errors).toHaveLength(0);
  });
});

describe("Multi-novel ZIP import - end-to-end DB integration (requires a live DATABASE_URL)", () => {
  it("previews a 2-novel ZIP successfully, matching each row to its own novel", async () => {
    const db = await getDb();
    if (!db) return;

    const ts = Date.now();
    const novelA: any = await dbHelpers.createNovel({ title: `Multi Novel A ${ts}`, author: "Test", description: "Test" });
    const novelB: any = await dbHelpers.createNovel({ title: `Multi Novel B ${ts}`, author: "Test", description: "Test" });

    const csvBody = [
      `Multi Novel A ${ts},,1-50,Pack A,100,false,contents/a/1-50.txt`,
      `Multi Novel B ${ts},,1-50,Pack B,120,false,contents/b/1-50.txt`,
    ].join("\n");
    const zipBuffer = buildMultiNovelTestZip(csvBody, {
      "contents/a/1-50.txt": "เนื้อหา A",
      "contents/b/1-50.txt": "เนื้อหา B",
    });
    const parsed = parseMultiNovelPackageZip(zipBuffer);
    expect(parsed.rows).toHaveLength(2);

    const preview = await buildMultiNovelImportPreview(parsed, "upsert");
    expect(preview.summary.novelCount).toBe(2);
    expect(preview.summary.errorCount).toBe(0);
    expect(preview.rows.every((r) => r.action === "create_new")).toBe(true);

    const rowA = preview.rows.find((r) => r.matchedNovelId === novelA.id);
    const rowB = preview.rows.find((r) => r.matchedNovelId === novelB.id);
    expect(rowA).toBeDefined();
    expect(rowB).toBeDefined();

    // Dry run - must not have written anything.
    expect(await dbHelpers.getEpisodesByNovelId(novelA.id)).toHaveLength(0);
    expect(await dbHelpers.getEpisodesByNovelId(novelB.id)).toHaveLength(0);
  });

  it("does not treat the same episodeNumber as a duplicate across two different novels", async () => {
    const db = await getDb();
    if (!db) return;

    const ts = Date.now();
    const novelA: any = await dbHelpers.createNovel({ title: `Dup Range Novel A ${ts}`, author: "Test", description: "Test" });
    const novelB: any = await dbHelpers.createNovel({ title: `Dup Range Novel B ${ts}`, author: "Test", description: "Test" });

    const csvBody = [
      `Dup Range Novel A ${ts},,1-50,Pack A,100,false,contents/a/1-50.txt`,
      `Dup Range Novel B ${ts},,1-50,Pack B,100,false,contents/b/1-50.txt`,
    ].join("\n");
    const zipBuffer = buildMultiNovelTestZip(csvBody, {
      "contents/a/1-50.txt": "เนื้อหา A",
      "contents/b/1-50.txt": "เนื้อหา B",
    });
    const parsed = parseMultiNovelPackageZip(zipBuffer);

    const preview = await buildMultiNovelImportPreview(parsed, "upsert");
    expect(preview.summary.duplicateRangeCount).toBe(0);
    expect(preview.rows.every((r) => r.action === "create_new")).toBe(true);

    const summary = await importMultiNovelPackageRows(parsed.rows, "upsert");
    expect(summary.createdCount).toBe(2);
    expect(summary.errorCount).toBe(0);
    expect(await dbHelpers.getEpisodesByNovelId(novelA.id)).toHaveLength(1);
    expect(await dbHelpers.getEpisodesByNovelId(novelB.id)).toHaveLength(1);
  });

  it("treats the same episodeNumber as a duplicate when it's the same novel twice in one ZIP", async () => {
    const db = await getDb();
    if (!db) return;

    const ts = Date.now();
    const novel: any = await dbHelpers.createNovel({ title: `Same Novel Dup ${ts}`, author: "Test", description: "Test" });

    const csvBody = [
      `Same Novel Dup ${ts},,1-50,Pack First,100,false,contents/1-50-a.txt`,
      `Same Novel Dup ${ts},,051 - 100,Pack Second,100,false,contents/51-100.txt`,
      `Same Novel Dup ${ts},,1-50,Pack Duplicate,100,false,contents/1-50-b.txt`,
    ].join("\n");
    const zipBuffer = buildMultiNovelTestZip(csvBody, {
      "contents/1-50-a.txt": "เนื้อหา A",
      "contents/51-100.txt": "เนื้อหา B",
      "contents/1-50-b.txt": "เนื้อหา C",
    });
    const parsed = parseMultiNovelPackageZip(zipBuffer);
    expect(parsed.rows).toHaveLength(3);

    const preview = await buildMultiNovelImportPreview(parsed, "upsert");
    expect(preview.summary.duplicateRangeCount).toBe(1);
    const dupRow = preview.rows.find((r) => r.episodeTitle === "Pack Duplicate");
    expect(dupRow?.action).toBe("error_duplicate_range");

    const summary = await importMultiNovelPackageRows(parsed.rows, "upsert");
    expect(summary.createdCount).toBe(2);
    expect(summary.errorCount).toBe(1);
    expect(await dbHelpers.getEpisodesByNovelId(novel.id)).toHaveLength(2);
  });

  it("not_found novel match blocks the row and writes nothing for it", async () => {
    const db = await getDb();
    if (!db) return;

    const ts = Date.now();
    const csvBody = `Novel That Does Not Exist ${ts},,1-50,Pack,100,false,contents/1-50.txt`;
    const zipBuffer = buildMultiNovelTestZip(csvBody, { "contents/1-50.txt": "เนื้อหา" });
    const parsed = parseMultiNovelPackageZip(zipBuffer);

    const preview = await buildMultiNovelImportPreview(parsed, "upsert");
    expect(preview.summary.novelNotFoundCount).toBe(1);
    expect(preview.rows[0].action).toBe("error_novel_not_found");

    const summary = await importMultiNovelPackageRows(parsed.rows, "upsert");
    expect(summary.successCount).toBe(0);
    expect(summary.errorCount).toBe(1);
  });

  it("ambiguous novel title match blocks the row instead of guessing", async () => {
    const db = await getDb();
    if (!db) return;

    const ts = Date.now();
    const sharedTitle = `Ambiguous Shared Title ${ts}`;
    await dbHelpers.createNovel({ title: sharedTitle, author: "Test", description: "Test" });
    await dbHelpers.createNovel({ title: sharedTitle, author: "Test", description: "Test" });

    const csvBody = `${sharedTitle},,1-50,Pack,100,false,contents/1-50.txt`;
    const zipBuffer = buildMultiNovelTestZip(csvBody, { "contents/1-50.txt": "เนื้อหา" });
    const parsed = parseMultiNovelPackageZip(zipBuffer);

    const preview = await buildMultiNovelImportPreview(parsed, "upsert");
    expect(preview.summary.novelAmbiguousCount).toBe(1);
    expect(preview.rows[0].action).toBe("error_novel_ambiguous");

    const summary = await importMultiNovelPackageRows(parsed.rows, "upsert");
    expect(summary.successCount).toBe(0);
    expect(summary.errorCount).toBe(1);
  });

  it("upsert preserves an existing episode's fileUrl when synced via the multi-novel path", async () => {
    const db = await getDb();
    if (!db) return;

    const ts = Date.now();
    const novel: any = await dbHelpers.createNovel({ title: `Multi Preserve FileUrl ${ts}`, author: "Test", description: "Test" });
    const legacyFileUrl = "https://docs.google.com/document/d/multi-preserve/edit";
    const existing = await dbHelpers.createEpisode({
      novelId: novel.id,
      episodeNumber: "051-100",
      title: "Legacy Package",
      price: "99.00",
      saleMode: "package",
      fileUrl: legacyFileUrl,
    });

    const csvBody = `Multi Preserve FileUrl ${ts},,51-100,Synced Title,99,false,contents/51-100.txt`;
    const zipBuffer = buildMultiNovelTestZip(csvBody, { "contents/51-100.txt": "เนื้อหาที่ sync เข้ามาใหม่" });
    const parsed = parseMultiNovelPackageZip(zipBuffer);

    const preview = await buildMultiNovelImportPreview(parsed, "upsert");
    expect(preview.rows[0].action).toBe("update_existing");
    expect(preview.rows[0].preserveFileUrl).toBe(true);

    const summary = await importMultiNovelPackageRows(parsed.rows, "upsert");
    expect(summary.updatedCount).toBe(1);
    expect(summary.preservedFileUrlCount).toBe(1);

    const afterImport = await dbHelpers.getEpisodeById(existing.id);
    expect(afterImport?.fileUrl).toBe(legacyFileUrl);
    expect(afterImport?.content).toBe("เนื้อหาที่ sync เข้ามาใหม่");
  });

  it("create_only mode errors instead of silently updating an existing package", async () => {
    const db = await getDb();
    if (!db) return;

    const ts = Date.now();
    const novel: any = await dbHelpers.createNovel({ title: `Multi CreateOnly ${ts}`, author: "Test", description: "Test" });
    const existing = await dbHelpers.createEpisode({
      novelId: novel.id,
      episodeNumber: "1-50",
      title: "Original Title",
      price: "40.00",
      saleMode: "package",
      fileUrl: "https://docs.google.com/document/d/multi-create-only/edit",
    });

    const csvBody = `Multi CreateOnly ${ts},,1-50,Attempted Overwrite,45,false,contents/1-50.txt`;
    const zipBuffer = buildMultiNovelTestZip(csvBody, { "contents/1-50.txt": "เนื้อหาที่พยายาม overwrite" });
    const parsed = parseMultiNovelPackageZip(zipBuffer);

    const preview = await buildMultiNovelImportPreview(parsed, "create_only");
    expect(preview.rows[0].action).toBe("error_existing_conflict");

    const summary = await importMultiNovelPackageRows(parsed.rows, "create_only");
    expect(summary.updatedCount).toBe(0);
    expect(summary.createdCount).toBe(0);
    expect(summary.errorCount).toBe(1);

    const afterImport = await dbHelpers.getEpisodeById(existing.id);
    expect(afterImport?.title).toBe("Original Title");
  });
});
