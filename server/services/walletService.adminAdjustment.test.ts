import { describe, expect, it } from "vitest";
import { adminWalletLedgerAdjustment } from "./walletService";

function fakeTx(balance = "100.00", opts: { insertFails?: boolean } = {}) {
  const state = { balance, updates: [] as any[], ledger: [] as any[] };
  const selectChain: any = {
    from: () => selectChain,
    where: () => selectChain,
    limit: () => selectChain,
    for: async () => [{ userId: 7, balance: state.balance }],
  };
  const tx: any = {
    select: () => selectChain,
    update: () => ({
      set: (value: any) => ({
        where: async () => { state.updates.push(value); state.balance = value.balance; },
      }),
    }),
    insert: () => ({
      values: async (value: any) => {
        if (opts.insertFails) throw new Error("ledger write failed");
        state.ledger.push(value);
        return [{ insertId: 55 }];
      },
    }),
  };
  return { tx, state };
}

describe("adminWalletLedgerAdjustment", () => {  it("credits with exact fixed-decimal accounting and one ledger row", async () => {
    const { tx, state } = fakeTx("100.00");
    const result = await adminWalletLedgerAdjustment({
      tx, userId: 7, delta: "25.50", expectedBalance: "100.00",
      referenceType: "admin_wallet_credit", referenceId: 9, note: "credit",
    });
    expect(result).toEqual({ before: "100.00", after: "125.50", walletTransactionId: 55 });
    expect(state.balance).toBe("125.50");
    expect(state.ledger).toHaveLength(1);
    expect(state.ledger[0].amount).toBe("25.50");
  });

  it("claws back without allowing a negative wallet", async () => {
    const ok = fakeTx("100.00");
    const result = await adminWalletLedgerAdjustment({
      tx: ok.tx, userId: 7, delta: "-100.00", expectedBalance: "100.00",
      referenceType: "admin_wallet_clawback", referenceId: 10, note: "clawback",
    });
    expect(result.after).toBe("0.00");
    const insufficient = fakeTx("99.99");
    await expect(adminWalletLedgerAdjustment({
      tx: insufficient.tx, userId: 7, delta: "-100.00", expectedBalance: "99.99",
      referenceType: "admin_wallet_clawback", referenceId: 11, note: "clawback",
    })).rejects.toThrow("INSUFFICIENT_WALLET");
  });
  it("fails closed on stale preview before any write", async () => {
    const { tx, state } = fakeTx("101.00");
    await expect(adminWalletLedgerAdjustment({
      tx, userId: 7, delta: "10.00", expectedBalance: "100.00",
      referenceType: "admin_wallet_credit", referenceId: 12, note: "stale",
    })).rejects.toThrow("STALE_PREVIEW");
    expect(state.updates).toHaveLength(0);
    expect(state.ledger).toHaveLength(0);
  });

  it("surfaces ledger failure so the enclosing DB transaction can roll back", async () => {
    const { tx } = fakeTx("100.00", { insertFails: true });
    await expect(adminWalletLedgerAdjustment({
      tx, userId: 7, delta: "10.00", expectedBalance: "100.00",
      referenceType: "admin_wallet_credit", referenceId: 13, note: "fault",
    })).rejects.toThrow("ledger write failed");
  });
});
