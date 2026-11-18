import { beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { getTestDb, requireTestDb } from "../test-helpers/testDb";
import { uniqueTestTag } from "../test-helpers/fixtures";
import { episodes as episodesTable, novels as novelsTable } from "../../drizzle/schema";
import {
  previewPackageSplit,
  SALE_MODE_RANGE_SQL_PATTERN,
  scanLegacyPackagesPage,
  type ScanRow,
} from "./packageChapterSplit.service";
import { splitPackageContent } from "./packageChapterSplit.domain";

/**
 * IPE-R4R3 regression: the bounded episode inventory (packageChapterSplit
 * service) must keep conflict detection COMPLETE without loading the whole
 * novel - duplicates and conflicts found far beyond the first rows, all
 * overlapping packages detected, pagination intact, and consistent results
 * under concurrency. Runs on the disposable ipenovel_test database so the
 * real MySQL 8 REGEXP predicates are what get exercised.
 */

let testDb: ReturnType<typeof getTestDb>;

beforeAll(async () => {
  await requireTestDb();
  testDb = getTestDb();
});

function packContent(numbers: number[]): string {
  return numbers.map((n) => `บทที่ ${n} ชื่อบท ${n}\n\nเนื้อเรียงบทที่ ${n} บรรทัดหนึ่ง\nบรรทัดสอง ${n}\n\n`).join("");
}

/** The EXACT stored text of a chapter as the splitter will slice it. */
function storedSlice(content: string, episodeNumber: string, chapterNumber: number): string {
  const plan = splitPackageContent({ episodeNumber, content });
  const chapter = plan.chapters.find((c) => c.chapterNumber === chapterNumber);
  if (!chapter) throw new Error(`chapter ${chapterNumber} not found in plan`);
  return content.slice(chapter.sourceStart, chapter.sourceEnd);
}

async function createNovel(): Promise<number> {
  const tag = uniqueTestTag("r4r3");
  const result = await testDb.insert(novelsTable).values({
    title: `R4R3 Novel ${tag}`,
    slug: `r4r3-novel-${tag}`,
    author: "Bounded Inventory Test",
    publicationStatus: "published",
    storyStatus: "ongoing",
  });
  return (result as unknown as [{ insertId: number }])[0].insertId;
}

interface EpisodeSeed {
  novelId: number;
  episodeNumber: string;
  content: string | null;
  saleMode: "package" | "chapter" | null;
  price?: string;
  fileUrl?: string | null;
}

async function createEpisode(values: EpisodeSeed): Promise<number> {
  const result = await testDb.insert(episodesTable).values({
    novelId: values.novelId,
    episodeNumber: values.episodeNumber,
    title: `EP ${values.episodeNumber}`,
    price: values.price ?? "30.00",
    isFree: false,
    isPublished: true,
    saleMode: values.saleMode,
    content: values.content,
    contentFormat: "plain_text",
    fileUrl: values.fileUrl ?? null,
  });
  return (result as unknown as [{ insertId: number }])[0].insertId;
}

/** Rows on a REAL MySQL REGEXP in one round trip (batched insert). */
async function createChapters(values: EpisodeSeed[]): Promise<void> {
  if (values.length === 0) return;
  await testDb.insert(episodesTable).values(
    values.map((v) => ({
      novelId: v.novelId,
      episodeNumber: v.episodeNumber,
      title: `EP ${v.episodeNumber}`,
      price: v.price ?? "30.00",
      isFree: false,
      isPublished: true,
      saleMode: v.saleMode,
      content: v.content,
      contentFormat: "plain_text",
      fileUrl: v.fileUrl ?? null,
    }))
  );
}

/**
 * IPE-R4R3R4: OVERLAPPING_PACKAGE messages embed the RAW episodeNumber.
 * Legacy-style rows legitimately store NBSP (U+00A0) / narrow NBSP (U+202F)
 * / BOM (U+FEFF) inside the range text, so substring matching against
 * "4 - 8" fails byte-for-byte even though the row IS the expected overlap.
 * Normalize unicode whitespace runs (JS \s covers all three) to single
 * ASCII spaces BEFORE matching - assertion-side only, production logic is
 * untouched.
 */
function normalizeRangeText(text: string): string {
  return text.replace(/\s+/g, " ");
}

async function drainScan(input: Parameters<typeof scanLegacyPackagesPage>[0]): Promise<ScanRow[]> {
  const rows: ScanRow[] = [];
  let cursor: number | undefined;
  let pages = 0;
  do {
    const page = await scanLegacyPackagesPage({ ...input, cursor });
    expect(page.rows.length, `page ${pages} must respect its limit`).toBeLessThanOrEqual(input.limit ?? 20);
    rows.push(...page.rows);
    cursor = page.nextCursor ?? undefined;
    pages += 1;
    expect(pages).toBeLessThan(200); // guard against an infinite loop in the test itself
  } while (cursor !== undefined);
  return rows;
}

describe("bounded episode inventory (IPE-R4R3)", () => {
  it("detects far conflicts, far ambiguity, far overlap and far exact-keep on a 1,400-episode novel", async () => {
    const novelId = await createNovel();
    const numbers = Array.from({ length: 1000 }, (_, i) => i + 1);
    const content = packContent(numbers);
    const packageId = await createEpisode({ novelId, episodeNumber: "1 - 1000", content, saleMode: "package" });

    // 897 REAL exact-slice chapter rows (2..898, requested price) written
    // FIRST: exact keeps at scale, far from the first rows.
    const plan = splitPackageContent({ episodeNumber: "1 - 1000", content });
    const sliceByNumber = new Map(plan.chapters.map((c) => [c.chapterNumber, content.slice(c.sourceStart, c.sourceEnd)]));
    await createChapters(
      Array.from({ length: 897 }, (_, i) => ({
        novelId,
        episodeNumber: String(2 + i),
        content: sliceByNumber.get(2 + i)!,
        saleMode: "chapter" as const,
        price: "5",
      }))
    );
    // 500 filler chapter rows OUTSIDE the plan keys (1001..1500) so the
    // novel holds 1,400+ real rows before the target rows below are written
    // - any positional window/LIMIT would end long before them.
    await createChapters(
      Array.from({ length: 500 }, (_, i) => ({
        novelId,
        episodeNumber: String(1001 + i),
        content: `เนื้อหาตอนอนาคต ${1001 + i}`,
        saleMode: "chapter" as const,
      }))
    );
    // Fixture evidence: the novel really holds >= 1,300 episode rows.
    const [{ rowCount }] = await testDb
      .select({ rowCount: sql<number>`count(*)` })
      .from(episodesTable)
      .where(eq(episodesTable.novelId, novelId));
    expect(Number(rowCount)).toBeGreaterThanOrEqual(1300);

    // Conflicting chapters at the far end (wrong content).
    await createChapters(
      [900, 999].map((n) => ({ novelId, episodeNumber: String(n), content: `เนื้อหาต่างจากแผน ${n}`, saleMode: "chapter" as const }))
    );
    // An exact duplicate stored far away must be KEPT (byte-identical slice
    // AND the requested price - a price mismatch is its own conflict).
    await createEpisode({ novelId, episodeNumber: "995", content: sliceByNumber.get(995)!, saleMode: "chapter", price: "5" });
    // Duplicate chapter number via zero-padding: "950" already conflicts above, "0950" makes it ambiguous.
    await createChapters([
      { novelId, episodeNumber: "950", content: "เนื้อหาต่างจากแผน 950", saleMode: "chapter" },
      { novelId, episodeNumber: "0950", content: "เนื้อหาอีกแถว 950", saleMode: "chapter" },
    ]);
    // Overlapping packages stored at the very END (highest ids).
    await createEpisode({ novelId, episodeNumber: "900 - 905", content: "แพ็กทับซ้อนท้ายลิสต์", saleMode: "package" });
    // BOM-wrapped overlap (IPE-R4R3R3): JS \s matches U+FEFF, so
    // resolveSaleMode()/parseSplitRange() treat this as "906 - 908"; the
    // SQL legacy predicate must not be narrower than JS. saleMode is
    // explicitly "package" because episodes.saleMode is NOT NULL enum -
    // the NULL arm is defensive only.
    await createEpisode({ novelId, episodeNumber: "\uFEFF906 - 908\uFEFF", content: "แพ็กเก่าทับซ้อน BOM", saleMode: "package" });
    // NBSP-wrapped overlap, no fileUrl (same detection path).
    await createEpisode({ novelId, episodeNumber: "\u00A0700 - 702\u00A0", content: "แพ็ก NBSP ทับซ้อน", saleMode: "package" });

    const preview = await previewPackageSplit({ packageEpisodeId: packageId, pricing: { chapterPrice: "5" } });
    expect(preview.applicable).toBe(false);

    const codes = preview.issues.map((i) => i.code);
    expect(codes).toContain("AMBIGUOUS_EXISTING_CHAPTER");
    expect(preview.issues.find((i) => i.code === "AMBIGUOUS_EXISTING_CHAPTER")?.chapterNumber).toBe(950);
    expect(codes).toContain("OVERLAPPING_PACKAGE");
    // All three overlaps are found, including the BOM- and NBSP-wrapped rows.
    const overlapMessages = preview.issues
      .filter((i) => i.code === "OVERLAPPING_PACKAGE")
      .map((i) => normalizeRangeText(i.message));
    expect(overlapMessages.some((m) => m.includes("900 - 905"))).toBe(true);
    expect(overlapMessages.some((m) => m.includes("906 - 908"))).toBe(true);
    expect(overlapMessages.some((m) => m.includes("700 - 702"))).toBe(true);

    // Ambiguous chapter 950 is excluded from the rows entirely (never guessed).
    expect(preview.rows.find((r) => r.chapterNumber === 950)).toBeUndefined();
    const conflictRows = preview.rows.filter((r) => r.action === "conflict").map((r) => r.chapterNumber);
    expect(conflictRows.sort((a, b) => a - b)).toEqual([900, 999]);
    // Exact slices far from the start are kept, at both ends of the range.
    expect(preview.rows.find((r) => r.chapterNumber === 2)?.action).toBe("keep");
    expect(preview.rows.find((r) => r.chapterNumber === 500)?.action).toBe("keep");
    expect(preview.rows.find((r) => r.chapterNumber === 898)?.action).toBe("keep");
    expect(preview.rows.find((r) => r.chapterNumber === 995)?.action).toBe("keep");
    // 1000 plan chapters - 1 ambiguous - 2 conflicts - 898 exact keeps.
    expect(preview.counts).toEqual({ create: 99, keep: 898, conflict: 2 });

    // The global scan sees all four packages of this novel.
    const scan = await scanLegacyPackagesPage({ novelId, limit: 5 });
    expect(scan.rows.map((r) => r.packageEpisodeId)).toContain(packageId);
    expect(scan.rows.length).toBe(4);
  });

  it("BOM- and NBSP-wrapped legacy-style ranges (fileUrl NULL) are detected as OVERLAPPING_PACKAGE", async () => {
    const novelId = await createNovel();
    const packageId = await createEpisode({
      novelId,
      episodeNumber: "1 - 5",
      content: packContent([1, 2, 3, 4, 5]),
      saleMode: "package",
    });
    // BOM lead + trail, NBSP around the "-", narrow NBSP lead: every form
    // resolveSaleMode()'s JS regex accepts must reach overlap detection.
    await createEpisode({ novelId, episodeNumber: "\uFEFF3 - 7\uFEFF", content: "ทับ BOM", saleMode: "package" });
    await createEpisode({ novelId, episodeNumber: "\u00A04\u00A0-\u00A08", content: "ทับ NBSP", saleMode: "package" });
    await createEpisode({ novelId, episodeNumber: "\u202F2\u202F-\u202F9", content: "ทับ narrow NBSP", saleMode: "package" });

    const preview = await previewPackageSplit({ packageEpisodeId: packageId, pricing: { chapterPrice: "5" } });
    // IPE-R4R3R4: the messages embed the RAW stored episodeNumber
    // ("4\u00A0-\u00A08" / "\u202F2\u202F-\u202F9"), so byte-for-byte
    // substring checks against "4 - 8"/"2 - 9" were asserting a text that
    // never exists. Normalize unicode whitespace first, then match.
    const overlapMessages = preview.issues
      .filter((i) => i.code === "OVERLAPPING_PACKAGE")
      .map((i) => normalizeRangeText(i.message));
    expect(overlapMessages.some((m) => m.includes("3 - 7"))).toBe(true);
    expect(overlapMessages.some((m) => m.includes("4 - 8"))).toBe(true);
    expect(overlapMessages.some((m) => m.includes("2 - 9"))).toBe(true);
    // The scan path sees them too.
    const scan = await scanLegacyPackagesPage({ novelId, limit: 10 });
    expect(scan.rows.filter((r) => r.packageEpisodeId !== packageId).length).toBe(3);
  });

  it("SALE_MODE_RANGE_SQL_PATTERN is exercised by MySQL REGEXP_LIKE directly (IPE-R4R3R4)", async () => {
    // Positive forms are the EXACT stored strings this file writes: plain
    // spaces, NBSP around/beside the dash, narrow NBSP, BOM lead/trail and
    // decimal endpoints. Negatives pin the boundary: single numbers, words,
    // open-ended ranges, triple ranges, empty string and non-numeric lead.
    const samples: Array<{ candidate: string; expected: boolean; label: string }> = [
      { candidate: "1 - 1000", expected: true, label: "plain spaces" },
      { candidate: "  12  -  34  ", expected: true, label: "plain spaces with padding" },
      { candidate: "\u00A04\u00A0-\u00A08", expected: true, label: "NBSP around the dash" },
      { candidate: "\u00A0700 - 702\u00A0", expected: true, label: "NBSP lead/trail" },
      { candidate: "\u202F2\u202F-\u202F9", expected: true, label: "narrow NBSP" },
      { candidate: "\uFEFF906 - 908\uFEFF", expected: true, label: "BOM lead/trail" },
      { candidate: "1.5 - 2.5", expected: true, label: "decimal endpoints" },
      { candidate: "950", expected: false, label: "single number" },
      { candidate: "chapter", expected: false, label: "word" },
      { candidate: "1 - ", expected: false, label: "open-ended range" },
      { candidate: "- 5", expected: false, label: "missing left endpoint" },
      { candidate: "1 - 2 - 3", expected: false, label: "triple range" },
      { candidate: "", expected: false, label: "empty string" },
      { candidate: "ตอนที่ 1 - 5", expected: false, label: "non-numeric lead" },
    ];
    for (const { candidate, expected, label } of samples) {
      const rows: any = await testDb.execute(
        sql`SELECT REGEXP_LIKE(${candidate}, ${SALE_MODE_RANGE_SQL_PATTERN}) AS matched`
      );
      const unwrapped = Array.isArray(rows?.[0]) ? rows[0] : rows;
      const matched = Number(unwrapped?.[0]?.matched ?? 0);
      expect(
        matched,
        `REGEXP_LIKE('${candidate}', SALE_MODE_RANGE_SQL_PATTERN) [${label}]`
      ).toBe(expected ? 1 : 0);
    }
  });

  it("reports AMBIGUOUS_EXISTING_CHAPTER for '7' + '07' even when the duplicates precede the package", async () => {
    const novelId = await createNovel();
    // Duplicates inserted BEFORE the package row (lowest ids in the novel).
    await createChapters([
      { novelId, episodeNumber: "7", content: "เวอร์ชันเดิม 7", saleMode: "chapter" },
      { novelId, episodeNumber: "07", content: "อีกแถวของ 7", saleMode: "chapter" },
    ]);
    const packageId = await createEpisode({ novelId, episodeNumber: "1 - 10", content: packContent([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), saleMode: "package" });

    const preview = await previewPackageSplit({ packageEpisodeId: packageId, pricing: { chapterPrice: "5" } });
    const ambiguous = preview.issues.filter((i) => i.code === "AMBIGUOUS_EXISTING_CHAPTER");
    expect(ambiguous.length).toBe(1);
    expect(ambiguous[0].chapterNumber).toBe(7);
    expect(preview.rows.find((r) => r.chapterNumber === 7)).toBeUndefined();
    // The remaining 9 chapters are all creates; the duplicate must not be
    // silently resolved to either row.
    expect(preview.counts).toEqual({ create: 9, keep: 0, conflict: 0 });
  });

  it("scan pages walk every package exactly once - no skips, no duplicates", async () => {
    const novelId = await createNovel();
    const expectedIds: number[] = [];
    for (let a = 1; a <= 59; a += 2) {
      const range = `${a} - ${a + 1}`;
      expectedIds.push(await createEpisode({ novelId, episodeNumber: range, content: packContent([a, a + 1]), saleMode: "package" }));
    }
    // Chapter noise that must never appear in a package scan, and whose
    // numbers match none of the packages' plan keys (500..502 vs 1..60).
    await createChapters(
      [500, 501, 502].map((n) => ({ novelId, episodeNumber: String(n), content: `ตอนอนาคต ${n}`, saleMode: "chapter" as const }))
    );

    const rows = await drainScan({ novelId, limit: 7 });
    const ids = rows.map((r) => r.packageEpisodeId);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates across pages
    expect(ids.sort((a, b) => a - b)).toEqual(expectedIds.slice().sort((a, b) => a - b));
    // Ascending id order within each page (keyset pagination).
    expect(rows.every((r, i) => i === 0 || rows[i - 1].packageEpisodeId < r.packageEpisodeId)).toBe(true);
  });

  it("status filters and attentionOnly hide rows without losing the cursor position", async () => {
    const novelId = await createNovel();
    const packageIds: number[] = [];
    for (let a = 1; a <= 11; a += 2) {
      packageIds.push(await createEpisode({ novelId, episodeNumber: `${a} - ${a + 1}`, content: packContent([a, a + 1]), saleMode: "package" }));
    }
    // Make exactly one package a far-id conflict: chapter 11 differs.
    const conflictPackageId = packageIds[5];
    await createChapters([{ novelId, episodeNumber: "11", content: "เนื้อหาต่างจากแผน 11", saleMode: "chapter" }]);

    const conflicts = await drainScan({ novelId, limit: 2, status: "conflict" });
    expect(conflicts.map((r) => r.packageEpisodeId)).toEqual([conflictPackageId]);
    expect(conflicts[0].conflictCount).toBe(1);

    const attention = await drainScan({ novelId, limit: 3, attentionOnly: true });
    expect(attention.map((r) => r.packageEpisodeId)).toEqual([conflictPackageId]);

    const splittable = await drainScan({ novelId, limit: 4, status: "splittable" });
    expect(splittable.map((r) => r.packageEpisodeId).sort((a, b) => a - b)).toEqual(packageIds.filter((id) => id !== conflictPackageId).sort((a, b) => a - b));
  });

  it("scan and preview agree, and concurrent previews of the same novel are identical", async () => {
    const novelId = await createNovel();
    const content = packContent(Array.from({ length: 50 }, (_, i) => i + 1));
    const packageId = await createEpisode({ novelId, episodeNumber: "1 - 50", content, saleMode: "package" });
    // One exact keep and one conflict, both beyond the first rows (written after filler).
    await createChapters(
      Array.from({ length: 40 }, (_, i) => ({ novelId, episodeNumber: String(100 + i), content: `ฟิลเลอร์ ${100 + i}`, saleMode: "chapter" as const }))
    );
    await createEpisode({ novelId, episodeNumber: "25", content: storedSlice(content, "1 - 50", 25), saleMode: "chapter", price: "5" });
    await createChapters([{ novelId, episodeNumber: "30", content: "เนื้อหาต่างจากแผน 30", saleMode: "chapter" }]);

    const [p1, p2, scan] = await Promise.all([
      previewPackageSplit({ packageEpisodeId: packageId, pricing: { chapterPrice: "5" } }),
      previewPackageSplit({ packageEpisodeId: packageId, pricing: { chapterPrice: "5" } }),
      scanLegacyPackagesPage({ novelId, limit: 10 }),
    ]);
    expect(p1.planHash).toBe(p2.planHash);
    expect(p1.rows.find((r) => r.chapterNumber === 25)?.action).toBe("keep");
    expect(p1.rows.find((r) => r.chapterNumber === 30)?.action).toBe("conflict");

    const scanRow = scan.rows.find((r) => r.packageEpisodeId === packageId);
    expect(scanRow).toBeDefined();
    expect(scanRow!.conflictCount).toBe(p1.counts.conflict);
    expect(scanRow!.keepCount).toBe(p1.counts.keep);
    expect(scanRow!.createCount).toBe(p1.counts.create);
  });

  it("an empty novel scans to a clean empty page", async () => {
    const novelId = await createNovel();
    const page = await scanLegacyPackagesPage({ novelId, limit: 20 });
    expect(page.rows).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
    expect(page.inspected).toBe(0);
  });
});
