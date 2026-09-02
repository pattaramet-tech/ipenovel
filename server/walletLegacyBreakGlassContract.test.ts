import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

function readCode(relativePath: string): string {
  return fs.readFileSync(path.resolve(process.cwd(), relativePath), "utf8");
}

describe("wallet legacy break-glass is explicit, audited, and separate from normal Approve", () => {
  const router = readCode("server/routers.ts");
  const service = readCode("server/services/walletService.ts");
  const db = readCode("server/db.ts");
  const ui = readCode("client/src/pages/AdminWalletTopupDetailPage.tsx");

  it("uses a separate admin route with mandatory reason and literal confirmation", () => {
    expect(router).toMatch(/approveLegacyUnprotectedTopup:\s*adminProcedure/);
    expect(router).toMatch(/reason:\s*z\.string\(\)\.trim\(\)\.min\(10\)\.max\(1000\)/);
    expect(router).toMatch(/confirmation:\s*z\.literal\("APPROVE_UNPROTECTED_LEGACY_TOPUP"\)/);
    expect(router).toMatch(/adminApproveLegacyUnprotectedWalletTopup/);
  });

  it("normal approve never silently falls through to the break-glass service", () => {
    const normalStart = service.indexOf("export async function adminApproveWalletTopup(");
    const breakStart = service.indexOf("export async function adminApproveLegacyUnprotectedWalletTopup(");
    expect(normalStart).toBeGreaterThan(-1);
    expect(breakStart).toBeGreaterThan(normalStart);
    const normalBody = service.slice(normalStart, breakStart);
    expect(normalBody).not.toMatch(/legacyUnprotectedApproval/);
  });

  it("revalidates break-glass eligibility under the real wallet approval transaction", () => {
    const start = db.indexOf("export async function approveWalletTopup(");
    const end = db.indexOf("export async function rejectWalletTopup(", start);
    const body = db.slice(start, end);
    expect(body).toMatch(/legacyUnprotectedApproval/);
    expect(body).toMatch(/hasStrongIdentifier\(identifiers\)/);
    expect(body).toMatch(/isPrivateObjectRef\(topup\.slipImageUrl as string\)/);
    expect(body).toMatch(/isTrustedLegacySlipUrl\(topup\.slipImageUrl as string\)/);
    expect(body).toMatch(/hasKnownWalletBreakGlassConflict\(topup\)/);
    expect(body).toMatch(/LEGACY_BREAK_GLASS_NOT_ELIGIBLE/);
    expect(body).toMatch(/LEGACY_BREAK_GLASS_CONFLICT/);
  });

  it("writes durable high-risk audit context into both wallet transaction and top-up log", () => {
    expect(db).toMatch(/HIGH-RISK LEGACY BREAK-GLASS approval by admin/);
    expect(db).toMatch(/HIGH-RISK LEGACY BREAK-GLASS:/);
    expect(db).toMatch(/createdBy:\s*adminUserId/);
  });

  it("only offers the UI escape hatch after normal approval reports NO_STRONG_IDENTIFIER", () => {
    expect(ui).toMatch(/const noStrongIdentifier =[\s\S]*approveError\.includes\("NO_STRONG_IDENTIFIER"\)/);
    expect(ui).toMatch(/Open Legacy Break-glass Approval/);
    expect(ui).toMatch(/High-risk Legacy Break-glass Approval/);
    expect(ui).toMatch(/confirmation:\s*"APPROVE_UNPROTECTED_LEGACY_TOPUP"/);
    expect(ui).toMatch(/breakGlassReason\.trim\(\)\.length < 10/);
    expect(ui).toMatch(/breakGlassConfirmed/);
  });
});
