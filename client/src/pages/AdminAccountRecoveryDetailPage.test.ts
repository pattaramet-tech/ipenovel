import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(
  resolve(here, "AdminAccountRecoveryDetailPage.tsx"),
  "utf8"
);

describe("IPE-008 Admin Advanced Account Merge UI safety", () => {
  it("keeps Simple Recovery and Advanced Merge as separate status-driven flows", () => {
    expect(source).toMatch(/const isPending = requestStatus === "pending"/);
    expect(source).toMatch(/const isBlocked = requestStatus === "blocked"/);
    expect(source).toMatch(
      /trpc\.accountRecovery\.admin\.approve\.useMutation/
    );
    expect(source).toMatch(/trpc\.accountMerge\.admin\.execute\.useMutation/);
  });

  it("shows final merge preview with Wallet, Points, per-table counts and anti-replay preservation", () => {
    expect(source).toContain("Final Preview");
    expect(source).toContain('label="Wallet"');
    expect(source).toContain('label="Points"');
    expect(source).toContain("Per-table reconciliation preview");
    expect(source).toContain("paymentSlipClaims preserved");
  });

  it("requires an irreversible warning, mandatory reason, and exact SOURCE->TARGET typed confirmation", () => {
    expect(source).toContain("การดำเนินการนี้ย้อนกลับไม่ได้จากหน้า Admin");
    expect(source).toContain("เหตุผลการรวมบัญชี (จำเป็น)");
    expect(source).toMatch(
      /buildAccountMergeConfirmationText\(request\.requesterUserId, targetUserId\)/
    );
    expect(source).toMatch(/mergeConfirmation\.trim\(\) !== confirmationText/);
  });

  it("never exposes a bypass/waiver control and keeps blocked recovery history distinct from merge completion", () => {
    expect(source).not.toMatch(
      />\s*(Bypass|Waive|Override)\s+(Account\s+)?Merge\s*</i
    );
    expect(source).not.toMatch(/setMerge(Bypass|Waiver|Override)/i);
    expect(source).toContain("Recovery request นี้ยังคงสถานะ");
    expect(source).toMatch(/workflow\s+แยกและมีสถานะ\/audit\s+ของตัวเอง/);
  });

  it("renders a durable merge-case/audit reference after completion", () => {
    expect(source).toMatch(/Advanced Account Merge\s+สำเร็จแล้ว/);
    expect(source).toContain("Audit reference:");
    expect(source).toContain("accountMergeAuditLogs #");
  });
});
