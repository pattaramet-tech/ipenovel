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

  it("shows final merge preview with Wallet, Points and per-table counts", () => {
    expect(source).toContain("Final Preview");
    expect(source).toContain('label="Wallet"');
    expect(source).toContain('label="Points"');
    expect(source).toContain("Per-table reconciliation preview");

  });

  it("requires an irreversible warning, mandatory reason, and exact Donor->Survivor typed confirmation", () => {
    expect(source).toContain("การดำเนินการนี้ย้อนกลับไม่ได้จากหน้า Admin");
    expect(source).toContain("เหตุผลการรวมบัญชี (จำเป็น)");
    expect(source).toMatch(
      /buildAccountMergeConfirmationText\(donorUserId, request\.requesterUserId\)/
    );
    expect(source).toMatch(/mergeConfirmation\.trim\(\) !== confirmationText/);
    expect(source).toContain("ค้นหาบัญชี Donor — บัญชีเดิมที่เข้าไม่ได้");
    expect(source).toContain("Requester User ID (Survivor)");
    expect(source).toContain("donorAccountId: donorUserId");
    expect(source).toContain("survivorAccountId: request.requesterUserId");
  });

  it("never exposes a bypass/waiver control and projects verified completion without rewriting blocked history", () => {
    expect(source).not.toMatch(
      />\s*(Bypass|Waive|Override)\s+(Account\s+)?Merge\s*</i
    );
    expect(source).not.toMatch(/setMerge(Bypass|Waiver|Override)/i);
    expect(source).toContain('lifecycleStatus === "resolved_via_advanced_merge"');
    expect(source).toContain('lifecycleStatus === "resolved_via_historical_compensation"');
    expect(source).toContain("Resolved via Advanced Merge");
    expect(source).toContain("Resolved via Historical Compensation");
    expect(source).toContain("Persisted: {request.status}");
    expect(source).toContain("ยังคงสถานะ <strong>blocked</strong> ใน accountRecoveryRequests");
    expect(source).toContain("lifecycle projection พิสูจน์แล้ว");
    expect(source).toMatch(/isBlocked && !isResolvedRecovery && !mergeCompleted/);
  });

  it("renders a durable merge-case/audit reference after completion", () => {
    expect(source).toMatch(/Advanced Account Merge\s+สำเร็จแล้ว/);
    expect(source).toContain("Audit reference:");
    expect(source).toContain("accountMergeAuditLogs #");
  });
});
