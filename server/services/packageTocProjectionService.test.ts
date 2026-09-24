import { describe, expect, it } from "vitest";
import { projectPackageToc } from "./packageTocProjectionService";

describe("package TOC storefront projection", () => {
  it("projects headings only and preserves source chapter numbers", () => {
    const content = [
      "บทที่ 36 เริ่มการแข่งขัน",
      "",
      "เนื้อหาลับที่ห้ามส่งออก storefront",
      "",
      "บทที่ 37 เซตต่อไป",
      "secret prose",
    ].join("\n");
    expect(projectPackageToc(content)).toEqual([
      { chapterNumber: "36", title: "บทที่ 36 เริ่มการแข่งขัน", lineIndex: 0 },
      { chapterNumber: "37", title: "บทที่ 37 เซตต่อไป", lineIndex: 4 },
    ]);
  });

  it("supports legacy heading formats", () => {
    expect(projectPackageToc("ตอนที่ 1 A\nChapter 2 B\n#3 C").map(x => x.chapterNumber)).toEqual(["1", "2", "3"]);
  });
});
