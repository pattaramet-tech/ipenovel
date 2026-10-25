// IPE-059-C — Thai-Novel export tests.
// Source-of-truth behavior is the attached known-good Naruto bulk TXT archive:
// one logical chapter per TXT, filename from the chapter heading, first line
// equals the heading, one blank separator line, and no pack wrapper line.

import { describe, expect, it } from "vitest";
import AdmZip from "adm-zip";
import {
  FIXED_ZIP_TIMESTAMP,
  MAX_EXPORT_FILENAME_COMPONENT_CHARS,
  MAX_EXPORT_ITEMS,
  MAX_EXPORT_PER_ITEM_BYTES,
  NovelExportError,
  NovelExportErrorCode,
  NovelExportItem,
  NovelExportPackage,
  sanitizeExportFilenameComponent,
} from "./novelExport.domain";
import {
  assertNoCrossPackChapterCollisions,
  buildThaiNovelExportEntries,
  buildThaiNovelExportZip,
  buildThaiNovelPreviewRows,
  buildThaiNovelTxt,
  expandThaiNovelLogicalChapters,
  normalizeThaiNovelOptions,
  resolveThaiNovelFilename,
  resolveThaiNovelGeneratedNumber,
  resolveThaiNovelTitle,
} from "./thaiNovelExport.domain";

function makeItem(overrides: Partial<NovelExportItem> = {}): NovelExportItem {
  return {
    episodeId: 1,
    episodeNumber: "1",
    episodeTitle: "การพบกันอีกครั้ง",
    content: "ย่อหน้าแรก\nย่อหน้าที่สอง",
    price: "0.00",
    isFree: true,
    saleMode: "package",
    contentFormat: "plain_text",
    sortOrder: null,
    description: null,
    ...overrides,
  };
}

function makePackage(overrides: Partial<{ novelId: number; novelTitle: string; items: NovelExportItem[] }> = {}): NovelExportPackage {
  return {
    novelId: 1,
    novelTitle: "ตำนานมังกร",
    items: [makeItem()],
    ...overrides,
  };
}

function makePackContent(start: number, end: number, counter = "001"): string {
  const chapters = Array.from({ length: end - start + 1 }, (_, index) => {
    const chapter = start + index;
    return `บทที่ ${chapter} จ้าวกลยุทธ์โปเกมอน\n\nเนื้อหาบท ${chapter} 🐉`;
  });
  return `แพ็กตอน ${start} - ${end} ${counter}\n\n${chapters.join("\n\n")}\n`;
}

function expectExportError(fn: () => void, code: NovelExportErrorCode): void {
  try {
    fn();
  } catch (error) {
    if (error instanceof NovelExportError) {
      expect(error.code).toBe(code);
      return;
    }
    throw error;
  }
  throw new Error(`expected NovelExportError with code ${code}, but nothing was thrown`);
}

describe("TXT contract", () => {
  it("writes heading as first physical line with exactly one blank separator", () => {
    const text = buildThaiNovelTxt("ย่อหน้าแรก\nย่อหน้าที่สอง", "บทที่ 141 จ้าวกลยุทธ์โปเกมอน");
    expect(text).toBe("บทที่ 141 จ้าวกลยุทธ์โปเกมอน\n\nย่อหน้าแรก\nย่อหน้าที่สอง");
    expect(text.split("\n")[1]).toBe("");
  });

  it("keeps Thai + emoji UTF-8 and normalizes CRLF/CR to LF", () => {
    const text = buildThaiNovelTxt("สวัสดี\r\nโลก 🌏\rจบ", "บทที่ 1");
    expect(text).toBe("บทที่ 1\n\nสวัสดี\nโลก 🌏\nจบ");
    expect(Buffer.byteLength(text, "utf8")).toBeGreaterThan(0);
  });
});

