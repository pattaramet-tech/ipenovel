import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(here, "AccountRecoveryPage.tsx"), "utf8");

describe("IPE-045 post-merge customer recovery lifecycle presentation", () => {
  it("renders verified Advanced Merge completion as a success state while keeping the requester session/Google identity on Survivor", () => {
    expect(source).toContain('view === "resolved_via_advanced_merge"');
    expect(source).toContain("กู้คืนบัญชีสำเร็จผ่าน Advanced Account Merge");
    expect(source).toContain("คำขอต้นทางยังถูกเก็บเป็น <strong>blocked</strong>");
    expect(source).toContain("การเชื่อมต่อ Google ยังคงอยู่กับบัญชีปัจจุบันซึ่งเป็น Survivor");
    expect(source).not.toContain("ออกจากระบบ แล้วเข้าสู่ระบบใหม่ด้วย Google");
  });

  it("uses the derived lifecycle status for history badges instead of relabeling the persisted DB status", () => {
    expect(source).toContain("request?.lifecycle?.effectiveStatus ?? request?.status");
    expect(source).toContain('resolved_via_advanced_merge: "กู้คืนสำเร็จผ่าน Advanced Merge"');
    expect(source).toMatch(/STATUS_LABELS\[effectiveRequestStatus\(r\)\]/);
  });
});
