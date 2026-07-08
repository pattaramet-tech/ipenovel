import { describe, it, expect } from "vitest";
import AdmZip from "adm-zip";
import * as dbHelpers from "./db";
import { getDb } from "./db";
import {
  parsePackageZip,
  buildImportPreview,
  importPackageRows,
} from "./services/packageZipImportService";
import { normalizeEpisodeRange } from "./services/readerService";

/**
 * Phase 1 safety-net for the ZIP Import Preview Diff feature. Locks in:
 * - episodeNumber/range normalization used for import matching
 * - the dry-run preview classifying rows identically to what a real import
 *   would do (update_existing / create_new / error_ambiguous_match /
 *   error_duplicate_range / error_missing_content_file)
 * - fileUrl preservation on update (never null'd out)
 * - ambiguous matches blocking the write entirely, for both rows involved
 * - dry run (buildImportPreview) never writing to the database
 */

function buildTestZip(rows: { csvLine: string; contentFiles?: Record<string, string> }) {
  const zip = new AdmZip();
  const csv = `episodeNumber,episodeTitle,price,isFree,contentFile\n${rows.csvLine}`;
  zip.addFile("manifest.csv", Buffer.from(csv, "utf-8"));
  for (const [path, content] of Object.entries(rows.contentFiles || {})) {
    zip.addFile(path, Buffer.from(content, "utf-8"));
  }
  return zip.toBuffer();
}

describe("normalizeEpisodeRange - import identity matching", () => {
  it.each([
    ["51-100", "51 - 100"],
    ["51 - 100", "51 - 100"],
    ["051-100", "51 - 100"],
    ["#051 - 100", "51 - 100"],
    ["บทที่ 51 - 100", "51 - 100"],
  ])("%s normalizes to %s", (input, expected) => {
    expect(normalizeEpisodeRange(input)).toBe(expected);
  });
});

describe("parsePackageZip - duplicate range and missing content file are tagged with codes", () => {
  it("flags an in-batch duplicate range and a missing content file", () => {
    const csvLine = [
      "51-100,Existing Range A,99,false,contents/051-100.txt",
      "051 - 100,Duplicate Of Row Above,50,false,contents/dup.txt",
      "200-250,Brand New Package,80,false,contents/200-250.txt",
      "300-350,References Missing File,60,false,contents/missing.txt",
    ].join("\n");

    const zipBuffer = buildTestZip({
      csvLine,
      contentFiles: {
        "contents/051-100.txt": "เนื้อหาตอน 51-100",
        "contents/200-250.txt": "เนื้อหาตอน 200-250",
      },
    });

    const parsed = parsePackageZip(zipBuffer);

    expect(parsed.rows.map((r) => r.episodeNumber)).toEqual(["51-100", "200-250"]);
    expect(parsed.errors).toHaveLength(2);

    const duplicateError = parsed.errors.find((e) => e.episodeNumberRaw === "051 - 100");
    expect(duplicateError?.code).toBe("DUPLICATE_IN_BATCH");

    const missingFileError = parsed.errors.find((e) => e.episodeNumberRaw === "300-350");
    expect(missingFileError?.code).toBe("MISSING_CONTENT_FILE");
  });
});