describe("Naruto-style pack expansion", () => {
  it("removes the pack wrapper and splits one range Episode into one TXT per embedded chapter", () => {
    const item = makeItem({
      episodeId: 141190,
      episodeNumber: "141 - 143",
      episodeTitle: "แพ็กตอน 141 - 143 001",
      content: makePackContent(141, 143),
    });
    const entries = buildThaiNovelExportEntries(makePackage({ items: [item] }));

    expect(entries).toHaveLength(3);
    expect(entries.map((entry) => entry.sourceEpisodeNumber)).toEqual(["141 - 143", "141 - 143", "141 - 143"]);
    expect(entries.map((entry) => entry.sourceChapterNumber)).toEqual(["141", "142", "143"]);
    expect(entries.map((entry) => entry.filename)).toEqual([
      "บทที่ 141 จ้าวกลยุทธ์โปเกมอน.txt",
      "บทที่ 142 จ้าวกลยุทธ์โปเกมอน.txt",
      "บทที่ 143 จ้าวกลยุทธ์โปเกมอน.txt",
    ]);
    expect(entries[0].text).toBe("บทที่ 141 จ้าวกลยุทธ์โปเกมอน\n\nเนื้อหาบท 141 🐉");
    expect(entries.every((entry) => !entry.text.includes("แพ็กตอน"))).toBe(true);
  });

  it("requires the embedded chapter sequence to match the declared range exactly", () => {
    const item = makeItem({
      episodeNumber: "141 - 143",
      content: [
        "แพ็กตอน 141 - 143 001",
        "",
        "บทที่ 141 จ้าวกลยุทธ์โปเกมอน",
        "",
        "หนึ่ง",
        "",
        "บทที่ 143 จ้าวกลยุทธ์โปเกมอน",
        "",
        "สาม",
      ].join("\n"),
    });
    expectExportError(
      () => buildThaiNovelExportEntries(makePackage({ items: [item] })),
      "EXPORT_INVALID_EPISODE_IDENTITY"
    );
  });

  it("rejects a non-matching/non-pack preamble instead of silently dropping it", () => {
    const item = makeItem({
      episodeNumber: "141 - 142",
      content: "หมายเหตุที่ไม่ควรถูกทิ้ง\n\nบทที่ 141 A\n\nหนึ่ง\n\nบทที่ 142 B\n\nสอง",
    });
    expectExportError(
      () => expandThaiNovelLogicalChapters(makePackage({ items: [item] })),
      "EXPORT_INVALID_EPISODE_IDENTITY"
    );
  });

  it("sanitizes only the filename while preserving punctuation in the first-line title", () => {
    const item = makeItem({
      episodeNumber: "855",
      episodeTitle: "fallback",
      content: "บทที่ 855 นายเป็นตัวอะไรกันแน่?\n\nเนื้อหา",
    });
    const [entry] = buildThaiNovelExportEntries(makePackage({ items: [item] }));
    expect(entry.title).toBe("บทที่ 855 นายเป็นตัวอะไรกันแน่?");
    expect(entry.filename).toBe("บทที่ 855 นายเป็นตัวอะไรกันแน่.txt");
    expect(entry.text.startsWith("บทที่ 855 นายเป็นตัวอะไรกันแน่?\n\n")).toBe(true);
  });

  it("does not duplicate a single Episode heading that is already the first content line", () => {
    const [entry] = buildThaiNovelExportEntries(makePackage({
      items: [makeItem({
        episodeNumber: "7",
        episodeTitle: "stored title",
        content: "บทที่ 7 ชื่อจริง\n\nเนื้อหา",
      })],
    }));
    expect(entry.filename).toBe("บทที่ 7 ชื่อจริง.txt");
    expect(entry.text).toBe("บทที่ 7 ชื่อจริง\n\nเนื้อหา");
    expect(entry.text.match(/บทที่ 7/g)?.length).toBe(1);
  });
});

describe("optional renumber/title compatibility", () => {
  it("preserves source chapter numbers by default", () => {
    const entries = buildThaiNovelExportEntries(makePackage({
      items: [makeItem({ episodeNumber: "141 - 143", content: makePackContent(141, 143) })],
    }));
    expect(entries.map((entry) => entry.generatedNumber)).toEqual(["141", "142", "143"]);
    expect(entries[0].title).toBe("บทที่ 141 จ้าวกลยุทธ์โปเกมอน");
  });

  it("renumbers leading chapter headings only when an explicit start number is supplied", () => {
    const entries = buildThaiNovelExportEntries(
      makePackage({ items: [makeItem({ episodeNumber: "141 - 143", content: makePackContent(141, 143) })] }),
      { startEpisodeNumber: 391 }
    );
    expect(entries.map((entry) => entry.generatedNumber)).toEqual(["391", "392", "393"]);
    expect(entries.map((entry) => entry.filename)).toEqual([
      "บทที่ 391 จ้าวกลยุทธ์โปเกมอน.txt",
      "บทที่ 392 จ้าวกลยุทธ์โปเกมอน.txt",
      "บทที่ 393 จ้าวกลยุทธ์โปเกมอน.txt",
    ]);
  });

  it("keeps prefix and append options opt-in", () => {
    const opts = normalizeThaiNovelOptions({ titlePrefix: "ตอนที่", appendFilenameToTitle: true });
    expect(resolveThaiNovelTitle("การพบกัน", "007", opts)).toBe("ตอนที่ การพบกัน 007");
  });

  it("treats omitted start number as source-preserving and rejects invalid explicit starts", () => {
    expect(normalizeThaiNovelOptions(undefined).startEpisodeNumber).toBeNull();
    expectExportError(() => normalizeThaiNovelOptions({ startEpisodeNumber: 0 }), "EXPORT_INVALID_SALE_METADATA");
    expectExportError(() => normalizeThaiNovelOptions({ startEpisodeNumber: 1.5 }), "EXPORT_INVALID_SALE_METADATA");
  });

  it("still pads generated numeric tokens to 3 digits minimum", () => {
    expect(resolveThaiNovelGeneratedNumber(1, 0)).toBe("001");
    expect(resolveThaiNovelGeneratedNumber(999, 1)).toBe("1000");
  });
});

