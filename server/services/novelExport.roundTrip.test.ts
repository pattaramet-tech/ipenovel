// IPE-059-A - Round-trip acceptance tests: the exported ZIP must parse
// correctly through the EXISTING package ZIP import parser
// (packageZipImportService.parsePackageZip) with equivalent episode
// identity, titles, sale metadata, contentFile resolution and TXT bytes.
// Parser/preview only - never writes to the database.

import { describe, expect, it } from "vitest";
import AdmZip from "adm-zip";
import { parsePackageZip } from "./packageZipImportService";
import {
  NovelExportItem,
  NovelExportPackage,
  buildExportManifestRows,
  buildNovelExportZip,
  normalizeExportText,
  serializeExportManifestCsv,
  sortExportItemsCanonical,
} from "./novelExport.domain";

function item(overrides: Partial<NovelExportItem> = {}): NovelExportItem {
  return {
    episodeId: 1,
    episodeNumber: "1",
    episodeTitle: "ตอนที่ 1",
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

describe("round-trip: exporter ZIP -> existing packageZipImportService parser", () => {
  it("parses a mixed free/paid multi-chapter package with zero errors and exact metadata", () => {
    const pkg: NovelExportPackage = {
      novelId: 1,
      novelTitle: "ตำนานมังกร",
      items: [
        item({ episodeId: 10, episodeNumber: "001", episodeTitle: "จุดเริ่มต้น 🐉", isFree: true, price: "0.00" }),
        item({ episodeId: 11, episodeNumber: "002", episodeTitle: "การเดินทาง", isFree: false, price: "25.00" }),
        item({
          episodeId: 12,
          episodeNumber: "051 - 100",
          episodeTitle: "ภาคแพ็ก, ตอนพิเศษ \"รวมดินแดน\"",
          isFree: false,
          price: "50.00",
          sortOrder: 51,
          description: "คำอธิบาย\nหลายบรรทัด",
        }),
      ],
    };

    const zip = buildNovelExportZip(pkg);
    const parsed = parsePackageZip(zip.content);

    expect(parsed.errors).toEqual([]);
    expect(parsed.manifestFileName).toBe("manifest.csv");
    expect(parsed.rows).toHaveLength(3);

    const [row1, row2, row3] = parsed.rows;
    expect(row1.episodeNumber).toBe("001");
    expect(row1.episodeTitle).toBe("จุดเริ่มต้น 🐉");
    expect(row1.isFree).toBe(true);
    expect(row1.price).toBe("0.00");
    expect(row1.saleMode).toBe("package");
    expect(row1.contentFile).toBe("contents/001.txt");
    expect(row1.content).toBe(normalizeExportText("ย่อหน้าแรก\nย่อหน้าที่สอง"));

    expect(row2.episodeNumber).toBe("002");
    expect(row2.isFree).toBe(false);
    expect(row2.price).toBe("25.00");

    // range/pack identity + CSV comma/quote escaping round-trip
    expect(row3.episodeNumber).toBe("051 - 100");
    expect(row3.episodeTitle).toBe('ภาคแพ็ก, ตอนพิเศษ "รวมดินแดน"');
    expect(row3.sortOrder).toBe(51);
    expect(row3.description).toBe("คำอธิบาย หลายบรรทัด");
  });

  it("resolves every contentFile to exactly the TXT bytes the exporter wrote", () => {
    const pkg: NovelExportPackage = {
      novelId: 1,
      novelTitle: "เรื่องทดสอบ",
      items: [
        item({ episodeId: 10, episodeNumber: "1", content: "สวัสดี 🐉\r\nบรรทัดใหม่\nจบ" }),
        item({ episodeId: 11, episodeNumber: "2 - 4", content: "แพ็กสามตอน\nเนื้อหา" }),
      ],
    };

    const zip = buildNovelExportZip(pkg);
    const parsed = parsePackageZip(zip.content);
    expect(parsed.errors).toEqual([]);

    // Manifest rows and canonically-sorted items share the same order, so
    // each parsed row's contentFile must resolve to that item's canonical
    // TXT bytes inside the generated archive.
    const rows = buildExportManifestRows(pkg);
    const sortedItems = sortExportItemsCanonical(pkg.items);
    const rezip = new AdmZip(zip.content);

    for (let i = 0; i < rows.length; i++) {
      const parsedRow = parsed.rows.find((r) => r.contentFile === rows[i].contentFile);
      expect(parsedRow).toBeTruthy();
      const entry = rezip.getEntry(rows[i].contentFile);
      expect(entry).toBeTruthy();
      // Parser strips an optional BOM; the exporter never writes one, so
      // the decoded bytes must equal the canonical serialized text.
      const decoded = entry!.getData().toString("utf8").replace(/^\ufeff/, "");
      expect(decoded).toBe(normalizeExportText(sortedItems[i].content));
    }
  });

  it("keeps manifest bytes deterministic for the same canonical source", () => {
    const pkg: NovelExportPackage = {
      novelId: 1,
      novelTitle: "เรื่องทดสอบ",
      items: [item(), item({ episodeId: 2, episodeNumber: "2" })],
    };
    const first = serializeExportManifestCsv(buildExportManifestRows(pkg));
    const second = serializeExportManifestCsv(buildExportManifestRows(pkg));
    expect(first).toBe(second);
    expect(first.charCodeAt(0)).not.toBe(0xfeff);
  });

  it("documents the existing parser contract: chapter-mode rows are rejected by the package-only import flow", () => {
    // The package ZIP import flow (parsePackageZip) accepts ONLY
    // saleMode="package" rows. Chapter episodes are still exported (the
    // admin export is a full-fidelity backup of canonical published
    // content); re-importing them through THIS flow is expected to be
    // rejected with the parser's own saleMode validation - fail-safe, not
    // silent corruption.
    const pkg: NovelExportPackage = {
      novelId: 1,
      novelTitle: "ผสมโหมดขาย",
      items: [
        item({ episodeId: 10, episodeNumber: "1", saleMode: "package" }),
        item({ episodeId: 11, episodeNumber: "2", saleMode: "chapter" }),
      ],
    };

    const zip = buildNovelExportZip(pkg);
    const parsed = parsePackageZip(zip.content);

    // The package row parses perfectly; the chapter row is rejected by the
    // existing importer contract (saleMode != package), never silently
    // imported.
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].episodeNumber).toBe("1");
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0].field).toBe("saleMode");
    expect(parsed.errors[0].row).toBe(3); // header + row 2 is package... see below
  });

  it("round-trips a package-only ZIP through buildImportPreview-style classification inputs", () => {
    const pkg: NovelExportPackage = {
      novelId: 1,
      novelTitle: "เรื่องแพ็ก",
      items: [item({ episodeId: 10, episodeNumber: "001-050", isFree: false, price: "30.00" })],
    };

    const zip = buildNovelExportZip(pkg);
    const parsed = parsePackageZip(zip.content);

    expect(parsed.errors).toEqual([]);
    expect(parsed.rows[0].episodeNumber).toBe("001-050");
    expect(parsed.rows[0].content).toBe(normalizeExportText("ย่อหน้าแรก\nย่อหน้าที่สอง"));
    expect(parsed.rows[0].contentLength).toBe(normalizeExportText("ย่อหน้าแรก\nย่อหน้าที่สอง").length);
    // Derived sortOrder from the range identity, per existing importer rule.
    expect(parsed.rows[0].sortOrder).toBe(1);
  });
});
