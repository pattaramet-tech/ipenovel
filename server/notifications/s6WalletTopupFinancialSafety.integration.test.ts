/**
 * R40R55 S6 — REAL-DATABASE wallet top-up financial safety qualification.
 *
 * Runs ONLY against the disposable `ipenovel_test` MySQL 8 database (the
 * integration project's guard + live SELECT DATABASE() check enforce this
 * before any test file loads). Every scenario below uses the REAL db.ts
 * implementations with REAL concurrent pool connections - no mocks. This is
 * the Real-DB proof half; the mock-proof half lives in
 * walletTopupOcrStaleOutcome.test.ts / walletTopupLifecycle.test.ts and the
 * staging-contract unit proof in walletTopupStagingContract.test.ts.
 *
 * Proven here that mocks cannot prove:
 *   - SQL-level CAS (affectedRows under concurrent settlement)
 *   - row locks (SELECT ... FOR UPDATE) serializing double approvals
 *   - exactly-once wallet credit + ledger + topup log + notification event
 *   - late-OCR staging can never revert a terminal state (real UPDATE guard)
 */
import { afterEach, describe, expect, it } from "vitest";
import { and, count, eq } from "drizzle-orm";
import mysql from "mysql2/promise";
import {
  notificationEvents,
  notificationOutbox,
  topupLogs,
  walletAccounts,
  walletTopups,
  walletTransactions,
} from "../../drizzle/schema";
import * as db from "../db";
import { getTestDb } from "../test-helpers/testDb";
import { createTestUser, deleteFixtures, uniqueTestTag, type TestUserFixture } from "../test-helpers/fixtures";

function requireTestDb() {
  if (!process.env.TEST_DATABASE_URL) {
    throw new Error("S6 integration tests require TEST_DATABASE_URL=.../ipenovel_test");
  }
  return getTestDb();
}

const TOPUP_AMOUNT = "100.00";

async function createPendingTopup(userId: number) {
  const topup = await db.createWalletTopup(userId, TOPUP_AMOUNT, `https://example.test/slips/${uniqueTestTag()}.jpg`);
  return topup as { id: number; status: string; userId: number };
}

async function balanceOf(userId: number): Promise<number> {
  return parseFloat(await db.getWalletBalance(userId));
}

async function scalar(t: ReturnType<typeof getTestDb>, promise: Promise<Array<{ c: number }>>): Promise<number> {
  const rows = await promise;
  return Number(rows[0]?.c ?? 0);
}

interface S6Fixture {
  user: TestUserFixture;
  topupIds: number[];
}

const fixtures: S6Fixture[] = [];

async function newFixture(): Promise<S6Fixture> {
  const user = await createTestUser();
  const f: S6Fixture = { user, topupIds: [] };
  fixtures.push(f);
  return f;
}

async function cleanupFixtures() {
  const t = requireTestDb();
  while (fixtures.length > 0) {
    const f = fixtures.pop()!;
    for (const topupId of f.topupIds) {
      await t.delete(walletTopups).where(eq(walletTopups.id, topupId));
    }
    // notification rows for this user's topups (outbox child-first)
    const events = await t
      .select({ id: notificationEvents.id })
      .from(notificationEvents)
      .where(eq(notificationEvents.targetUserId, f.user.id));
    for (const e of events) {
      await t.delete(notificationOutbox).where(eq(notificationOutbox.eventId, e.id));
    }
    await t.delete(notificationEvents).where(eq(notificationEvents.targetUserId, f.user.id));
    await t.delete(topupLogs).where(eq(topupLogs.userId, f.user.id));
    await t.delete(walletTransactions).where(eq(walletTransactions.userId, f.user.id));
    await t.delete(walletAccounts).where(eq(walletAccounts.userId, f.user.id));
    await deleteFixtures({ userIds: [f.user.id] }).catch(() => {
      /* already gone */
    });
  }
}

afterEach(async () => {
  await cleanupFixtures();
});