describe("flat ZIP contract", () => {
  it("uses chapter-heading filenames at the ZIP root with no manifest or contents folder", () => {
    const result = buildThaiNovelExportZip(makePackage({
      items: [makeItem({ episodeNumber: "141 - 142", content: makePackContent(141, 142) })],
    }));
    expect(result.entryFilenames).toEqual([
      "บทที่ 141 จ้าวกลยุทธ์โปเกมอน.txt",
      "บทที่ 142 จ้าวกลยุทธ์โปเกมอน.txt",
    ]);
    expect(result.entryFilenames.every((name) => !name.includes("/"))).toBe(true);
    expect(result.entryFilenames.some((name) => name.toLowerCase().includes("manifest"))).toBe(false);

    const zip = new AdmZip(result.content);
    expect(zip.getEntry("บทที่ 141 จ้าวกลยุทธ์โปเกมอน.txt")!.getData().toString("utf8"))
      .toBe("บทที่ 141 จ้าวกลยุทธ์โปเกมอน\n\nเนื้อหาบท 141 🐉");
  });

  it("is deterministic for identical source + options", () => {
    const pkg = makePackage({
      items: [makeItem({ episodeNumber: "141 - 143", content: makePackContent(141, 143) })],
    });
    const first = buildThaiNovelExportZip(pkg);
    const second = buildThaiNovelExportZip(pkg);
    expect(first.entries).toEqual(second.entries);
    expect(first.content.equals(second.content)).toBe(true);

    const zip = new AdmZip(first.content);
    expect(zip.getEntries()[0].header.time.getTime()).toBe(FIXED_ZIP_TIMESTAMP.getTime());
  });

  it("preview rows come from the exact same expanded entries without body text", () => {
    const entries = buildThaiNovelExportEntries(makePackage({
      items: [makeItem({ episodeNumber: "141 - 142", content: makePackContent(141, 142) })],
    }));
    const rows = buildThaiNovelPreviewRows(entries);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      episodeId: 1,
      sourceEpisodeNumber: "141 - 142",
      sourceChapterNumber: "141",
      generatedNumber: "141",
      filename: "บทที่ 141 จ้าวกลยุทธ์โปเกมอน.txt",
      title: "บทที่ 141 จ้าวกลยุทธ์โปเกมอน",
    });
    expect(JSON.stringify(rows)).not.toContain("เนื้อหาบท");
  });

  it("derives a sanitized readable ZIP filename from the novel title", () => {
    expect(buildThaiNovelExportZip(makePackage({ novelTitle: "ตำนานมังกร: ภาค 1?" })).filename)
      .toBe("ตำนานมังกร ภาค 1-thainovel.zip");
  });
});

describe("limits", () => {
  it("rejects more than the shared source-item limit", () => {
    const items = Array.from({ length: MAX_EXPORT_ITEMS + 1 }, (_, index) =>
      makeItem({ episodeId: index + 1, episodeNumber: String(index + 1) })
    );
    expectExportError(() => buildThaiNovelExportEntries(makePackage({ items })), "EXPORT_LIMIT_ITEMS");
  });

  it("rejects more than the shared limit after pack expansion", () => {
    const content = makePackContent(1, MAX_EXPORT_ITEMS + 1);
    expectExportError(
      () => buildThaiNovelExportEntries(makePackage({
        items: [makeItem({ episodeNumber: `1 - ${MAX_EXPORT_ITEMS + 1}`, content })],
      })),
      "EXPORT_LIMIT_ITEMS"
    );
  });

  it("rejects oversized TXT entries", () => {
    const big = "x".repeat(MAX_EXPORT_PER_ITEM_BYTES + 1);
    expectExportError(
      () => buildThaiNovelExportEntries(makePackage({ items: [makeItem({ content: big })] })),
      "EXPORT_LIMIT_ENTRY_BYTES"
    );
  });

  it("rejects empty packages and non-numeric identities", () => {
    expectExportError(() => buildThaiNovelExportEntries(makePackage({ items: [] })), "EXPORT_EMPTY_SELECTION");
    expectExportError(
      () => buildThaiNovelExportEntries(makePackage({ items: [makeItem({ episodeNumber: "ไม่มีเลข" })] })),
      "EXPORT_INVALID_EPISODE_IDENTITY"
    );
  });

  it("never emits unsafe path separators from the heading-derived filename", () => {
    expect(resolveThaiNovelFilename('บทที่ 1 ชื่อ: ทดสอบ?')).toBe("บทที่ 1 ชื่อ ทดสอบ.txt");
  });
});

describe("IPE-064R3 range-pack over-run", () => {
  const makeOverRunContent = (declaredEnd: number, actualEnd: number, start = 141) => {
    const chapters = Array.from({ length: actualEnd - start + 1 }, (_, index) => {
      const chapter = start + index;
      return `บทที่ ${chapter} จ้าวกลยุทธ์โปเกมอน\n\nเนื้อหาบท ${chapter} 🐉`;
    });
    return `แพ็กตอน ${start} - ${declaredEnd} 001\n\n${chapters.join("\n\n")}\n`;
  };

  it("includes sequential extra chapters beyond the declared range (พบ 52 คาด 50)", () => {
    // Pack declares 141-190 but the content genuinely contains 141-192.
    const item = makeItem({ episodeNumber: "141 - 190", content: makeOverRunContent(190, 192) });
    const rows = buildThaiNovelPreviewRows(buildThaiNovelExportEntries(makePackage({ items: [item] })));
    expect(rows).toHaveLength(52);
    expect(rows.at(-1)).toMatchObject({ sourceChapterNumber: "192" });
  });

  it("still rejects fewer headings than the declared range", () => {
    const item = makeItem({ episodeNumber: "141 - 190", content: makeOverRunContent(190, 189) });
    expectExportError(
      () => buildThaiNovelExportEntries(makePackage({ items: [item] })),
      "EXPORT_INVALID_EPISODE_IDENTITY"
    );
  });

  it("still rejects a duplicate/out-of-order heading in the extra chapters", () => {
    const chapters = [
      ...Array.from({ length: 50 }, (_, index) => `บทที่ ${141 + index} จ้าวกลยุทธ์โปเกมอน\n\nเนื้อหาบท ${141 + index} 🐉`),
      "บทที่ 190 ซ้ำ\n\nเนื้อหาซ้ำ",
    ];
    const item = makeItem({
      episodeNumber: "141 - 190",
      content: `แพ็กตอน 141 - 190 001\n\n${chapters.join("\n\n")}\n`,
    });
    expectExportError(
      () => buildThaiNovelExportEntries(makePackage({ items: [item] })),
      "EXPORT_INVALID_EPISODE_IDENTITY"
    );
  });
});

