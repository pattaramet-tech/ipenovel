import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const dbCode = fs.readFileSync(path.resolve(process.cwd(), "server/db.ts"), "utf8");
const serviceCode = fs.readFileSync(
  path.resolve(process.cwd(), "server/services/walletService.ts"),
  "utf8"
);

describe("IPE-020-C04 wallet approval stage wiring", () => {
  it("labels the wallet user guard and top-up row lock separately", () => {
    expect(dbCode).toContain('atWalletApprovalStage("wallet_user_guard"');
    expect(dbCode).toContain('atWalletApprovalStage("wallet_topup_lock"');
  });

  it("labels claim and value-creation writes without changing the fixed API boundary", () => {
    for (const stage of [
      "wallet_slip_claim",
      "wallet_topup_update",
      "wallet_balance_update",
      "wallet_transaction_insert",
      "wallet_topup_log",
    ]) {
      expect(dbCode).toContain(`atWalletApprovalStage("${stage}"`);
    }
    expect(serviceCode).toContain('code: "SERVICE_UNAVAILABLE"');
    expect(serviceCode).toContain("WALLET_APPROVAL_BUSY_MESSAGE");
  });
});
