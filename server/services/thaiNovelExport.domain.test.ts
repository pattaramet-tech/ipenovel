// IPE-059-C — Thai-Novel export tests.
// Source-of-truth behavior is the attached known-good Naruto bulk TXT archive:
// one logical chapter per TXT, filename from the chapter heading, first line
// equals the heading, one blank separator line, and no pack wrapper line.

import { describe, expect, it } from "vitest";
import AdmZip from "adm-zip";
import {
  FIXED_ZIP_TIMESTAMP,
  MAX_EXPORT_ITEMS,
  MAX_EXPORT_PER_ITEM_BYTES,
  NovelExportError,
  NovelExportErrorCode,
  NovelExportItem,
  NovelExportPackage,
} from "./novelExport.domain";
import {
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