describe("IPE-064R4B cross-pack duplicate guard", () => {
  it("rejects an overrun that overlaps the next pack instead of double-expanding", () => {
    const overrun = makeItem({
      episodeId: 1,
      episodeNumber: "141 - 190",
      content: makePackContent(141, 192),
    });
    const normal = makeItem({
      episodeId: 2,
      episodeNumber: "191 - 240",
      content: makePackContent(191, 240),
    });
    expectExportError(
      () => buildThaiNovelExportEntries(makePackage({ items: [overrun, normal] })),
      "EXPORT_INVALID_EPISODE_IDENTITY"
    );
  });

  it("still accepts non-overlapping sequential packs", () => {
    const first = makeItem({
      episodeId: 1,
      episodeNumber: "141 - 190",
      content: makePackContent(141, 190),
    });
    const second = makeItem({
      episodeId: 2,
      episodeNumber: "191 - 240",
      content: makePackContent(191, 240),
    });
    const rows = buildThaiNovelPreviewRows(
      buildThaiNovelExportEntries(makePackage({ items: [first, second] }))
    );
    expect(rows).toHaveLength(100);
  });
});

describe("IPE-064R4B numeric chapter collision identity", () => {
  it("treats zero-padded and unpadded headings of the same chapter as one chapter", () => {
    const rangePack = makeItem({
      episodeId: 1,
      episodeNumber: "1",
      content: `แพ็กตอน 1 - 1 001\n\nบทที่ 001 จ้าวกลยุทธ์โปเกมอน\n\nเนื้อหา 001`,
    });
    const single = makeItem({
      episodeId: 2,
      episodeNumber: "1",
      content: `บทที่ 1 จ้าวกลยุทธ์โปเกมอน\n\nเนื้อหา 1`,
    });
    expectExportError(
      () => buildThaiNovelExportEntries(makePackage({ items: [rangePack, single] })),
      "EXPORT_INVALID_EPISODE_IDENTITY"
    );
  });
});

describe("IPE-064R4B review rounds 13-15 collision refinements", () => {
  const NOTE_FIXTURE = (start: number, end: number) => {
    const chapters = Array.from({ length: end - start + 1 }, (_, index) => {
      const chapter = start + index;
      return `บทที่ ${chapter} จ้าวกลยุทธ์โปเกมอน\n\nเนื้อหา ${chapter}`;
    });
    return `แพ็กตอน ${start} - ${end} 001\n\n${chapters.join("\n\n")}`;
  };

  it("round 13: an unrelated malformed unselected pack does not block a valid subset", () => {
    // The unselected 1-50 pack is malformed (49 headings for 50 declared).
    // It must not block exporting the valid 51-100 subset.
    const malformed = makeItem({
      episodeId: 1,
      episodeNumber: "1 - 50",
      content: NOTE_FIXTURE(1, 49),
    });
    const valid = makeItem({
      episodeId: 2,
      episodeNumber: "51 - 100",
      content: makePackContent(51, 100),
    });
    assertNoCrossPackChapterCollisions(
      [malformed, valid],
      new Set([2]),
    );
  });

  it("round 13: collisions wholly between two unselected packs do not block a valid subset", () => {
    const overlappingA = makeItem({
      episodeId: 1,
      episodeNumber: "1 - 50",
      content: makePackContent(1, 50),
    });
    const overlappingB = makeItem({
      episodeId: 2,
      episodeNumber: "40 - 80",
      content: makePackContent(40, 80),
    });
    const valid = makeItem({
      episodeId: 3,
      episodeNumber: "500 - 520",
      content: makePackContent(500, 520),
    });
    // Both colliding packs are unselected — the valid subset still exports.
    assertNoCrossPackChapterCollisions(
      [overlappingA, overlappingB, valid],
      new Set([3]),
    );
  });
});

// ============================================================================
// fix/thainovel-zip-title-collision regression cases.
// Root cause: the shared sanitizer keeps only the final path segment, so a
// Thai heading containing "/" was truncated to e.g. "2).txt". The fix maps
// slash/backslash to readable Unicode (U+2044, U+FF3C) BEFORE sanitization
// and adds a deterministic chapter-identity suffix when distinct chapters
// still collide after normalization/truncation.
// ============================================================================