describe("buildImportPreview - classification with no existing episodes (runs without a DB)", () => {
  it("classifies every valid row as create_new when nothing matches, and maps parse errors to the right actions", async () => {
    const csvLine = [
      "51-100,Existing Range A,99,false,contents/051-100.txt",
      "051 - 100,Duplicate Of Row Above,50,false,contents/dup.txt",
      "300-350,References Missing File,60,false,contents/missing.txt",
    ].join("\n");

    const zipBuffer = buildTestZip({
      csvLine,
      contentFiles: { "contents/051-100.txt": "เนื้อหาตอน 51-100" },
    });

    const parsed = parsePackageZip(zipBuffer);
    // novelId 0 with no live DB (or a novel with no episodes) - either way,
    // getEpisodesByNovelId returns [] so nothing can match.
    const preview = await buildImportPreview(0, parsed, "upsert");

    const createRow = preview.rows.find((r) => r.rawEpisodeNumber === "51-100");
    expect(createRow?.action).toBe("create_new");
    expect(createRow?.matchedEpisodeId).toBeNull();
    expect(createRow?.normalizedRange).toBe("51 - 100");

    const duplicateRow = preview.rows.find((r) => r.rawEpisodeNumber === "051 - 100");
    expect(duplicateRow?.action).toBe("error_duplicate_range");

    const missingFileRow = preview.rows.find((r) => r.rawEpisodeNumber === "300-350");
    expect(missingFileRow?.action).toBe("error_missing_content_file");

    expect(preview.summary.totalRows).toBe(3);
    expect(preview.summary.createCount).toBe(1);
    expect(preview.summary.duplicateRangeCount).toBe(1);
    expect(preview.summary.missingContentFileCount).toBe(1);
    expect(preview.summary.errorCount).toBe(2);
  });

  it("flags an unparseable episodeNumber as error_invalid_range", async () => {
    const csvLine = "abc-no-digits,Weird Row,50,false,contents/weird.txt";
    const zipBuffer = buildTestZip({
      csvLine,
      contentFiles: { "contents/weird.txt": "เนื้อหา" },
    });

    const parsed = parsePackageZip(zipBuffer);
    expect(parsed.rows).toHaveLength(1); // parse-time validation only checks non-blank, not numeric

    const preview = await buildImportPreview(0, parsed, "upsert");
    expect(preview.rows[0].action).toBe("error_invalid_range");
  });
});