describe("S6 wallet top-up: concurrent approvals credit EXACTLY once (real CAS)", () => {
  it("S6-W1: two concurrent manual approvals -> one credit, one ledger row, one log, one event", async () => {
    const f = await newFixture();
    const topup = await createPendingTopup(f.user.id);
    f.topupIds.push(topup.id);

    const outcomes = await Promise.allSettled([
      db.approveWalletTopup(topup.id, 9001),
      db.approveWalletTopup(topup.id, 9002),
    ]);

    const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
    const rejected = outcomes.filter((o) => o.status === "rejected");
    // Exactly one winner. The loser either throws "already processed" or
    // aborts via the CAS guard - but never both credit.
    expect(fulfilled.length).toBe(1);
    for (const r of rejected) {
      expect(String((r as PromiseRejectedResult).reason)).toMatch(/already processed|lost/i);
    }

    const t = requireTestDb();
    const finalTopup = (await t.select().from(walletTopups).where(eq(walletTopups.id, topup.id)))[0];
    expect(finalTopup.status).toBe("approved");
    expect(await balanceOf(f.user.id)).toBeCloseTo(100.0, 2);

    const ledgerRows = await t
      .select()
      .from(walletTransactions)
      .where(and(eq(walletTransactions.userId, f.user.id), eq(walletTransactions.referenceId, topup.id)));
    expect(ledgerRows.length).toBe(1);
    expect(ledgerRows[0].type).toBe("topup_approved");
    expect(parseFloat(ledgerRows[0].balanceAfter)).toBeCloseTo(100.0, 2);

    const logs = await scalar(
      t,
      t.select({ c: count() }).from(topupLogs).where(eq(topupLogs.reference, `topup-${topup.id}`))
    );
    expect(logs).toBe(1);

    const events = await t
      .select()
      .from(notificationEvents)
      .where(and(eq(notificationEvents.kind, "wallet_topup_approved"), eq(notificationEvents.sourceId, String(topup.id))));
    expect(events.length).toBe(1);
    expect(events[0].targetUserId).toBe(f.user.id);
    const outbox = await t.select().from(notificationOutbox).where(eq(notificationOutbox.eventId, events[0].id));
    expect(outbox.length).toBe(1);
    expect(outbox[0].state).toBe("pending");
  });

  it("S6-W2: manual approval vs OCR auto-approval race -> single credit, single settled outcome", async () => {
    const f = await newFixture();
    const topup = await createPendingTopup(f.user.id);
    f.topupIds.push(topup.id);

    await Promise.allSettled([
      db.approveWalletTopup(topup.id, 9001),
      db.approveWalletTopupWithOCR(topup.id, {
        status: "approved",
        ocrDecision: "approved",
        approvalSource: "ocr_auto",
        creditedAmount: TOPUP_AMOUNT,
      }),
    ]);

    const t = requireTestDb();
    const finalTopup = (await t.select().from(walletTopups).where(eq(walletTopups.id, topup.id)))[0];
    expect(finalTopup.status).toBe("approved");
    // credited exactly once regardless of which path won
    expect(await balanceOf(f.user.id)).toBeCloseTo(100.0, 2);
    const ledgerCount = await scalar(
      t,
      t
        .select({ c: count() })
        .from(walletTransactions)
        .where(and(eq(walletTransactions.userId, f.user.id), eq(walletTransactions.referenceId, topup.id)))
    );
    expect(ledgerCount).toBe(1);
  });

  it("S6-W3: approval vs rejection race -> exactly ONE terminal outcome, ledger matches it", async () => {
    const f = await newFixture();
    const topup = await createPendingTopup(f.user.id);
    f.topupIds.push(topup.id);

    await Promise.allSettled([
      db.approveWalletTopup(topup.id, 9001),
      db.rejectWalletTopup(topup.id, 9002, "S6 race test"),
    ]);

    const t = requireTestDb();
    const finalTopup = (await t.select().from(walletTopups).where(eq(walletTopups.id, topup.id)))[0];
    expect(["approved", "rejected"]).toContain(finalTopup.status);

    const approvedEvents = await scalar(
      t,
      t
        .select({ c: count() })
        .from(notificationEvents)
        .where(and(eq(notificationEvents.kind, "wallet_topup_approved"), eq(notificationEvents.sourceId, String(topup.id))))
    );
    const rejectedEvents = await scalar(
      t,
      t
        .select({ c: count() })
        .from(notificationEvents)
        .where(and(eq(notificationEvents.kind, "wallet_topup_rejected"), eq(notificationEvents.sourceId, String(topup.id))))
    );
    // exactly one settlement event, matching the final status
    expect(approvedEvents + rejectedEvents).toBe(1);
    if (finalTopup.status === "approved") {
      expect(approvedEvents).toBe(1);
      expect(await balanceOf(f.user.id)).toBeCloseTo(100.0, 2);
    } else {
      expect(rejectedEvents).toBe(1);
      expect(await balanceOf(f.user.id)).toBeCloseTo(0.0, 2);
    }
  });
});

