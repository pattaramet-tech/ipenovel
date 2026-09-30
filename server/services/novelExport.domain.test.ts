// IPE-059-A - Pure export domain tests: text normalization, filename/path
// safety, canonical identity ordering, CSV/manifest determinism, TXT/ZIP
// serialization, bounded limits and synthetic performance evidence.
// No database anywhere in this file.

import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import AdmZip from "adm-zip";
import {
  EXPORT_MANIFEST_FILENAME,
  FIXED_ZIP_TIMESTAMP,
  MAX_EXPORT_FILENAME_COMPONENT_CHARS,
  MAX_EXPORT_ITEMS,
  MAX_EXPORT_PER_ITEM_BYTES,
  NovelExportError,
  NovelExportErrorCode,
  NovelExportItem,
  buildExportManifestRows,
  buildNovelExportZip,
  compareExportItemsCanonical,
  flattenExportManifestField,
  normalizeExportText,
  parseExportEpisodeIdentity,
  resolveExportContentFilename,
  sanitizeExportFilenameComponent,
  serializeExportManifestCsv,
  serializeNovelExportTxt,
  sortExportItemsCanonical,
  validateExportPackage,
} from "./novelExport.domain";

function makeItem(overrides: Partial<NovelExportItem> = {}): NovelExportItem {
  return {
    episodeId: 1,
    episodeNumber: "1",
    episodeTitle: "ตอนที่ 1 จุดเริ่มต้น",
    content: "บรรทัดแรก\nบรรทัดที่สอง",
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
    novelTitle: "นิยายทดสอบ",
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

describe("normalizeExportText", () => {
  it("normalizes CRLF and lone CR to LF deterministically", () => {
    expect(normalizeExportText("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
  });

  it("strips a leading BOM but preserves Thai and emoji", () => {
    expect(normalizeExportText("\ufeffสวัสดี 🐉")).toBe("สวัสดี 🐉");
  });

  it("preserves paragraph structure exactly", () => {
    const content = "ย่อหน้าแรก\n\nย่อหน้าที่สอง\n  เว้นวรรคหน้า";
    expect(normalizeExportText(content)).toBe(content);
  });
});

describe("flattenExportManifestField", () => {
  it("collapses newlines and tabs to single spaces", () => {
    expect(flattenExportManifestField("ชื่อ\nหลาย\r\nบรรทัด\tแท็บ")).toBe("ชื่อ หลาย บรรทัด แท็บ");
  });

  it("trims and handles nullish input", () => {
    expect(flattenExportManifestField("  หัวข้อ  ")).toBe("หัวข้อ");
    expect(flattenExportManifestField(null)).toBe("");
    expect(flattenExportManifestField(undefined)).toBe("");
  });
});

describe("sanitizeExportFilenameComponent", () => {
  it("replaces all Windows-invalid characters", () => {
    // Note: "/" and "\\" are path separators handled by the traversal rules,
    // not simple character substitutions - covered in the traversal test.
    expect(sanitizeExportFilenameComponent('a<b>c:d"e f g|h?i*j')).toBe("a b c d e f g h i j");
  });

  it("strips control characters", () => {
    expect(sanitizeExportFilenameComponent("bad\u0001\u0002name")).toBe("bad name");
  });

  it("trims trailing dots and spaces", () => {
    expect(sanitizeExportFilenameComponent("ชื่อเรื่อง. . ")).toBe("ชื่อเรื่อง");
  });

  it("protects Windows reserved names case-insensitively", () => {
    expect(sanitizeExportFilenameComponent("CON")).toBe("_CON");
    expect(sanitizeExportFilenameComponent("com1")).toBe("_com1");
    expect(sanitizeExportFilenameComponent("Lpt3")).toBe("_Lpt3");
  });

  it("defuses path traversal and absolute paths to the last safe segment", () => {
    expect(sanitizeExportFilenameComponent("../../etc/passwd")).toBe("passwd");
    expect(sanitizeExportFilenameComponent("..")).toBe("export");
    expect(sanitizeExportFilenameComponent("C:\\evil\\path")).toBe("path");
    expect(sanitizeExportFilenameComponent("/absolute/path")).toBe("path");
  });

  it("falls back deterministically for empty results", () => {
    expect(sanitizeExportFilenameComponent("")).toBe("export");
    expect(sanitizeExportFilenameComponent("...")).toBe("export");
    expect(sanitizeExportFilenameComponent("???")).toBe("export");
    expect(sanitizeExportFilenameComponent("", "novel-1")).toBe("novel-1");
  });

  it("bounds component length deterministically", () => {
    const long = "ยาว".repeat(100);
    const result = sanitizeExportFilenameComponent(long);
    expect(result.length).toBeLessThanOrEqual(MAX_EXPORT_FILENAME_COMPONENT_CHARS);
    expect(result).toBe(sanitizeExportFilenameComponent(long));
  });

  it("keeps readable Thai/Unicode names", () => {
    expect(sanitizeExportFilenameComponent("ตำนานมังกร ภาค 1")).toBe("ตำนานมังกร ภาค 1");
  });
});

describe("parseExportEpisodeIdentity", () => {
  it("treats equivalent range spellings identically", () => {
    expect(parseExportEpisodeIdentity("001-030")).toEqual({ kind: "range", start: 1, end: 30 });
    expect(parseExportEpisodeIdentity("001 - 030")).toEqual({ kind: "range", start: 1, end: 30 });
    expect(parseExportEpisodeIdentity("บทที่ 51 - 100")).toEqual({ kind: "range", start: 51, end: 100 });
    expect(parseExportEpisodeIdentity("#051 - 100")).toEqual({ kind: "range", start: 51, end: 100 });
  });

  it("parses singles with leading zeros", () => {
    expect(parseExportEpisodeIdentity("001")).toEqual({ kind: "single", start: 1, end: 1 });
    expect(parseExportEpisodeIdentity("1000")).toEqual({ kind: "single", start: 1000, end: 1000 });
  });

  it("returns null for non-numeric input (fail-safe, never guesses)", () => {
    expect(parseExportEpisodeIdentity("ก่อนกำหนดการ")).toBeNull();
    expect(parseExportEpisodeIdentity("")).toBeNull();
  });
});

describe("canonical ordering", () => {
  it("orders singles 1, 2, 10 (not lexically)", () => {
    const items = ["10", "1", "2"].map((n, i) => makeItem({ episodeId: i + 1, episodeNumber: n }));
    expect(sortExportItemsCanonical(items).map((i) => i.episodeNumber)).toEqual(["1", "2", "10"]);
  });

  it("orders range packs by start then end", () => {
    const items = ["101-150", "001-050", "051-100"].map((n, i) => makeItem({ episodeId: i + 1, episodeNumber: n }));
    expect(sortExportItemsCanonical(items).map((i) => i.episodeNumber)).toEqual(["001-050", "051-100", "101-150"]);
  });

  it("matches the full expected sequence: singles ascending, then ranges ascending", () => {
    const numbers = ["101-150", "10", "051-100", "2", "001-050", "1"];
    const items = numbers.map((n, i) => makeItem({ episodeId: i + 1, episodeNumber: n }));
    expect(sortExportItemsCanonical(items).map((i) => i.episodeNumber)).toEqual([
      "1",
      "2",
      "10",
      "001-050",
      "051-100",
      "101-150",
    ]);
  });

  it("uses episodeId as the deterministic final tiebreak for identical identities", () => {
    const a = makeItem({ episodeId: 7, episodeNumber: "001" });
    const b = makeItem({ episodeId: 3, episodeNumber: "1" });
    expect(compareExportItemsCanonical(a, b)).toBe(4);
    expect(compareExportItemsCanonical(b, a)).toBe(-4);
  });

  it("sorts unparseable identities last without crashing", () => {
    const a = makeItem({ episodeId: 2, episodeNumber: "ไม่มีเลข" });
    const b = makeItem({ episodeId: 1, episodeNumber: "5" });
    expect(compareExportItemsCanonical(a, b)).toBe(1);
  });
});

describe("resolveExportContentFilename", () => {
  it("builds zero-padded identity filenames", () => {
    const used = new Set<string>();
    expect(resolveExportContentFilename(makeItem({ episodeNumber: "1" }), used)).toBe("001.txt");
    expect(resolveExportContentFilename(makeItem({ episodeNumber: "1 - 50" }), used)).toBe("001-050.txt");
    expect(resolveExportContentFilename(makeItem({ episodeNumber: "1000" }), used)).toBe("1000.txt");
  });

  it("resolves duplicate sanitized names with a stable episodeId suffix", () => {
    const used = new Set<string>();
    expect(resolveExportContentFilename(makeItem({ episodeId: 11, episodeNumber: "1" }), used)).toBe("001.txt");
    expect(resolveExportContentFilename(makeItem({ episodeId: 42, episodeNumber: "001" }), used)).toBe("001__ep42.txt");
  });

  it("falls back to episodeId-based stem for unparseable identities", () => {
    const used = new Set<string>();
    expect(resolveExportContentFilename(makeItem({ episodeId: 9, episodeNumber: "ไม่มีเลข" }), used)).toBe("episode-9.txt");
  });
});

describe("manifest CSV serialization", () => {
  it("quotes commas, escapes quotes and keeps cells single-line", () => {
    const pkg = makePackage({
      items: [
        makeItem({
          episodeId: 2,
          episodeNumber: "2",
          episodeTitle: 'ชื่อที่มี, คอมมา และ "คำพูด"',
          description: "คำอธิบาย\nหลายบรรทัด",
        }),
      ],
    });
    const csv = serializeExportManifestCsv(buildExportManifestRows(pkg));
    expect(csv).toContain('"ชื่อที่มี, คอมมา และ ""คำพูด"""');
    // Newlines are flattened, so the manifest is exactly header + 1 row.
    expect(csv.trimEnd().split("\n")).toHaveLength(2);
    expect(csv).toContain("คำอธิบาย หลายบรรทัด");
  });

  it("keeps a stable header order and deterministic row order across calls", () => {
    const pkg = makePackage({
      items: [
        makeItem({ episodeId: 2, episodeNumber: "051-100" }),
        makeItem({ episodeId: 3, episodeNumber: "001-050" }),
      ],
    });
    const first = serializeExportManifestCsv(buildExportManifestRows(pkg));
    const second = serializeExportManifestCsv(buildExportManifestRows(pkg));
    expect(first).toBe(second);
    expect(first.split("\n")[0]).toBe(
      "episodeNumber,episodeTitle,price,isFree,isPublished,saleMode,contentFile,contentFormat,sortOrder,description"
    );
    expect(first.split("\n")[1].startsWith("001-050,")).toBe(true);
    expect(first.split("\n")[2].startsWith("051-100,")).toBe(true);
  });

  it("writes contentFile paths that match generated ZIP entries", () => {
    const rows = buildExportManifestRows(makePackage({ items: [makeItem({ episodeNumber: "1 - 50" })] }));
    expect(rows[0].contentFile).toBe("contents/001-050.txt");
  });

  it("emits UTF-8 Thai without BOM", () => {
    const csv = serializeExportManifestCsv(buildExportManifestRows(makePackage()));
    expect(csv.charCodeAt(0)).not.toBe(0xfeff);
    expect(csv).toContain("ตอนที่ 1 จุดเริ่มต้น");
  });
});

describe("validateExportPackage", () => {
  it("rejects an empty selection", () => {
    expectExportError(() => validateExportPackage(makePackage({ items: [] })), "EXPORT_EMPTY_SELECTION");
  });

  it("rejects more than MAX_EXPORT_ITEMS", () => {
    const items = Array.from({ length: MAX_EXPORT_ITEMS + 1 }, (_, i) =>
      makeItem({ episodeId: i + 1, episodeNumber: String(i + 1) })
    );
    expectExportError(() => validateExportPackage(makePackage({ items })), "EXPORT_LIMIT_ITEMS");
  });

  it("rejects non-numeric episode identities instead of guessing", () => {
    expectExportError(
      () => validateExportPackage(makePackage({ items: [makeItem({ episodeNumber: "ไม่มีเลข" })] })),
      "EXPORT_INVALID_EPISODE_IDENTITY"
    );
  });

  it("rejects non-free episodes with zero price (sale metadata integrity)", () => {
    expectExportError(
      () => validateExportPackage(makePackage({ items: [makeItem({ isFree: false, price: "0.00" })] })),
      "EXPORT_INVALID_SALE_METADATA"
    );
  });

  it("rejects oversized entries with a typed error", () => {
    const big = "x".repeat(MAX_EXPORT_PER_ITEM_BYTES + 1);
    expectExportError(
      () => validateExportPackage(makePackage({ items: [makeItem({ content: big })] })),
      "EXPORT_LIMIT_ENTRY_BYTES"
    );
  });

  it("rejects oversized aggregate bytes with a typed error", () => {
    // 6 x 7MB = 42MB total, each entry still under the per-entry cap.
    const chunk = "x".repeat(7 * 1024 * 1024);
    const items = [1, 2, 3, 4, 5, 6].map((i) => makeItem({ episodeId: i, episodeNumber: String(i), content: chunk }));
    expectExportError(() => validateExportPackage(makePackage({ items })), "EXPORT_LIMIT_TOTAL_BYTES");
  });

  it("accepts a valid package", () => {
    validateExportPackage(makePackage());
  });
});

describe("TXT serialization", () => {
  it("serializes UTF-8 Thai/emoji content with canonical newlines and no BOM", () => {
    const result = serializeNovelExportTxt(makeItem({ episodeNumber: "7", content: "สวัสดี 🐉\r\nบรรทัดใหม่" }));
    expect(result.filename).toBe("007.txt");
    expect(result.mimeType).toBe("text/plain; charset=utf-8");
    expect(result.content[0]).not.toBe(0xef); // no UTF-8 BOM
    expect(result.content.toString("utf8")).toBe("สวัสดี 🐉\nบรรทัดใหม่");
  });
});

describe("ZIP serialization", () => {
  it("builds manifest.csv plus contents/*.txt with deterministic archive order", () => {
    const pkg = makePackage({
      items: [
        makeItem({ episodeId: 2, episodeNumber: "051-100" }),
        makeItem({ episodeId: 1, episodeNumber: "1" }),
        makeItem({ episodeId: 3, episodeNumber: "001-050" }),
      ],
    });
    const result = buildNovelExportZip(pkg);
    // adm-zip stores entries lexicographically - deterministic across builds.
    expect(result.entryFilenames).toEqual([
      "contents/001-050.txt",
      "contents/001.txt",
      "contents/051-100.txt",
      EXPORT_MANIFEST_FILENAME,
    ]);

    const zip = new AdmZip(result.content);
    expect(zip.getEntries().map((e) => e.entryName)).toEqual(result.entryFilenames);
    expect(zip.getEntry(EXPORT_MANIFEST_FILENAME)!.getData().toString("utf8")).toBe(result.manifestCsv);
  });

  it("is byte-identical across repeated builds (fixed entry timestamps)", () => {
    const pkg = makePackage({ items: [makeItem(), makeItem({ episodeId: 2, episodeNumber: "2" })] });
    const first = buildNovelExportZip(pkg).content;
    const second = buildNovelExportZip(pkg).content;
    expect(first.equals(second)).toBe(true);
  });

  it("never embeds the current wall-clock time in entry headers", () => {
    const result = buildNovelExportZip(makePackage());
    const zip = new AdmZip(result.content);
    expect(zip.getEntries()[0].header.time.getTime()).toBe(FIXED_ZIP_TIMESTAMP.getTime());
  });

  it("derives a sanitized deterministic ZIP filename from the novel title", () => {
    expect(buildNovelExportZip(makePackage({ novelTitle: "นิยาย: ภาค 1?" })).filename).toBe("นิยาย ภาค 1.zip");
    expect(buildNovelExportZip(makePackage({ novelTitle: "../../evil" })).filename).toBe("evil.zip");
    expect(buildNovelExportZip(makePackage({ novelTitle: "CON" })).filename).toBe("_CON.zip");
  });

  it("fails closed when the generated archive exceeds the byte cap", () => {
    // Incompressible random ASCII (base64): 5 x ~7MB = ~35MB plaintext
    // (under the 40MB aggregate cap, each under the per-entry cap) but the
    // archive itself exceeds the 24MB ZIP cap.
    const items = [1, 2, 3, 4, 5].map((i) =>
      makeItem({ episodeId: i, episodeNumber: String(i), content: randomBytes(5 * 1024 * 1024).toString("base64") })
    );
    expectExportError(() => buildNovelExportZip(makePackage({ items })), "EXPORT_LIMIT_ZIP_BYTES");
  });
});

describe("synthetic performance evidence (IPE-059-A §30)", () => {
  const CONTENT_CHUNK = ("นิยายบรรทัดทดสอบสำหรับการวัดประสิทธิภาพ 🐉\n".repeat(300)); // ~10KB Thai content

  it("builds 1 / 50 / 200 episode packages within bounded time", () => {
    for (const count of [1, 50, 200]) {
      const items = Array.from({ length: count }, (_, i) =>
        makeItem({ episodeId: i + 1, episodeNumber: String(i + 1), content: CONTENT_CHUNK })
      );
      const started = Date.now();
      const result = buildNovelExportZip(makePackage({ items }));
      const elapsedMs = Date.now() - started;
      // Logged as the performance evidence required by the milestone.
      console.log(
        `[novelExport.perf] episodes=${count} zipBytes=${result.content.length} plaintextBytes=${result.totalPlaintextBytes} elapsedMs=${elapsedMs}`
      );
      expect(elapsedMs).toBeLessThan(15000);
      expect(result.itemCount).toBe(count);
    }
  });
});