describe("ZIP import - end-to-end DB integration (requires a live DATABASE_URL)", () => {
  it("upsert preserves fileUrl and episodeId when normalized ranges match across formats", async () => {
    const db = await getDb();
    if (!db) return;

    const ts = Date.now();
    const novel: any = await dbHelpers.createNovel({
      title: `ZIP Preview Test Novel ${ts}`,
      author: "Test Author",
      description: "Test",
    });
    const novelId = novel.id;

    const legacyFileUrl = "https://docs.google.com/document/d/zip-preview-test/edit";
    const existing = await dbHelpers.createEpisode({
      novelId,
      episodeNumber: "051-100", // differently formatted from the incoming "51-100"
      title: "Legacy Package",
      price: "99.00",
      saleMode: "package",
      fileUrl: legacyFileUrl,
    });

    const csvLine = "51-100,Synced Plaintext Title,99,false,contents/051-100.txt";
    const zipBuffer = buildTestZip({
      csvLine,
      contentFiles: { "contents/051-100.txt": "เนื้อหาที่ sync เข้ามาใหม่" },
    });
    const parsed = parsePackageZip(zipBuffer);

    // Dry run first - must not write anything.
    const preview = await buildImportPreview(novelId, parsed, "upsert");
    expect(preview.rows[0].action).toBe("update_existing");
    expect(preview.rows[0].matchedEpisodeId).toBe(existing.id);
    expect(preview.rows[0].currentFileUrlExists).toBe(true);
    expect(preview.rows[0].preserveFileUrl).toBe(true);
    expect(preview.summary.preservedFileUrlCount).toBe(1);

    const afterPreview = await dbHelpers.getEpisodeById(existing.id);
    expect(afterPreview?.fileUrl).toBe(legacyFileUrl);
    expect(afterPreview?.content).toBeFalsy();
    const episodesAfterPreview = await dbHelpers.getEpisodesByNovelId(novelId);
    expect(episodesAfterPreview).toHaveLength(1); // dry run created nothing

    // Now the real import.
    const summary = await importPackageRows(novelId, parsed.rows, "upsert");
    expect(summary.updatedCount).toBe(1);
    expect(summary.createdCount).toBe(0);
    expect(summary.preservedFileUrlCount).toBe(1);

    const afterImport = await dbHelpers.getEpisodeById(existing.id);
    expect(afterImport?.id).toBe(existing.id); // episodeId preserved
    expect(afterImport?.fileUrl).toBe(legacyFileUrl); // fileUrl preserved, never null'd
    expect(afterImport?.content).toBe("เนื้อหาที่ sync เข้ามาใหม่");

    const episodesAfterImport = await dbHelpers.getEpisodesByNovelId(novelId);
    expect(episodesAfterImport).toHaveLength(1); // updated in place, no duplicate created
  });

  it("blocks import and preserves both episodes when a normalized range matches more than one existing episode", async () => {
    const db = await getDb();
    if (!db) return;

    const ts = Date.now();
    const novel: any = await dbHelpers.createNovel({
      title: `ZIP Ambiguous Test Novel ${ts}`,
      author: "Test Author",
      description: "Test",
    });
    const novelId = novel.id;

    // Two pre-existing episodes that both normalize to "200 - 250" - a data
    // quality issue that must block the import rather than guess.
    const dupA = await dbHelpers.createEpisode({
      novelId,
      episodeNumber: "200-250",
      title: "Ambiguous A",
      price: "50.00",
      saleMode: "package",
      fileUrl: "https://docs.google.com/document/d/ambiguous-a/edit",
    });
    const dupB = await dbHelpers.createEpisode({
      novelId,
      episodeNumber: "0200 - 250",
      title: "Ambiguous B",
      price: "60.00",
      saleMode: "package",
      fileUrl: "https://docs.google.com/document/d/ambiguous-b/edit",
    });

    const csvLine = "200-250,Incoming Sync Row,70,false,contents/200-250.txt";
    const zipBuffer = buildTestZip({
      csvLine,
      contentFiles: { "contents/200-250.txt": "เนื้อหาที่พยายาม sync" },
    });
    const parsed = parsePackageZip(zipBuffer);

    const preview = await buildImportPreview(novelId, parsed, "upsert");
    expect(preview.rows[0].action).toBe("error_ambiguous_match");
    expect(preview.summary.ambiguousMatchCount).toBe(1);
    expect(preview.summary.updateCount).toBe(0);
    expect(preview.summary.createCount).toBe(0);

    const summary = await importPackageRows(novelId, parsed.rows, "upsert");
    expect(summary.updatedCount).toBe(0);
    expect(summary.createdCount).toBe(0);
    expect(summary.errorCount).toBe(1);

    // Neither existing episode was touched.
    const afterA = await dbHelpers.getEpisodeById(dupA.id);
    const afterB = await dbHelpers.getEpisodeById(dupB.id);
    expect(afterA?.title).toBe("Ambiguous A");
    expect(afterA?.fileUrl).toBe("https://docs.google.com/document/d/ambiguous-a/edit");
    expect(afterB?.title).toBe("Ambiguous B");
    expect(afterB?.fileUrl).toBe("https://docs.google.com/document/d/ambiguous-b/edit");

    // No third episode was created either.
    const allEpisodes = await dbHelpers.getEpisodesByNovelId(novelId);
    expect(allEpisodes).toHaveLength(2);
  });

  it("create_only mode refuses to update an existing match instead of silently upserting", async () => {
    const db = await getDb();
    if (!db) return;

    const ts = Date.now();
    const novel: any = await dbHelpers.createNovel({
      title: `ZIP CreateOnly Test Novel ${ts}`,
      author: "Test Author",
      description: "Test",
    });
    const novelId = novel.id;

    const existing = await dbHelpers.createEpisode({
      novelId,
      episodeNumber: "1-50",
      title: "Original Title",
      price: "40.00",
      saleMode: "package",
      fileUrl: "https://docs.google.com/document/d/create-only-test/edit",
    });

    const csvLine = "1-50,Attempted Overwrite,45,false,contents/1-50.txt";
    const zipBuffer = buildTestZip({
      csvLine,
      contentFiles: { "contents/1-50.txt": "เนื้อหาที่พยายาม overwrite" },
    });
    const parsed = parsePackageZip(zipBuffer);

    const preview = await buildImportPreview(novelId, parsed, "create_only");
    expect(preview.rows[0].action).toBe("error_existing_conflict");

    const summary = await importPackageRows(novelId, parsed.rows, "create_only");
    expect(summary.updatedCount).toBe(0);
    expect(summary.createdCount).toBe(0);
    expect(summary.errorCount).toBe(1);

    const afterImport = await dbHelpers.getEpisodeById(existing.id);
    expect(afterImport?.title).toBe("Original Title");
    expect(afterImport?.fileUrl).toBe("https://docs.google.com/document/d/create-only-test/edit");
  });
});
