import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../..", import.meta.url);
const page = () =>
  readFileSync(new URL("client/src/pages/WorkspacePage.tsx", root), "utf8");

describe("Workspace Editorial Preview UX", () => {
  it("offers Google Docs quick import while creating a story or episode", () => {
    const source = page();
    expect(source).toContain("Google Docs สำหรับ Quick Import");
    expect(source).toContain("newNovelGoogleDocUrl");
    expect(source).toContain("episodeGoogleDocUrl");
    expect(source).toContain("สร้างเรื่องใหม่และนำเข้า Google Docs แล้ว");
    expect(source).toContain("เพิ่มตอนและนำเข้า Google Docs แล้ว");
    expect(source).toContain("รองรับ Google Docs ที่มีหลายแท็บในลิงก์เดียว");
  });

  it("puts deterministic checker before the collapsible Draft structure", () => {
    const source = page();
    const checker = source.indexOf("Deterministic Foreign-word Checker");
    const draft = source.indexOf("Draft structure ·");
    expect(checker).toBeGreaterThan(-1);
    expect(draft).toBeGreaterThan(checker);
    expect(source).toContain('<details className="rounded-md border bg-muted/10">');
  });
  it("keeps Draft structure anomaly details visible while collapsed", () => {
    const source = page();
    expect(source).toContain("เลขแท็บไม่เรียง");
    expect(source).toContain("แท็บว่าง");
    expect(source).toContain("ไม่มีเลขแท็บ");
    expect(source).toContain("เนื้อหาสั้นผิดปกติ");
    expect(source).toContain("ไม่มีเนื้อหา:");
    expect(source).toContain("สั้นผิดปกติ:");
  });

  it("keeps finding-triggered sentence editing inline with the finding", () => {
    const source = page();
    expect(source).toContain("editorTarget && editorTarget.findingId === finding.id");
    expect(source).toContain("แก้ตรง finding นี้");
  });
});
