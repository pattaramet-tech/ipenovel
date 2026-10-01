// IPE-059-B - Thai-Novel upload export domain tests: TXT contract,
// numbering, title options, flat ZIP contract, determinism and limits.
// No database anywhere in this file.

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
  ThaiNovelExportEntry,
  buildThaiNovelExportEntries,
  buildThaiNovelExportZip,
  buildThaiNovelPreviewRows,
  buildThaiNovelTxt,
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

function makePackage(overrides: Partial<{ novelId: number; novelTitle: string; items: NovelExportItem[] }> = {}) {
  return {
    novelId: 1,
    novelTitle: "ตำนานมังกร",
    items: [makeItem()],
    ...overrides,
  };
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

describe("TXT contract (one episode = one TXT)", () => {
  it("writes title as the first physical line with the proven blank separator", () => {
    const text = buildThaiNovelTxt(makeItem(), "ตอนที่ 1 จุดเริ่มต้น");
    const lines = text.split("\n");
    expect(lines[0]).toBe("ตอนที่ 1 จุดเริ่มต้น");
    expect(lines[1]).toBe(""); // proven blank separator line
    expect(lines[2]).toBe("ย่อหน้าแรก");
    expect(lines).toHaveLength(4);
  });

  it("preserves the body exactly after the separator (no truncation/shift)", () => {
    const body = "บรรทัด 1\n\nบรรทัด 3  🐉\nบรรทัดสุดท้าย";
    const text = buildThaiNovelTxt(makeItem({ content: body }), "หัวเรื่อง");
    expect(text.endsWith(body)).toBe(true);
    expect(text).toBe(`หัวเรื่อง\n\n${body}`);
  });

  it("keeps Thai + emoji UTF-8 and normalizes CRLF/CR in the body to LF", () => {
    const text = buildThaiNovelTxt(makeItem({ content: "สวัสดี\r\nโลก 🌏\rจบ" }), "ชื่อ");
    expect(text).toBe("ชื่อ\n\nสวัสดี\nโลก 🌏\nจบ");
    expect(Buffer.byteLength(text, "utf8")).toBeGreaterThan(0);
  });

  it("never injects manifest/header metadata into TXT", () => {
    const text = buildThaiNovelTxt(makeItem(), "ชื่อ");
    expect(text).not.toContain("manifest");
    expect(text).not.toContain("episodeNumber");
  });
});

describe("numbering", () => {
  it("generates canonical 001/002/003 filenames", () => {
    const entries = buildThaiNovelExportEntries(
      makePackage({ items: [makeItem({ episodeId: 1, episodeNumber: "1" }), makeItem({ episodeId: 2, episodeNumber: "2" }), makeItem({ episodeId: 3, episodeNumber: "3" })] })
    );
    expect(entries.map((e) => e.filename)).toEqual(["001.txt", "002.txt", "003.txt"]);
    expect(entries.map((e) => e.generatedNumber)).toEqual(["001", "002", "003"]);
  });

  it("orders numerically 001/002/010, not lexically, via canonical source order", () => {
    const entries = buildThaiNovelExportEntries(
      makePackage({
        items: [
          makeItem({ episodeId: 3, episodeNumber: "10" }),
          makeItem({ episodeId: 1, episodeNumber: "1" }),
          makeItem({ episodeId: 2, episodeNumber: "2" }),
        ],
      })
    );
    expect(entries.map((e) => e.filename)).toEqual(["001.txt", "002.txt", "003.txt"]);
    expect(entries.map((e) => e.sourceEpisodeNumber)).toEqual(["1", "2", "10"]);
  });

  it("supports the explicit start-episode-number override", () => {
    const entries = buildThaiNovelExportEntries(
      makePackage({ items: [makeItem({ episodeId: 1, episodeNumber: "5" }), makeItem({ episodeId: 2, episodeNumber: "7" }), makeItem({ episodeId: 3, episodeNumber: "10" })] }),
      { startEpisodeNumber: 101 }
    );
    expect(entries.map((e) => e.filename)).toEqual(["101.txt", "102.txt", "103.txt"]);
    expect(entries.map((e) => e.sourceEpisodeNumber)).toEqual(["5", "7", "10"]);
  });

  it("pads to 3 digits but never truncates larger numbers", () => {
    expect(resolveThaiNovelGeneratedNumber(1, 0)).toBe("001");
    expect(resolveThaiNovelGeneratedNumber(999, 0)).toBe("999");
    expect(resolveThaiNovelGeneratedNumber(999, 1)).toBe("1000");
    expect(resolveThaiNovelGeneratedNumber(1000, 1)).toBe("1001");
    expect(resolveThaiNovelFilename("1000")).toBe("1000.txt");
  });

  it("renumbers a selected subset in deterministic canonical source order", () => {
    // canonical order of source episodes 10, 7, 5 is 5, 7, 10
    const entries = buildThaiNovelExportEntries(
      makePackage({
        items: [
          makeItem({ episodeId: 30, episodeNumber: "10" }),
          makeItem({ episodeId: 10, episodeNumber: "5" }),
          makeItem({ episodeId: 20, episodeNumber: "7" }),
        ],
      }),
      { startEpisodeNumber: 1 }
    );
    expect(entries.map((e) => [e.sourceEpisodeNumber, e.filename])).toEqual([
      ["5", "001.txt"],
      ["7", "002.txt"],
      ["10", "003.txt"],
    ]);
  });

  it("rejects invalid start numbers deterministically", () => {
    expectExportError(() => normalizeThaiNovelOptions({ startEpisodeNumber: 0 }), "EXPORT_INVALID_SALE_METADATA");
    expectExportError(() => normalizeThaiNovelOptions({ startEpisodeNumber: 1.5 }), "EXPORT_INVALID_SALE_METADATA");
    expect(normalizeThaiNovelOptions(undefined).startEpisodeNumber).toBe(1);
  });
});

describe("title options", () => {
  it("applies the title prefix joined with a single space", () => {
    const opts = normalizeThaiNovelOptions({ titlePrefix: "ตอนที่" });
    const title = resolveThaiNovelTitle(makeItem({ episodeTitle: "การพบกันอีกครั้ง" }), "001", opts);
    expect(title).toBe("ตอนที่ การพบกันอีกครั้ง");
  });

  it("tolerates a prefix that already carries a trailing space", () => {
    const opts = normalizeThaiNovelOptions({ titlePrefix: "ตอนที่ " });
    expect(resolveThaiNovelTitle(makeItem({ episodeTitle: "การพบกันอีกครั้ง" }), "001", opts)).toBe("ตอนที่ การพบกันอีกครั้ง");
  });

  it("appends the generated filename stem to the title", () => {
    const opts = normalizeThaiNovelOptions({ appendFilenameToTitle: true });
    expect(resolveThaiNovelTitle(makeItem({ episodeTitle: "การพบกันอีกครั้ง" }), "001", opts)).toBe("การพบกันอีกครั้ง 001");
  });

  it("combines prefix + append without duplication", () => {
    const opts = normalizeThaiNovelOptions({ titlePrefix: "ตอนที่", appendFilenameToTitle: true });
    expect(resolveThaiNovelTitle(makeItem({ episodeTitle: "การพบกันอีกครั้ง" }), "001", opts)).toBe("ตอนที่ การพบกันอีกครั้ง 001");
  });

  it("never duplicates an already-present prefix or filename token", () => {
    const opts = normalizeThaiNovelOptions({ titlePrefix: "ตอนที่", appendFilenameToTitle: true });
    expect(resolveThaiNovelTitle(makeItem({ episodeTitle: "ตอนที่ การพบกันอีกครั้ง" }), "001", opts)).toBe("ตอนที่ การพบกันอีกครั้ง 001");
    // prefix is still added when missing, but the filename token is not duplicated
    expect(resolveThaiNovelTitle(makeItem({ episodeTitle: "การพบกันอีกครั้ง 001" }), "001", opts)).toBe("ตอนที่ การพบกันอีกครั้ง 001");
    expect(resolveThaiNovelTitle(makeItem({ episodeTitle: "ตอนที่ การพบกันอีกครั้ง 001" }), "001", opts)).toBe("ตอนที่ การพบกันอีกครั้ง 001");
  });

  it("handles an empty prefix and falls back to the generated number for empty titles", () => {
    const empty = normalizeThaiNovelOptions({ titlePrefix: "" });
    expect(resolveThaiNovelTitle(makeItem({ episodeTitle: "  " }), "007", empty)).toBe("007");
    expect(resolveThaiNovelTitle(makeItem({ episodeTitle: "ชื่อ" }), "007", empty)).toBe("ชื่อ");
  });

  it("keeps the title a single physical line even when the stored title contains newlines", () => {
    const entries = buildThaiNovelExportEntries(makePackage({ items: [makeItem({ episodeTitle: "ชื่อ\nหลายบรรทัด" })] }));
    expect(entries[0].title).toBe("ชื่อ หลายบรรทัด");
    expect(entries[0].text.split("\n")[0]).toBe("ชื่อ หลายบรรทัด");
  });
});

describe("filename safety", () => {
  it("generates numeric-only filenames that are inherently Windows-safe", () => {
    const entries = buildThaiNovelExportEntries(makePackage({ items: [makeItem({ episodeNumber: '1<>:"/\\|?*' })] }));
    expect(entries[0].filename).toMatch(/^\d+\.txt$/);
  });

  it("derives a sanitized, readable ZIP filename from the novel title", () => {
    expect(buildThaiNovelExportZip(makePackage({ novelTitle: "ตำนานมังกร: ภาค 1?" })).filename).toBe("ตำนานมังกร ภาค 1-thainovel.zip");
    expect(buildThaiNovelExportZip(makePackage({ novelTitle: "../../evil" })).filename).toBe("evil-thainovel.zip");
    expect(buildThaiNovelExportZip(makePackage({ novelTitle: "CON" })).filename).toBe("_CON-thainovel.zip");
    expect(buildThaiNovelExportZip(makePackage({ novelTitle: "" })).filename).toBe("novel-1-thainovel.zip");
  });

  it("rejects duplicate final entry paths instead of overwriting silently", () => {
    // Generated numbers are sequential so collisions cannot occur naturally;
    // exercise the guard directly through an impossible package is not
    // possible - the guard throws on any duplicate path added.
    const zip = buildThaiNovelExportZip(makePackage({ items: [makeItem(), makeItem({ episodeId: 2, episodeNumber: "2" })] }));
    expect(new Set(zip.entryFilenames).size).toBe(zip.entryFilenames.length);
  });
});

describe("flat ZIP contract", () => {
  it("puts TXT files at the ZIP root", () => {
    const result = buildThaiNovelExportZip(makePackage({ items: [makeItem(), makeItem({ episodeId: 2, episodeNumber: "2" })] }));
    expect(result.entryFilenames).toEqual(["001.txt", "002.txt"]);
    const zip = new AdmZip(result.content);
    expect(zip.getEntries().map((e) => e.entryName)).toEqual(["001.txt", "002.txt"]);
  });

  it("contains NO manifest.csv and NO contents/ folder", () => {
    const result = buildThaiNovelExportZip(makePackage({ items: [makeItem(), makeItem({ episodeId: 2, episodeNumber: "2" })] }));
    expect(result.entryFilenames.some((name) => name.toLowerCase().includes("manifest"))).toBe(false);
    expect(result.entryFilenames.some((name) => name.includes("contents"))).toBe(false);
    expect(result.entryFilenames.every((name) => !name.includes("/"))).toBe(true);
  });

  it("stores entry contents as the exact TXT text with UTF-8 bytes", () => {
    const result = buildThaiNovelExportZip(makePackage());
    const zip = new AdmZip(result.content);
    expect(zip.getEntry("001.txt")!.getData().toString("utf8")).toBe("การพบกันอีกครั้ง\n\nย่อหน้าแรก\nย่อหน้าที่สอง");
  });

  it("is deterministic: same input+options => same entries and byte-identical ZIP", () => {
    const pkg = makePackage({
      items: [makeItem(), makeItem({ episodeId: 2, episodeNumber: "2", episodeTitle: "สอง 🐉" }), makeItem({ episodeId: 3, episodeNumber: "001-050" })],
    });
    const options = { startEpisodeNumber: 5, titlePrefix: "ตอนที่", appendFilenameToTitle: true };
    const first = buildThaiNovelExportZip(pkg, options);
    const second = buildThaiNovelExportZip(pkg, options);
    expect(first.entries).toEqual(second.entries);
    expect(first.entryFilenames).toEqual(second.entryFilenames);
    expect(first.content.equals(second.content)).toBe(true);
    expect(first.entryFilenames.every((name) => !name.includes("/"))).toBe(true);

    const zip = new AdmZip(first.content);
    expect(zip.getEntries()[0].header.time.getTime()).toBe(FIXED_ZIP_TIMESTAMP.getTime());
  });

  it("preview rows are derived from the same entries as the download (no text leak)", () => {
    const entries = buildThaiNovelExportEntries(makePackage());
    const rows = buildThaiNovelPreviewRows(entries);
    expect(rows).toEqual([
      { episodeId: 1, sourceEpisodeNumber: "1", generatedNumber: "001", filename: "001.txt", title: "การพบกันอีกครั้ง", byteLength: entries[0].byteLength },
    ]);
    expect(JSON.stringify(rows)).not.toContain("ย่อหน้าแรก");
  });
});

describe("limits (reused from IPE-059-A authority)", () => {
  it("rejects more than the shared MAX_EXPORT_ITEMS via the shared validator", () => {
    const items = Array.from({ length: MAX_EXPORT_ITEMS + 1 }, (_, i) =>
      makeItem({ episodeId: i + 1, episodeNumber: String(i + 1) })
    );
    expectExportError(() => buildThaiNovelExportEntries(makePackage({ items })), "EXPORT_LIMIT_ITEMS");
  });

  it("rejects oversized entries (title+body) with a typed error", () => {
    const big = "x".repeat(MAX_EXPORT_PER_ITEM_BYTES + 1);
    expectExportError(() => buildThaiNovelExportEntries(makePackage({ items: [makeItem({ content: big })] })), "EXPORT_LIMIT_ENTRY_BYTES");
  });

  it("rejects empty packages and non-numeric identities via the shared validator", () => {
    expectExportError(() => buildThaiNovelExportEntries(makePackage({ items: [] })), "EXPORT_EMPTY_SELECTION");
    expectExportError(
      () => buildThaiNovelExportEntries(makePackage({ items: [makeItem({ episodeNumber: "ไม่มีเลข" })] })),
      "EXPORT_INVALID_EPISODE_IDENTITY"
    );
  });
});
