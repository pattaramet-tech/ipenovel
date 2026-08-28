import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import * as db from "./db";
import { getTestDb } from "./test-helpers/testDb";
import { createTestUser, createTestOrder, deleteFixtures } from "./test-helpers/fixtures";
import { pointsTransactions, orderHistory } from "../drizzle/schema";

/**
 * IPE-003-C02 - the two P2 independent-review blockers, exercised against a
 * real disposable test database so the checks cannot pass by comparing two
 * lists derived from the same recovery inventory:
 *
 *   1. getAccountMergePointsBalance must use the CANONICAL production
 *      chronology `(createdAt DESC, id DESC)` - not `id DESC` alone - so an
 *      imported/backfilled ledger whose id order differs from its
 *      chronological order still projects the production balance.
 *   2. findAccountMergeTableInventory must count orderHistory (a per-order
 *      audit table with no direct userId column) as an INDIRECT relation,
 *      via orderId -> orders.userId, with a real join and a real row count.
 *
 * This file lives in the integration project (vitest.integration.config.ts),
 * whose globalSetup refuses to run without a verified disposable
 * `ipenovel_test` database - it never silently no-ops.
 */

function requireIntegrationDb() {
  if (!process.env.TEST_DATABASE_URL) {
    throw new Error(
      "accountMergePreview.integration.test.ts requires a prepared disposable test database " +
        "(TEST_DATABASE_URL pointing at ipenovel_test). Run `pnpm test:db:prepare` first."
    );
  }
  return getTestDb();
}

describe.sequential("IPE-003 P2-1 - account-merge points balance uses canonical ledger chronology", () => {
  it("an imported/backfilled row with a GREATER id but an EARLIER createdAt does not win - the latest createdAt does", async () => {
    const t = requireIntegrationDb();
    const user = await createTestUser();

    // Inserted first -> smaller id. This is the chronologically latest row.
    await t.insert(pointsTransactions).values({
      userId: user.id, type: "earn", amount: "100.00", balanceAfter: "100.00",
      referenceType: "ipe003_test", referenceId: 1,
      createdAt: new Date("2026-07-01T00:00:00Z"),
    });
    // Inserted second -> GREATER id, but backfilled with an OLDER createdAt,
    // exactly the import scenario the P2 finding calls out.
    await t.insert(pointsTransactions).values({
      userId: user.id, type: "adjust", amount: "899.99", balanceAfter: "999.99",
      referenceType: "ipe003_test", referenceId: 2,
      createdAt: new Date("2026-06-01T00:00:00Z"),
    });

    const rows = await t.select().from(pointsTransactions).where(eq(pointsTransactions.userId, user.id));
    const greatestIdBalance = rows.reduce((a: any, b: any) => (b.id > a.id ? b : a)).balanceAfter.toString();
    expect(greatestIdBalance).toBe("999.99"); // precondition: id-only ordering WOULD pick this

    const balance = await db.getAccountMergePointsBalance(user.id);
    expect(balance).toBe("100.00");
    expect(balance).not.toBe(greatestIdBalance);

    await t.delete(pointsTransactions).where(eq(pointsTransactions.userId, user.id));
    await deleteFixtures({ userIds: [user.id] });
  }, 30000);

  it("same createdAt second -> the greater id is the tiebreak winner", async () => {
    const t = requireIntegrationDb();
    const user = await createTestUser();
    const sharedCreatedAt = new Date("2026-07-22T09:00:00Z");

    await t.insert(pointsTransactions).values({
      userId: user.id, type: "earn", amount: "10.00", balanceAfter: "10.00",
      referenceType: "ipe003_test", referenceId: 3, createdAt: sharedCreatedAt,
    });
    await t.insert(pointsTransactions).values({
      userId: user.id, type: "earn", amount: "10.00", balanceAfter: "20.00",
      referenceType: "ipe003_test", referenceId: 4, createdAt: sharedCreatedAt,
    });

    expect(await db.getAccountMergePointsBalance(user.id)).toBe("20.00");

    await t.delete(pointsTransactions).where(eq(pointsTransactions.userId, user.id));
    await deleteFixtures({ userIds: [user.id] });
  }, 30000);

  it("normal in-order ledger still reads the latest balanceAfter", async () => {
    const t = requireIntegrationDb();
    const user = await createTestUser();

    await t.insert(pointsTransactions).values({
      userId: user.id, type: "earn", amount: "5.00", balanceAfter: "5.00",
      referenceType: "ipe003_test", referenceId: 5, createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    await t.insert(pointsTransactions).values({
      userId: user.id, type: "earn", amount: "7.00", balanceAfter: "12.00",
      referenceType: "ipe003_test", referenceId: 6, createdAt: new Date("2026-02-01T00:00:00Z"),
    });

    expect(await db.getAccountMergePointsBalance(user.id)).toBe("12.00");
    expect(await db.getAccountMergePointsBalance(user.id + 999_999)).toBe("0.00");

    await t.delete(pointsTransactions).where(eq(pointsTransactions.userId, user.id));
    await deleteFixtures({ userIds: [user.id] });
  }, 30000);
});

describe.sequential("IPE-003 P2-2 - orderHistory is inventoried as an indirect relation via orders.userId", () => {
  it("counts the source's and target's own order-history rows through a real join, category indirect_economic", async () => {
    const t = requireIntegrationDb();
    const source = await createTestUser();
    const target = await createTestUser();
    const other = await createTestUser(); // noise - must never be counted

    const sourceOrder = await createTestOrder(source.id);
    const targetOrder = await createTestOrder(target.id);
    const otherOrder = await createTestOrder(other.id);

    // 2 history rows on the source's order, 1 on the target's, 3 unrelated.
    for (const [orderId, action] of [
      [sourceOrder.id, "created"],
      [sourceOrder.id, "approved"],
      [targetOrder.id, "created"],
      [otherOrder.id, "created"],
      [otherOrder.id, "approved"],
      [otherOrder.id, "cancelled"],
    ] as const) {
      await t.insert(orderHistory).values({ orderId, action });
    }

    const findings = await db.findAccountMergeTableInventory(source.id, target.id);
    const oh = findings.find((f) => f.table === "orderHistory");

    expect(oh).toBeDefined();
    expect(oh!.category).toBe("indirect_economic");
    expect(oh!.sourceCount).toBe(2);
    expect(oh!.targetCount).toBe(1);
    expect(oh!.conflictCount).toBe(0); // indirect tables never carry a dedupe conflict count

    await t.delete(orderHistory).where(eq(orderHistory.orderId, sourceOrder.id));
    await t.delete(orderHistory).where(eq(orderHistory.orderId, targetOrder.id));
    await t.delete(orderHistory).where(eq(orderHistory.orderId, otherOrder.id));
    await deleteFixtures({
      orderIds: [sourceOrder.id, targetOrder.id, otherOrder.id],
      userIds: [source.id, target.id, other.id],
    });
  }, 30000);
});
