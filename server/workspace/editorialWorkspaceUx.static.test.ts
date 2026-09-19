import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../..", import.meta.url);
const page = () =>
  readFileSync(new URL("client/src/pages/WorkspacePage.tsx", root), "utf8");

describe("Workspace Editorial Preview UX", () => {
  it("uses a collapsed Novel-grouped Episode Pack table with durable notes", () => {
    const source = page();
    expect(source).toContain("Table-first Editorial");
    expect(source).toContain("editorialNovelGroups.map");
    expect(source).toContain("<details key={group.workspaceNovelId");
    expect(source).toContain("เรื่อง / ช่วงตอน");
    expect(source).toContain("หมายเหตุ");
    expect(source).toContain("updateWorkItemNote.useMutation");
    expect(source).not.toContain("Editorial assignee filter");
  });

  it("supports table search, quick filters and searchable episode intake", () => {
    const source = page();
    expect(source).toContain("Editorial pack search");
    expect(source).toContain("ค้นหาชื่อเรื่อง / Novel ID / ช่วงตอน / ชื่อตอน / หมายเหตุ");
    expect(source).toContain('["new","มาใหม่"]');
    expect(source).toContain('["unchecked","ยังไม่ตรวจ"]');
    expect(source).toContain('["needs_fix","ต้องแก้"]');
    expect(source).toContain('["awaiting_confirm","รอยืนยัน"]');
    expect(source).toContain('["ready_stage","พร้อม Stage"]');
    expect(source).toContain('["ready_publish","พร้อมลง"]');
    expect(source).toContain('["published","ลงแล้ว"]');
    expect(source).toContain("ค้นหาเรื่องด้วยชื่อ / Novel ID");
    expect(source).toContain("searchableWorkspaceNovelOptions");
  });

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
