import { describe, expect, it } from "vitest";
import { MAX_SPLIT_CHAPTERS, sha256Hex, splitPackageContent } from "./packageChapterSplit.domain";

function pack(numbers: number[], options: { header?: string; body?: (n: number) => string; eol?: string } = {}) {
  const eol = options.eol ?? "\n";
  const body = options.body ?? ((n: number) => `เนื้อเรื่องของบทที่ ${n} บรรทัดแรก${eol}บรรทัดที่สอง`);
  const parts = numbers.map((n) => `บทที่ ${n} ชื่อบท ${n}${eol}${eol}${body(n)}${eol}${eol}`);
  return (options.header ? `${options.header}${eol}${eol}` : "") + parts.join("");
}

function codes(plan: ReturnType<typeof splitPackageContent>) {
  return plan.issues.map((i) => i.code);
}

describe("splitPackageContent - happy path", () => {
  it("splits a clean range pack into exactly the declared chapters with exact source offsets", () => {
    const content = pack([1, 2, 3, 4, 5]);
    const plan = splitPackageContent({ episodeNumber: "1 - 5", content });
    expect(plan.ok).toBe(true);
    expect(plan.issues).toEqual([]);
    expect(plan.chapters.map((c) => c.chapterNumber)).toEqual([1, 2, 3, 4, 5]);
    expect(plan.chapters[0].title).toBe("บทที่ 1 ชื่อบท 1");
    // Offsets are into the ORIGINAL content and re-concatenate exactly.
    const rebuilt = plan.chapters.map((c) => content.slice(c.sourceStart, c.sourceEnd)).join("");
    expect(rebuilt).toBe(content);
    expect(plan.chapters[0].sourceStart).toBe(0);
    expect(plan.chapters[4].sourceEnd).toBe(content.length);
    // Stored content = EXACTLY the source slice (nothing trimmed).
    for (const c of plan.chapters) {
      expect(c.content).toBe(content.slice(c.sourceStart, c.sourceEnd));
      expect(c.content.startsWith(`บทที่ ${c.chapterNumber}`)).toBe(true);
      expect(c.bodyCharCount).toBeGreaterThan(0);
    }
    expect(plan.planHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic: same input -> same planHash; any content change -> different hash", () => {
    const content = pack([10, 11, 12]);
    const a = splitPackageContent({ episodeNumber: "10 - 12", content });
    const b = splitPackageContent({ episodeNumber: "010-12", content });
    expect(a.planHash).toBe(b.planHash);
    const c = splitPackageContent({ episodeNumber: "10 - 12", content: content.replace("บรรทัดที่สอง", "บรรทัดที่ 2") });
    expect(c.ok).toBe(true);
    expect(c.planHash).not.toBe(a.planHash);
  });

  it("accepts a matching pack-header preamble and keeps it out of every chapter", () => {
    const content = pack([1, 2, 3], { header: "แพ็กตอน 1 - 3 001" });
    const plan = splitPackageContent({ episodeNumber: "1 - 3", content });
    expect(plan.ok).toBe(true);
    expect(plan.preamble.kind).toBe("pack_header");
    expect(plan.chapters[0].sourceStart).toBe(plan.preamble.sourceEnd);
    expect(plan.chapters.some((c) => c.content.includes("แพ็กตอน"))).toBe(false);
  });

  it("preserves CRLF source bytes and still matches headings", () => {
    const content = pack([1, 2], { eol: "\r\n" });
    const plan = splitPackageContent({ episodeNumber: "1 - 2", content });
    expect(plan.ok).toBe(true);
    expect(plan.chapters.map((c) => content.slice(c.sourceStart, c.sourceEnd)).join("")).toBe(content);
    expect(plan.chapters[0].title).toBe("บทที่ 1 ชื่อบท 1");
  });

  it("merges well-formed split-part headings (k/n) into ONE chapter", () => {
    const content = [
      "บทที่ 1 เริ่มต้น\n\nหนึ่ง\n\n",
      "บทที่ 2 กลางทาง (1/3)\n\nสอง-ก\n\n",
      "บทที่ 2 กลางทาง (2/3)\n\nสอง-ข\n\n",
      "บทที่ 2 กลางทาง (3/3)\n\nสอง-ค\n\n",
      "บทที่ 3 จบ\n\nสาม\n",
    ].join("");
    const plan = splitPackageContent({ episodeNumber: "1 - 3", content });
    expect(plan.ok).toBe(true);
    expect(plan.chapters.map((c) => [c.chapterNumber, c.partCount])).toEqual([
      [1, 1],
      [2, 3],
      [3, 1],
    ]);
    expect(plan.chapters[1].title).toBe("บทที่ 2 กลางทาง");
    expect(plan.chapters[1].content).toContain("สอง-ข");
    expect(plan.chapters[1].content).toContain("สอง-ค");
  });

  it("allows leading whitespace/BOM/NBSP before a heading", () => {
    const content = "\ufeffบทที่ 1\n\nก\n\n\u00a0 บทที่ 2\n\nข\n";
    const plan = splitPackageContent({ episodeNumber: "1 - 2", content });
    expect(plan.ok).toBe(true);
    expect(plan.chapters.map((c) => c.chapterNumber)).toEqual([1, 2]);
  });
});

describe("splitPackageContent - fail-closed rules", () => {
  it("never guesses numbers from the range: heading-less content -> NO_HEADINGS, no chapters", () => {
    const plan = splitPackageContent({ episodeNumber: "1 - 3", content: "ยาวมาก ไม่มีหัวบทเลย\nบรรทัดสอง" });
    expect(plan.ok).toBe(false);
    expect(codes(plan)).toEqual(["NO_HEADINGS"]);
    expect(plan.chapters).toEqual([]);
    expect(plan.planHash).toBeNull();
  });

  it("rejects non-range packages and empty content", () => {
    expect(codes(splitPackageContent({ episodeNumber: "5", content: pack([5]) }))).toEqual(["NOT_RANGE"]);
    expect(codes(splitPackageContent({ episodeNumber: "1 - 3", content: "  \n  " }))).toEqual(["EMPTY_CONTENT"]);
    expect(codes(splitPackageContent({ episodeNumber: "1 - 3", content: null }))).toEqual(["EMPTY_CONTENT"]);
  });

  it("rejects ranges larger than the limit", () => {
    const plan = splitPackageContent({ episodeNumber: `1 - ${MAX_SPLIT_CHAPTERS + 1}`, content: pack([1]) });
    expect(codes(plan)).toEqual(["RANGE_TOO_LARGE"]);
  });

  it("reports a missing chapter (gap)", () => {
    const plan = splitPackageContent({ episodeNumber: "1 - 5", content: pack([1, 2, 4, 5]) });
    expect(plan.ok).toBe(false);
    expect(codes(plan)).toEqual(["MISSING_CHAPTER"]);
    expect(plan.issues[0].chapterNumber).toBe(3);
  });

  it("reports fewer chapters than the range (missing tail)", () => {
    const plan = splitPackageContent({ episodeNumber: "1 - 5", content: pack([1, 2, 3]) });
    expect(codes(plan)).toEqual(["MISSING_CHAPTER"]);
    expect(plan.issues[0].message).toContain("4, 5");
  });

  it("reports extra chapters beyond the declared end", () => {
    const plan = splitPackageContent({ episodeNumber: "1 - 3", content: pack([1, 2, 3, 4]) });
    expect(codes(plan)).toEqual(["EXTRA_CHAPTER_BEYOND_RANGE"]);
    expect(plan.issues[0].chapterNumber).toBe(4);
  });

  it("reports a first chapter that does not match the range start", () => {
    const plan = splitPackageContent({ episodeNumber: "1 - 3", content: pack([2, 3]) });
    expect(codes(plan)).toContain("FIRST_CHAPTER_MISMATCH");
    expect(codes(plan)).toContain("MISSING_CHAPTER");
  });

  it("reports consecutive duplicate headings without part markers", () => {
    const plan = splitPackageContent({ episodeNumber: "1 - 3", content: pack([1, 2, 2, 3]) });
    expect(codes(plan)).toEqual(["DUPLICATE_CHAPTER_NUMBER"]);
  });

  it("reports a non-adjacent repeated heading as duplicate", () => {
    const plan = splitPackageContent({ episodeNumber: "1 - 3", content: pack([1, 2, 3, 2]) });
    expect(codes(plan)).toContain("DUPLICATE_CHAPTER_NUMBER");
  });

  it("reports out-of-order chapters", () => {
    const plan = splitPackageContent({ episodeNumber: "1 - 3", content: pack([1, 3, 2]) });
    expect(codes(plan)).toContain("OUT_OF_ORDER");
  });

  it("rejects malformed split parts: gap, wrong total, lone part", () => {
    const gap = "บทที่ 1 (1/3)\n\nก\n\nบทที่ 1 (3/3)\n\nค\n";
    expect(codes(splitPackageContent({ episodeNumber: "1 - 1", content: gap }))).toEqual(["PART_SEQUENCE_INVALID"]);
    const lone = "บทที่ 1 (1/2)\n\nก\n";
    expect(codes(splitPackageContent({ episodeNumber: "1 - 1", content: lone }))).toEqual(["PART_SEQUENCE_INVALID"]);
    const mixed = "บทที่ 1 (1/2)\n\nก\n\nบทที่ 1\n\nข\n";
    expect(codes(splitPackageContent({ episodeNumber: "1 - 1", content: mixed }))).toEqual(["DUPLICATE_CHAPTER_NUMBER"]);
  });

  it("rejects prose before the first heading unless it is a matching pack header", () => {
    const prose = splitPackageContent({ episodeNumber: "1 - 2", content: "คำนำผู้แปล\n\n" + pack([1, 2]) });
    expect(codes(prose)).toEqual(["PREAMBLE_NOT_ALLOWED"]);
    const wrongHeader = splitPackageContent({ episodeNumber: "1 - 2", content: pack([1, 2], { header: "แพ็กตอน 1 - 9" }) });
    expect(codes(wrongHeader)).toEqual(["PREAMBLE_NOT_ALLOWED"]);
  });

  it("rejects heading-only chapters", () => {
    const content = "บทที่ 1\n\nก\n\nบทที่ 2\n\n\nบทที่ 3\n\nค\n";
    const plan = splitPackageContent({ episodeNumber: "1 - 3", content });
    expect(codes(plan)).toEqual(["EMPTY_CHAPTER"]);
    expect(plan.issues[0].chapterNumber).toBe(2);
  });

  it("rejects decimal chapter headings", () => {
    const plan = splitPackageContent({ episodeNumber: "1 - 2", content: "บทที่ 1\n\nก\n\nบทที่ 1.5\n\nข\n\nบทที่ 2\n\nค\n" });
    expect(codes(plan)).toContain("NON_INTEGER_CHAPTER");
  });

  it("R1: accepts all four Owner heading formats at line start, mixed in one pack", () => {
    const content = [
      "บทที่ 1 เปิดเรื่อง\n\nหนึ่ง\n\n",
      "ตอนที่ 2 ทางแยก\n\nสอง\n\n",
      "Chapter 3 Crossing\n\nสาม\n\n",
      "chapter 4\n\nสี่ (lowercase)\n\n",
      "#5\n\nห้า\n\n",
      "# 6 hash with space\n\nหก\n",
    ].join("");
    const plan = splitPackageContent({ episodeNumber: "1 - 6", content });
    expect(plan.ok).toBe(true);
    expect(plan.chapters.map((c) => c.chapterNumber)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(plan.chapters.map((c) => c.title)).toEqual([
      "บทที่ 1 เปิดเรื่อง",
      "ตอนที่ 2 ทางแยก",
      "Chapter 3 Crossing",
      "chapter 4",
      "#5",
      "# 6 hash with space",
    ]);
  });

  it("R1: Thai digits are read as numbers (stored text is never rewritten)", () => {
    const content = "บทที่ ๑\n\nก\n\nตอนที่ ๒\n\nข\n\n#๓\n\nค\n";
    const plan = splitPackageContent({ episodeNumber: "1 - 3", content });
    expect(plan.ok).toBe(true);
    expect(plan.chapters.map((c) => c.chapterNumber)).toEqual([1, 2, 3]);
    expect(plan.chapters[0].content).toBe("บทที่ ๑\n\nก\n\n"); // Thai digits + trailing blank lines kept verbatim
  });

  it("R1: Thai-digit sequence errors still fail closed (gap / duplicate)", () => {
    const gap = splitPackageContent({ episodeNumber: "1 - 3", content: "บทที่ ๑\n\nก\n\nบทที่ ๓\n\nค\n" });
    expect(codes(gap)).toEqual(["MISSING_CHAPTER"]);
    const dup = splitPackageContent({ episodeNumber: "1 - 2", content: "บทที่ ๑\n\nก\n\nตอนที่ 1\n\nข\n\nบทที่ ๒\n\nค\n" });
    expect(codes(dup)).toEqual(["DUPLICATE_CHAPTER_NUMBER"]);
  });

  it("R1: mixed formats are still order-checked (out of order / beyond range fail closed)", () => {
    const outOfOrder = splitPackageContent({ episodeNumber: "1 - 3", content: "บทที่ 1\n\nก\n\n#3\n\nค\n\nChapter 2\n\nข\n" });
    expect(codes(outOfOrder)).toContain("OUT_OF_ORDER");
    const beyond = splitPackageContent({ episodeNumber: "1 - 2", content: "บทที่ 1\n\nก\n\nตอนที่ 2\n\nข\n\n#3\n\nค\n" });
    expect(codes(beyond)).toEqual(["EXTRA_CHAPTER_BEYOND_RANGE"]);
  });

  it("R1: (k/n) parts merge across formats and Thai digits when complete and in order", () => {
    const content = "Chapter 1 (๑/๒)\n\nก\n\nChapter 1 (๒/๒)\n\nข\n\n#2 (1/1)\n\nค\n";
    const plan = splitPackageContent({ episodeNumber: "1 - 2", content });
    expect(plan.ok).toBe(true);
    expect(plan.chapters.map((c) => [c.chapterNumber, c.partCount])).toEqual([
      [1, 2],
      [2, 1],
    ]);
    expect(plan.chapters[0].title).toBe("Chapter 1");
  });

  it("R1: incomplete or misordered parts fail closed", () => {
    const misordered = "บทที่ 1 (2/2)\n\nข\n\nบทที่ 1 (1/2)\n\nก\n";
    expect(codes(splitPackageContent({ episodeNumber: "1 - 1", content: misordered }))).toEqual(["PART_SEQUENCE_INVALID"]);
    const wrongTotal = "ตอนที่ 1 (1/3)\n\nก\n\nตอนที่ 1 (2/3)\n\nข\n";
    expect(codes(splitPackageContent({ episodeNumber: "1 - 1", content: wrongTotal }))).toEqual(["PART_SEQUENCE_INVALID"]);
  });

  it("R1: heading-like phrases that are NOT at line start stay prose", () => {
    const content = "บทที่ 1\n\nเขาพูดว่า บทที่ 2 ยังไม่มา และ #2 คือแฮชแท็ก ส่วน Chapter 2 อยู่ในหนังสืออีกเล่ม\n\nตอนที่ 2\n\nข\n";
    const plan = splitPackageContent({ episodeNumber: "1 - 2", content });
    expect(plan.ok).toBe(true);
    expect(plan.chapters.map((c) => c.chapterNumber)).toEqual([1, 2]);
    expect(plan.chapters[0].content).toContain("#2 คือแฮชแท็ก");
  });

  it("R1: words that only start like a heading are not headings (Chapters, ##, ตอนที่สอง)", () => {
    const content = "บทที่ 1\n\nChapters 2 to 5 are coming\n##2 not a heading\nตอนที่สอง ไม่มีเลข\n\nบทที่ 2\n\nข\n";
    const plan = splitPackageContent({ episodeNumber: "1 - 2", content });
    expect(plan.ok).toBe(true);
    expect(plan.chapters.map((c) => c.chapterNumber)).toEqual([1, 2]);
  });

  it("collects ALL issues in one pass for the admin preview", () => {
    const plan = splitPackageContent({ episodeNumber: "1 - 6", content: "คำนำ\n" + pack([1, 2, 2, 4, 7]) });
    expect(new Set(codes(plan))).toEqual(
      new Set(["PREAMBLE_NOT_ALLOWED", "DUPLICATE_CHAPTER_NUMBER", "EXTRA_CHAPTER_BEYOND_RANGE", "MISSING_CHAPTER"])
    );
  });
});

describe("R1R1: stored chapter content is the exact source slice (round-trip)", () => {
  function expectExactRoundTrip(content: string, episodeNumber: string, expectedChapters: number) {
    const plan = splitPackageContent({ episodeNumber, content });
    expect(plan.ok).toBe(true);
    expect(plan.chapters).toHaveLength(expectedChapters);
    // preamble + stored chapters == source, byte for byte
    const preamble = content.slice(0, plan.preamble.sourceEnd);
    expect(preamble + plan.chapters.map((c) => c.content).join("")).toBe(content);
    for (const c of plan.chapters) {
      expect(c.content).toBe(content.slice(c.sourceStart, c.sourceEnd));
      expect(c.contentSha256).toBe(sha256Hex(c.content));
      // a stored chapter re-split on its own yields exactly itself
      const again = splitPackageContent({ episodeNumber: `${c.chapterNumber} - ${c.chapterNumber}`, content: c.content });
      expect(again.ok).toBe(true);
      expect(again.chapters).toHaveLength(1);
      expect(again.chapters[0].content).toBe(c.content);
    }
    return plan;
  }

  it("LF with trailing blank lines at every chapter end", () => {
    const content = "บทที่ 1\n\nก\n\n\n\nบทที่ 2\n\nข\n\n\n";
    const plan = expectExactRoundTrip(content, "1 - 2", 2);
    expect(plan.chapters[0].content).toBe("บทที่ 1\n\nก\n\n\n\n");
    expect(plan.chapters[1].content).toBe("บทที่ 2\n\nข\n\n\n");
  });

  it("CRLF and mixed CRLF/LF line endings are preserved", () => {
    const content = "ตอนที่ 1\r\n\r\nหนึ่ง\r\n\r\nตอนที่ 2\n\nสอง\r\n";
    const plan = expectExactRoundTrip(content, "1 - 2", 2);
    expect(plan.chapters[0].content).toBe("ตอนที่ 1\r\n\r\nหนึ่ง\r\n\r\n");
    expect(plan.chapters[1].content).toBe("ตอนที่ 2\n\nสอง\r\n");
  });

  it("a leading BOM stays inside the first stored chapter (never dropped)", () => {
    const content = "\ufeffบทที่ 1\n\nก\n\nบทที่ 2\n\nข";
    const plan = expectExactRoundTrip(content, "1 - 2", 2);
    expect(plan.chapters[0].content.charCodeAt(0)).toBe(0xfeff);
  });

  it("NBSP and interior / trailing spaces and tabs are preserved", () => {
    const content = "\u00a0 บทที่ 1  \n\n\tย่อหน้า\u00a0มี NBSP   \n  \n\u00a0\n#2\t\n\nข\u00a0\u00a0\n";
    const plan = expectExactRoundTrip(content, "1 - 2", 2);
    expect(plan.chapters[0].content.endsWith("   \n  \n\u00a0\n")).toBe(true);
    expect(plan.chapters[1].content).toBe("#2\t\n\nข\u00a0\u00a0\n");
  });

  it("Unicode: Thai tone marks, emoji (surrogate pairs), ZWJ sequences and combining marks", () => {
    const content = "Chapter 1 ก้าวแรก 🚀\n\nผู้หญิง 👩‍👩‍👧 และ é (e\u0301) กับ ตัวอักษร\u200bซ่อน\n\nChapter 2\n\nจบ 🎉\n";
    const plan = expectExactRoundTrip(content, "1 - 2", 2);
    expect(plan.chapters[0].content).toContain("👩‍👩‍👧");
    expect(plan.chapters[0].content).toContain("e\u0301");
    expect(plan.chapters[0].content).toContain("\u200b");
  });

  it("a pack-header preamble is excluded from chapters but still part of the exact round-trip", () => {
    const content = "แพ็กตอน 1 - 2\n\n\nบทที่ 1\n\nก\n\nบทที่ 2\n\nข\n";
    const plan = expectExactRoundTrip(content, "1 - 2", 2);
    expect(plan.preamble.kind).toBe("pack_header");
    expect(content.slice(0, plan.preamble.sourceEnd)).toBe("แพ็กตอน 1 - 2\n\n\n");
  });

  it("trailing whitespace is part of the plan: changing it changes contentSha256 and planHash", () => {
    const a = splitPackageContent({ episodeNumber: "1 - 2", content: "บทที่ 1\n\nก\n\nบทที่ 2\n\nข\n" });
    const b = splitPackageContent({ episodeNumber: "1 - 2", content: "บทที่ 1\n\nก\n\n\nบทที่ 2\n\nข\n" });
    expect(a.ok && b.ok).toBe(true);
    expect(a.chapters[0].contentSha256).not.toBe(b.chapters[0].contentSha256);
    expect(a.planHash).not.toBe(b.planHash);
  });
});