describe("Thai title slash normalization (ZIP filename collision fix)", () => {
  // "\u2044" = FRACTION SLASH, "\uFF3C" = FULLWIDTH REVERSE SOLIDUS — the
  // readable replacements emitted by makeThaiNovelFilenameReadable.
  const FRACTION_SLASH = "\u2044";
  const FULLWIDTH_REVERSE_SOLIDUS = "\uFF3C";

  it("keeps (1/2) and (2/2) titles readable instead of truncating to the last segment", () => {
    expect(resolveThaiNovelFilename("บทที่ 5 ตอนจบ (1/2)")).toBe(`บทที่ 5 ตอนจบ (1${FRACTION_SLASH}2).txt`);
    expect(resolveThaiNovelFilename("บทที่ 6 ตอนจบ (2/2)")).toBe(`บทที่ 6 ตอนจบ (2${FRACTION_SLASH}2).txt`);
  });

  it("keeps (1/3), (2/3) and (3/3) titles readable", () => {
    expect(resolveThaiNovelFilename("บทที่ 7 เริ่มต้น (1/3)")).toBe(`บทที่ 7 เริ่มต้น (1${FRACTION_SLASH}3).txt`);
    expect(resolveThaiNovelFilename("บทที่ 7 กลางทาง (2/3)")).toBe(`บทที่ 7 กลางทาง (2${FRACTION_SLASH}3).txt`);
    expect(resolveThaiNovelFilename("บทที่ 7 บทส่งท้าย (3/3)")).toBe(`บทที่ 7 บทส่งท้าย (3${FRACTION_SLASH}3).txt`);
  });

  it("maps backslashes and mixed separators to readable alternatives", () => {
    expect(resolveThaiNovelFilename("บทที่ 8 (ภาคา\\ภาคบี)")).toBe(`บทที่ 8 (ภาคา${FULLWIDTH_REVERSE_SOLIDUS}ภาคบี).txt`);
    expect(resolveThaiNovelFilename("บทที่ 9 (1\\2/3)")).toBe(`บทที่ 9 (1${FULLWIDTH_REVERSE_SOLIDUS}2${FRACTION_SLASH}3).txt`);
  });

  it("keeps the first TXT line verbatim while the filename uses readable slashes", () => {
    const item = makeItem({
      episodeNumber: "5",
      content: "บทที่ 5 การตัดสินใจ (1/2)\n\nเนื้อหาบทที่ห้า",
    });
    const [entry] = buildThaiNovelExportEntries(makePackage({ items: [item] }));
    expect(entry.title).toBe("บทที่ 5 การตัดสินใจ (1/2)");
    expect(entry.filename).toBe(`บทที่ 5 การตัดสินใจ (1${FRACTION_SLASH}2).txt`);
    expect(entry.text.split("\n")[0]).toBe("บทที่ 5 การตัดสินใจ (1/2)");
    expect(entry.text.split("\n")[1]).toBe("");
  });

  it("still neutralizes every other filesystem-invalid character", () => {
    const filename = resolveThaiNovelFilename('บทที่ 10 ชื่อ: "สงคราม"? <จบ> | ตอน*');
    expect(filename).not.toMatch(/[\\/:*?"<>|\u0000-\u001f]/);
    expect(filename.endsWith(".txt")).toBe(true);
    expect(filename).toBe("บทที่ 10 ชื่อ สงคราม จบ ตอน.txt");
  });

  it("still truncates long titles to the shared component cap", () => {
    const longTail = "ก".repeat(120);
    const filename = resolveThaiNovelFilename(`บทที่ 3 ${longTail}`);
    const stem = filename.slice(0, -".txt".length);
    expect(stem.length).toBeLessThanOrEqual(MAX_EXPORT_FILENAME_COMPONENT_CHARS);
    expect(stem.startsWith("บทที่ 3 ")).toBe(true);
  });

  it("falls back to the generated number when sanitization empties the title", () => {
    expect(resolveThaiNovelFilename("???", "042")).toBe("042.txt");
    expect(resolveThaiNovelFilename("", "043")).toBe("043.txt");
  });

  it("shared sanitizer behavior is untouched: real path structure still collapses to the last segment", () => {
    expect(sanitizeExportFilenameComponent("a/b/c.txt")).toBe("c.txt");
    expect(sanitizeExportFilenameComponent("..\\..\\x")).toBe("x");
  });
});

describe("distinct-chapter filename collisions (deterministic identity suffix)", () => {
  // "ชื่อซ้ำ?" and "ชื่อซ้ำ:" contain filesystem-invalid characters, so both
  // sanitize to the same readable stem "ชื่อซ้ำ" — but they are DIFFERENT
  // chapters (5 and 6) and both must survive.
  const collidingPair = () => [
    makeItem({ episodeId: 5, episodeNumber: "5", episodeTitle: "ชื่อซ้ำ?", content: "เนื้อหาบทที่ห้า" }),
    makeItem({ episodeId: 6, episodeNumber: "6", episodeTitle: "ชื่อซ้ำ:", content: "เนื้อหาบทที่หก" }),
  ];

  it("suffixes only the later colliding entry and keeps both bodies intact", () => {
    const entries = buildThaiNovelExportEntries(makePackage({ items: collidingPair() }));
    expect(entries.map((entry) => entry.filename)).toEqual(["ชื่อซ้ำ.txt", "ชื่อซ้ำ (c006).txt"]);
    // First-line titles stay verbatim — sanitization touches filenames only.
    expect(entries[0].title).toBe("ชื่อซ้ำ?");
    expect(entries[1].title).toBe("ชื่อซ้ำ:");
    expect(entries[0].text).toContain("เนื้อหาบทที่ห้า");
    expect(entries[1].text).toContain("เนื้อหาบทที่หก");
  });

  it("is deterministic across runs and ZIP builds", () => {
    const first = buildThaiNovelExportZip(makePackage({ items: collidingPair() }));
    const second = buildThaiNovelExportZip(makePackage({ items: collidingPair() }));
    expect(first.entries).toEqual(second.entries);
    expect(first.content.equals(second.content)).toBe(true);
  });

  it("never silently overwrites: the ZIP carries both files with distinct names", () => {
    const zipExport = buildThaiNovelExportZip(makePackage({ items: collidingPair() }));
    // adm-zip's central directory is name-ordered after toBuffer, so compare
    // as a set — the per-name body checks below prove no overwrite happened.
    expect([...zipExport.entryFilenames].sort()).toEqual(["ชื่อซ้ำ (c006).txt", "ชื่อซ้ำ.txt"].sort());
    expect(new Set(zipExport.entryFilenames.map((name) => name.toLowerCase())).size).toBe(2);

    const reopened = new AdmZip(zipExport.content);
    expect(reopened.getEntry("ชื่อซ้ำ.txt")!.getData().toString("utf8")).toContain("เนื้อหาบทที่ห้า");
    expect(reopened.getEntry("ชื่อซ้ำ (c006).txt")!.getData().toString("utf8")).toContain("เนื้อหาบทที่หก");
  });

  it("keeps preview filenames identical to the actual ZIP entry filenames when suffixing", () => {
    const entries = buildThaiNovelExportEntries(makePackage({ items: collidingPair() }));
    const rows = buildThaiNovelPreviewRows(entries);
    const zipExport = buildThaiNovelExportZip(makePackage({ items: collidingPair() }));
    // Same NAME SET (order inside the archive is adm-zip's internal choice).
    expect([...rows.map((row) => row.filename)].sort()).toEqual([...zipExport.entryFilenames].sort());
    expect([...zipExport.entries.map((row) => row.filename)].sort()).toEqual([...zipExport.entryFilenames].sort());
  });

  it("truncates long colliding stems before appending the identity suffix", () => {
    const longTitle = "ฟ".repeat(120);
    const items = [
      makeItem({ episodeId: 5, episodeNumber: "5", episodeTitle: longTitle, content: "ห้า" }),
      makeItem({ episodeId: 6, episodeNumber: "6", episodeTitle: longTitle, content: "หก" }),
    ];
    const filenames = buildThaiNovelExportEntries(makePackage({ items })).map((entry) => entry.filename);
    expect(filenames[0]).not.toBe(filenames[1]);
    // The first entry keeps the plain truncated name; only the later
    // collision gets the identity suffix, appended OUTSIDE the truncation.
    expect(filenames[0]).toBe(`${"ฟ".repeat(MAX_EXPORT_FILENAME_COMPONENT_CHARS)}.txt`);
    const secondStem = filenames[1].slice(0, -".txt".length);
    expect(secondStem).toBe(`${"ฟ".repeat(MAX_EXPORT_FILENAME_COMPONENT_CHARS - " (c006)".length)} (c006)`);
    expect(secondStem.length).toBeLessThanOrEqual(MAX_EXPORT_FILENAME_COMPONENT_CHARS);
  });

  it("still fail-closes on structural duplicate chapters instead of suffixing them away", () => {
    const dupA = makeItem({ episodeId: 1, episodeNumber: "5", content: "บทที่ 5 ฉบับแรก\n\nเนื้อหา" });
    const dupB = makeItem({ episodeId: 2, episodeNumber: "5", content: "บทที่ 5 ฉบับซ้ำ\n\nเนื้อหา" });
    expectExportError(
      () => buildThaiNovelExportEntries(makePackage({ items: [dupA, dupB] })),
      "EXPORT_INVALID_EPISODE_IDENTITY"
    );
  });
});

describe("slash-title ZIP integrity (fix regression)", () => {
  it("exports a (1/3)(2/3)(3/3) pack with full readable filenames and intact bodies", () => {
    const pack = makeItem({
      episodeId: 1013,
      episodeNumber: "1 - 3",
      episodeTitle: "แพ็กตอน 1 - 3 001",
      content: [
        "แพ็กตอน 1 - 3 001",
        "",
        "บทที่ 1 แยกสามส่วน (1/3)",
        "",
        "เนื้อหา 1",
        "",
        "บทที่ 2 แยกสามส่วน (2/3)",
        "",
        "เนื้อหา 2",
        "",
        "บทที่ 3 แยกสามส่วน (3/3)",
        "",
        "เนื้อหา 3",
      ].join("\n"),
    });
    const zipExport = buildThaiNovelExportZip(makePackage({ items: [pack] }));
    const expected = [
      `บทที่ 1 แยกสามส่วน (1\u20443).txt`,
      `บทที่ 2 แยกสามส่วน (2\u20443).txt`,
      `บทที่ 3 แยกสามส่วน (3\u20443).txt`,
    ];
    expect(zipExport.entryFilenames).toEqual(expected);
    expect(zipExport.entries.map((row) => row.filename)).toEqual(expected);

    const reopened = new AdmZip(zipExport.content);
    expect(reopened.getEntryCount()).toBe(3);
    for (const [index, filename] of expected.entries()) {
      const chapter = index + 1;
      const data = reopened.getEntry(filename)!.getData().toString("utf8");
      expect(data.split("\n")[0]).toBe(`บทที่ ${chapter} แยกสามส่วน (${chapter}/3)`);
      expect(data.split("\n")[1]).toBe("");
      expect(data).toContain(`เนื้อหา ${chapter}`);
    }
  });

  it("keeps a (1/2)/(2/2) pair unique without any collision suffix", () => {
    const items = [
      makeItem({ episodeId: 5, episodeNumber: "5", content: "บทที่ 5 ตอนจบ (1/2)\n\nเนื้อหา 5" }),
      makeItem({ episodeId: 6, episodeNumber: "6", content: "บทที่ 6 ตอนจบ (2/2)\n\nเนื้อหา 6" }),
    ];
    const zipExport = buildThaiNovelExportZip(makePackage({ items }));
    expect(zipExport.entryFilenames).toEqual(["บทที่ 5 ตอนจบ (1\u20442).txt", "บทที่ 6 ตอนจบ (2\u20442).txt"]);
    expect(zipExport.entryFilenames.every((name) => !name.includes(" (c"))).toBe(true);
  });

  it("keeps slashed novel titles readable in the download filename", () => {
    const zipExport = buildThaiNovelExportZip(makePackage({ novelTitle: "ตำนานมังกร (ฉบับรวม 1/2)" }));
    expect(zipExport.filename).toBe("ตำนานมังกร (ฉบับรวม 1\u20442)-thainovel.zip");
  });
});

// ============================================================================
// R2 bounded repair — REVIEW_HOLD P2.
// R1 checked collision only BEFORE appending ` (c<generatedNumber>)` and never
// re-checked the suffixed name. A chapter whose NATURAL name merely resembles
// a generated suffix (e.g. title "ชื่อซ้ำ (c006)") could therefore collide
// with a later chapter's suffixed name. R2 reserves every chapter's natural
// name up-front and runs a bounded deterministic `-<attempt>` fallback before
// failing closed.
// ============================================================================

describe("R2: suffix-vs-natural-name collision (reviewer fixture)", () => {
  const reviewerFixture = () => [
    makeItem({ episodeId: 4, episodeNumber: "4", episodeTitle: "ชื่อซ้ำ (c006)", content: "เนื้อหาบทที่สี่" }),
    makeItem({ episodeId: 5, episodeNumber: "5", episodeTitle: "ชื่อซ้ำ?", content: "เนื้อหาบทที่ห้า" }),
    makeItem({ episodeId: 6, episodeNumber: "6", episodeTitle: "ชื่อซ้ำ:", content: "เนื้อหาบทที่หก" }),
  ];

  it("never assigns a suffixed name that duplicates another chapter's natural name", () => {
    const entries = buildThaiNovelExportEntries(makePackage({ items: reviewerFixture() }));
    expect(entries.map((entry) => entry.filename)).toEqual([
      "ชื่อซ้ำ (c006).txt", // chapter 4: natural name that resembles a suffix keeps it
      "ชื่อซ้ำ.txt", // chapter 5: first claimant of the natural stem
      "ชื่อซ้ำ (c006-2).txt", // chapter 6: ` (c006)` is taken by chapter 4 → bounded fallback
    ]);
    const keys = entries.map((entry) => entry.filename.toLowerCase());
    expect(new Set(keys).size).toBe(3);
    // No silent overwrite: all three bodies remain reachable under their names.
    expect(entries.map((entry) => entry.text)).toEqual([
      "ชื่อซ้ำ (c006)\n\nเนื้อหาบทที่สี่",
      "ชื่อซ้ำ?\n\nเนื้อหาบทที่ห้า",
      "ชื่อซ้ำ:\n\nเนื้อหาบทที่หก",
    ]);
  });

  it("reserves natural names up-front regardless of chapter order", () => {
    // Same collision shape but the suffix-resembling natural name comes LAST
    // and matches the collider's generated number (`c005`), proving the
    // earlier collider's suffix cannot pre-claim it.
    const items = [
      makeItem({ episodeId: 4, episodeNumber: "4", episodeTitle: "ชื่อซ้ำ?", content: "เนื้อหาบทที่สี่" }),
      makeItem({ episodeId: 5, episodeNumber: "5", episodeTitle: "ชื่อซ้ำ:", content: "เนื้อหาบทที่ห้า" }),
      makeItem({ episodeId: 6, episodeNumber: "6", episodeTitle: "ชื่อซ้ำ (c005)", content: "เนื้อหาบทที่หก" }),
    ];
    const entries = buildThaiNovelExportEntries(makePackage({ items }));
    expect(entries.map((entry) => entry.filename)).toEqual([
      "ชื่อซ้ำ.txt",
      "ชื่อซ้ำ (c005-2).txt", // ` (c005)` reserved for chapter 6's natural name
      "ชื่อซ้ำ (c005).txt",
    ]);
    expect(new Set(entries.map((entry) => entry.filename.toLowerCase())).size).toBe(3);
  });

  it("builds the reviewer fixture ZIP without unsafe-path failure and keeps bodies per name", () => {
    const zipExport = buildThaiNovelExportZip(makePackage({ items: reviewerFixture() }));
    expect(zipExport.itemCount).toBe(3);
    expect(new Set(zipExport.entryFilenames).size).toBe(3);

    const reopened = new AdmZip(zipExport.content);
    expect(reopened.getEntry("ชื่อซ้ำ (c006).txt")!.getData().toString("utf8")).toContain("เนื้อหาบทที่สี่");
    expect(reopened.getEntry("ชื่อซ้ำ.txt")!.getData().toString("utf8")).toContain("เนื้อหาบทที่ห้า");
    expect(reopened.getEntry("ชื่อซ้ำ (c006-2).txt")!.getData().toString("utf8")).toContain("เนื้อหาบทที่หก");
  });
});

describe("R2: 3-way collision and deterministic allocation", () => {
  it("resolves a 3-way sanitized-title collision with distinct deterministic names", () => {
    const items = [
      makeItem({ episodeId: 5, episodeNumber: "5", episodeTitle: "ชื่อเดียวกัน?", content: "เนื้อหาห้า" }),
      makeItem({ episodeId: 6, episodeNumber: "6", episodeTitle: "ชื่อเดียวกัน:", content: "เนื้อหาหก" }),
      makeItem({ episodeId: 7, episodeNumber: "7", episodeTitle: "ชื่อเดียวกัน*", content: "เนื้อหาเจ็ด" }),
    ];
    const entries = buildThaiNovelExportEntries(makePackage({ items }));
    expect(entries.map((entry) => entry.filename)).toEqual([
      "ชื่อเดียวกัน.txt",
      "ชื่อเดียวกัน (c006).txt",
      "ชื่อเดียวกัน (c007).txt",
    ]);
    expect(new Set(entries.map((entry) => entry.filename.toLowerCase())).size).toBe(3);
  });

  it("is deterministic across runs for the repaired allocation", () => {
    const items = [
      makeItem({ episodeId: 4, episodeNumber: "4", episodeTitle: "ชื่อซ้ำ (c006)", content: "สี่" }),
      makeItem({ episodeId: 5, episodeNumber: "5", episodeTitle: "ชื่อซ้ำ?", content: "ห้า" }),
      makeItem({ episodeId: 6, episodeNumber: "6", episodeTitle: "ชื่อซ้ำ:", content: "หก" }),
    ];
    const first = buildThaiNovelExportZip(makePackage({ items }));
    const second = buildThaiNovelExportZip(makePackage({ items }));
    expect(first.entries).toEqual(second.entries);
    expect(first.content.equals(second.content)).toBe(true);
  });

  it("falls back deterministically on case-insensitive collisions (suffix-resembling and plain)", () => {
    const items = [
      makeItem({ episodeId: 4, episodeNumber: "4", episodeTitle: "Same (C006)", content: "สี่" }),
      makeItem({ episodeId: 5, episodeNumber: "5", episodeTitle: "same?", content: "ห้า" }),
      makeItem({ episodeId: 6, episodeNumber: "6", episodeTitle: "SAME:", content: "หก" }),
    ];
    const entries = buildThaiNovelExportEntries(makePackage({ items }));
    expect(entries.map((entry) => entry.filename)).toEqual([
      "Same (C006).txt",
      "same.txt",
      "SAME (c006-2).txt", // case-insensitive key of `Same (C006).txt` is taken
    ]);
    const keys = entries.map((entry) => entry.filename.toLowerCase());
    expect(new Set(keys).size).toBe(3);
  });
});

describe("R2: long-title collisions stay bounded and readable", () => {
  it("keeps every allocated stem within the 80-character cap, including fallback suffixes", () => {
    const items = [
      // Natural name fills the cap exactly with a suffix-resembling tail.
      makeItem({ episodeId: 4, episodeNumber: "4", episodeTitle: `${"ฟ".repeat(73)} (c006)`, content: "สี่" }),
      makeItem({ episodeId: 5, episodeNumber: "5", episodeTitle: "ฟ".repeat(120), content: "ห้า" }),
      makeItem({ episodeId: 6, episodeNumber: "6", episodeTitle: `${"ฟ".repeat(120)}:`, content: "หก" }),
    ];
    const filenames = buildThaiNovelExportEntries(makePackage({ items })).map((entry) => entry.filename);
    expect(new Set(filenames.map((name) => name.toLowerCase())).size).toBe(3);
    for (const filename of filenames) {
      const stem = filename.slice(0, -".txt".length);
      expect(stem.length).toBeLessThanOrEqual(MAX_EXPORT_FILENAME_COMPONENT_CHARS);
    }
    expect(filenames[0]).toBe(`${"ฟ".repeat(73)} (c006).txt`);
    expect(filenames[1]).toBe(`${"ฟ".repeat(80)}.txt`);
    // Colliding long stem is re-truncated around the `-2` fallback suffix.
    expect(filenames[2]).toBe(`${"ฟ".repeat(71)} (c006-2).txt`);
  });
});

describe("R2: bounded fallback fails closed instead of overwriting", () => {
  it("throws EXPORT_UNSAFE_PATH when all bounded attempts are taken", () => {
    // Chapter 6 is the collider; its ` (c006)` and every ` (c006-2..100)`
    // fallback name are pre-claimed by other chapters' natural names.
    const blockers = Array.from({ length: 99 }, (_, index) =>
      makeItem({
        episodeId: 1002 + index,
        episodeNumber: String(1002 + index),
        episodeTitle: `x (c006-${index + 2})`,
        content: `เนื้อหา ${1002 + index}`,
      })
    );
    const items = [
      makeItem({ episodeId: 5, episodeNumber: "5", episodeTitle: "x?", content: "ห้า" }),
      makeItem({ episodeId: 6, episodeNumber: "6", episodeTitle: "x:", content: "หก" }),
      makeItem({ episodeId: 7, episodeNumber: "7", episodeTitle: "x (c006)", content: "เจ็ด" }),
      ...blockers,
    ];
    expectExportError(
      () => buildThaiNovelExportEntries(makePackage({ items })),
      "EXPORT_UNSAFE_PATH"
    );
  });
});

describe("R2: preview/ZIP parity for fallback names", () => {
  it("preview filename equals the actual ZIP entry filename including `-2` fallbacks", () => {
    const items = [
      makeItem({ episodeId: 4, episodeNumber: "4", episodeTitle: "ชื่อซ้ำ (c006)", content: "เนื้อหาบทที่สี่" }),
      makeItem({ episodeId: 5, episodeNumber: "5", episodeTitle: "ชื่อซ้ำ?", content: "เนื้อหาบทที่ห้า" }),
      makeItem({ episodeId: 6, episodeNumber: "6", episodeTitle: "ชื่อซ้ำ:", content: "เนื้อหาบทที่หก" }),
    ];
    const entries = buildThaiNovelExportEntries(makePackage({ items }));
    const rows = buildThaiNovelPreviewRows(entries);
    const zipExport = buildThaiNovelExportZip(makePackage({ items }));
    expect([...rows.map((row) => row.filename)].sort()).toEqual([...zipExport.entryFilenames].sort());
    expect([...zipExport.entries.map((row) => row.filename)].sort()).toEqual([...zipExport.entryFilenames].sort());

    const reopened = new AdmZip(zipExport.content);
    for (const row of rows) {
      expect(reopened.getEntry(row.filename)!.getData().toString("utf8")).toBe(
        entries.find((entry) => entry.filename === row.filename)!.text
      );
    }
  });
});