describe("S6 wallet top-up: late OCR can never revert a terminal state (real UPDATE guard)", () => {
  it("S6-W4: APPROVED -> late OCR staging -> stays approved, updated=false, authoritative row returned", async () => {
    const f = await newFixture();
    const topup = await createPendingTopup(f.user.id);
    f.topupIds.push(topup.id);
    await db.approveWalletTopup(topup.id, 9001);
    const balanceAfterApproval = await balanceOf(f.user.id);

    const outcome = await db.updateWalletTopupWithOCRApproval(topup.id, {
      status: "pending_review",
      reviewReason: "LATE_OCR_RESULT",
      ocrConfidence: 42,
    });

    expect(outcome.updated).toBe(false);
    expect(outcome.topup.status).toBe("approved");
    const t = requireTestDb();
    const row = (await t.select().from(walletTopups).where(eq(walletTopups.id, topup.id)))[0];
    expect(row.status).toBe("approved");
    expect(row.reviewReason).not.toBe("LATE_OCR_RESULT");
    expect(await balanceOf(f.user.id)).toBeCloseTo(balanceAfterApproval, 2);
  });

  it("S6-W5: REJECTED -> late OCR staging -> stays rejected", async () => {
    const f = await newFixture();
    const topup = await createPendingTopup(f.user.id);
    f.topupIds.push(topup.id);
    await db.rejectWalletTopup(topup.id, 9001, "S6 reject");

    const outcome = await db.updateWalletTopupWithOCRApproval(topup.id, {
      status: "pending_review",
      reviewReason: "LATE_OCR_RESULT",
    });

    expect(outcome.updated).toBe(false);
    expect(outcome.topup.status).toBe("rejected");
    const t = requireTestDb();
    const row = (await t.select().from(walletTopups).where(eq(walletTopups.id, topup.id)))[0];
    expect(row.status).toBe("rejected");
    expect(await balanceOf(f.user.id)).toBeCloseTo(0.0, 2);
  });

  it("S6-W6: CANCELLED -> late OCR error staging -> stays cancelled", async () => {
    const f = await newFixture();
    const topup = await createPendingTopup(f.user.id);
    f.topupIds.push(topup.id);
    // synthetic terminal state (no dedicated cancel endpoint in db.ts)
    const t = requireTestDb();
    await t.update(walletTopups).set({ status: "cancelled" }).where(eq(walletTopups.id, topup.id));

    const outcome = await db.updateWalletTopupWithOCRApproval(topup.id, {
      status: "pending_review",
      reviewReason: "OCR_PROCESSING_ERROR",
    });

    expect(outcome.updated).toBe(false);
    expect(outcome.topup.status).toBe("cancelled");
    const row = (await t.select().from(walletTopups).where(eq(walletTopups.id, topup.id)))[0];
    expect(row.status).toBe("cancelled");
  });

  it("S6-W7: duplicate sequential approval -> no extra ledger, log, balance or event", async () => {
    const f = await newFixture();
    const topup = await createPendingTopup(f.user.id);
    f.topupIds.push(topup.id);
    await db.approveWalletTopup(topup.id, 9001);

    const t = requireTestDb();
    const before = {
      balance: await balanceOf(f.user.id),
      ledger: await scalar(
        t,
        t
          .select({ c: count() })
          .from(walletTransactions)
          .where(and(eq(walletTransactions.userId, f.user.id), eq(walletTransactions.referenceId, topup.id)))
      ),
      events: await scalar(
        t,
        t
          .select({ c: count() })
          .from(notificationEvents)
          .where(and(eq(notificationEvents.kind, "wallet_topup_approved"), eq(notificationEvents.sourceId, String(topup.id))))
      ),
    };

    await expect(db.approveWalletTopup(topup.id, 9002)).rejects.toThrow(/already processed/i);

    expect(await balanceOf(f.user.id)).toBeCloseTo(before.balance, 2);
    expect(
      await scalar(
        t,
        t
          .select({ c: count() })
          .from(walletTransactions)
          .where(and(eq(walletTransactions.userId, f.user.id), eq(walletTransactions.referenceId, topup.id)))
      )
    ).toBe(before.ledger);
    expect(
      await scalar(
        t,
        t
          .select({ c: count() })
          .from(notificationEvents)
          .where(and(eq(notificationEvents.kind, "wallet_topup_approved"), eq(notificationEvents.sourceId, String(topup.id))))
      )
    ).toBe(before.events);
  });

  it("S6-W8: OCR staging helper cannot write 'approved' even against the real database", async () => {
    const f = await newFixture();
    const topup = await createPendingTopup(f.user.id);
    f.topupIds.push(topup.id);

    await expect(
      db.updateWalletTopupWithOCRApproval(topup.id, { status: "approved" as never })
    ).rejects.toThrow(/OCR staging-only/);

    const t = requireTestDb();
    const row = (await t.select().from(walletTopups).where(eq(walletTopups.id, topup.id)))[0];
    expect(row.status).toBe("pending");
    expect(await balanceOf(f.user.id)).toBeCloseTo(0.0, 2);
  });

  it("S6-W9: mysql2 driver affectedRows reflects CAS winner/loser exactly", async () => {
    const f = await newFixture();
    const winnerTopup = await createPendingTopup(f.user.id);
    f.topupIds.push(winnerTopup.id);
    const settledTopup = await createPendingTopup(f.user.id);
    f.topupIds.push(settledTopup.id);
    await db.approveWalletTopup(settledTopup.id, 9001);

    const conn = await mysql.createConnection(process.env.TEST_DATABASE_URL!);
    try {
      const [winnerResult] = await conn.query(
        "UPDATE walletTopups SET updatedAt = updatedAt WHERE id = ? AND status IN ('pending','pending_review')",
        [winnerTopup.id]
      );
      expect((winnerResult as any).affectedRows).toBe(1);

      const [loserResult] = await conn.query(
        "UPDATE walletTopups SET updatedAt = updatedAt WHERE id = ? AND status IN ('pending','pending_review')",
        [settledTopup.id]
      );
      expect((loserResult as any).affectedRows).toBe(0);

      const [cancelledResult] = await conn.query(
        "UPDATE walletTopups SET updatedAt = updatedAt WHERE id = ? AND status IN ('pending','pending_review')",
        [settledTopup.id + 999999]
      );
      expect((cancelledResult as any).affectedRows).toBe(0);
    } finally {
      await conn.end();
    }
  });
});
