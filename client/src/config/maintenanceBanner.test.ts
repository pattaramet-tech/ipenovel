import { describe, expect, it } from "vitest";
import { MAINTENANCE_BANNER_CONFIG } from "./maintenanceBanner";

describe("MAINTENANCE_BANNER_CONFIG", () => {
  it("is the single source of truth - every field the banner needs lives here", () => {
    expect(typeof MAINTENANCE_BANNER_CONFIG.enabled).toBe("boolean");
    expect(MAINTENANCE_BANNER_CONFIG.title.length).toBeGreaterThan(0);
    expect(MAINTENANCE_BANNER_CONFIG.dateRangeLines.length).toBeGreaterThan(0);
    expect(MAINTENANCE_BANNER_CONFIG.bodyLines.length).toBeGreaterThan(0);
    for (const line of [...MAINTENANCE_BANNER_CONFIG.dateRangeLines, ...MAINTENANCE_BANNER_CONFIG.bodyLines]) {
      expect(line.length).toBeGreaterThan(0);
    }
  });

  it("carries the exact requested announcement copy", () => {
    expect(MAINTENANCE_BANNER_CONFIG.title).toBe("ประกาศปิดปรับปรุงระบบ");
    expect(MAINTENANCE_BANNER_CONFIG.dateRangeLines).toEqual([
      "วันพุธที่ 19 สิงหาคม เวลา 23.00 น.",
      "ถึง วันพฤหัสบดีที่ 20 สิงหาคม เวลา 03.00 น.",
    ]);
    expect(MAINTENANCE_BANNER_CONFIG.bodyLines).toEqual([
      "เพื่ออัปเกรดและย้ายระบบหลักของ IpeNovel",
      "เว็บไซต์และบริการบางส่วนอาจไม่สามารถใช้งานได้ชั่วคราว",
      "ข้อมูลบัญชี นิยายที่ซื้อ และยอดคงเหลือของผู้ใช้งานยังคงได้รับการดูแลตามปกติ",
    ]);
  });

  it("is currently enabled", () => {
    expect(MAINTENANCE_BANNER_CONFIG.enabled).toBe(true);
  });

  it("no longer carries an `id` field - dismissal is in-memory only now, so there is nothing left to namespace by announcement id", () => {
    expect("id" in MAINTENANCE_BANNER_CONFIG).toBe(false);
  });
});
