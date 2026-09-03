import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { pointsAccounts, pointsTransactions } from "../drizzle/schema";
import * as db from "./db";
import { getTestDb } from "./test-helpers/testDb";
import { assertSafeTestDatabaseUrl } from "./test-helpers/testDatabaseGuard";
import { assertLiveTestDatabaseName } from "./test-helpers/liveTestDatabaseCheck";
import { createTestUser, deleteFixtures } from "./test-helpers/fixtures";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const userIds: number[] = [];

describe.sequential("IPE-021-D / 0046 pointsAccounts concurrency - real database", () => {
  beforeAll(async () => {
    assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);
    await assertLiveTestDatabaseName(getTestDb());
  });

  afterEach(async () => {
    if (userIds.length) {
      await deleteFixtures({ userIds: userIds.splice(0) });
    }
  });

  it("two concurrent points writers serialize on pointsAccounts with no lost update", async () => {
    const user = await createTestUser();
    userIds.push(user.id);

    const firstHasLock = deferred();
    const releaseFirst = deferred();
    let secondEntered = false;

    const first = db.withUserPointsLock(user.id, undefined, async (tx) => {
      const before = Number(await db.getUserPointsBalance(user.id, tx));
      firstHasLock.resolve();
      await releaseFirst.promise;
      await db.recordPointsTransaction(
        {
          userId: user.id,
          type: "earn",
          amount: "1.00",
          balanceAfter: (before + 1).toFixed(2),
          referenceType: "ipe021_points_concurrency",
          referenceId: 1,
          effectKey: "ipe021:concurrency:first",
        },
        tx
      );
    });

    await firstHasLock.promise;
    const second = db.withUserPointsLock(user.id, undefined, async (tx) => {
      secondEntered = true;
      const before = Number(await db.getUserPointsBalance(user.id, tx));
      await db.recordPointsTransaction(
        {
          userId: user.id,
          type: "earn",
          amount: "2.00",
          balanceAfter: (before + 2).toFixed(2),
          referenceType: "ipe021_points_concurrency",
          referenceId: 2,
          effectKey: "ipe021:concurrency:second",
        },
        tx
      );
    });

    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(secondEntered).toBe(false);
    releaseFirst.resolve();
    await Promise.all([first, second]);

    expect(await db.getUserPointsBalance(user.id)).toBe("3.00");
    const account = (await getTestDb().select().from(pointsAccounts).where(eq(pointsAccounts.userId, user.id)))[0];
    expect(Number(account.version)).toBe(2);
  }, 30000);

  it("holding the points mutex no longer blocks another ordinary shared account mutation", async () => {
    const user = await createTestUser();
    userIds.push(user.id);
    const database = await db.getDb();
    if (!database) throw new Error("Database unavailable");

    const pointsHasLock = deferred();
    const releasePoints = deferred();
    const pointsTx = database.transaction(async (tx: any) => {
      await db.lockUserForPoints(user.id, tx);
      pointsHasLock.resolve();
      await releasePoints.promise;
    });

    await pointsHasLock.promise;
    let sharedCompleted = false;
    const sharedTx = database.transaction(async (tx: any) => {
      await db.assertAccountMergeClassifiedMutationAllowed(user.id, tx);
      sharedCompleted = true;
    });

    try {
      const completedWhilePointsLocked = await Promise.race([
        sharedTx.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500)),
      ]);
      expect(completedWhilePointsLocked).toBe(true);
      expect(sharedCompleted).toBe(true);
    } finally {
      releasePoints.resolve();
    }
    await pointsTx;
  }, 30000);

  it("duplicate effectKey rolls the losing balance update back with the ledger insert", async () => {
    const user = await createTestUser();
    userIds.push(user.id);
    const effectKey = "ipe021:duplicate:effect";

    const apply = () =>
      db.withUserPointsLock(user.id, undefined, async (tx) => {
        const before = Number(await db.getUserPointsBalance(user.id, tx));
        await db.recordPointsTransaction(
          {
            userId: user.id,
            type: "earn",
            amount: "1.00",
            balanceAfter: (before + 1).toFixed(2),
            referenceType: "ipe021_effect_key",
            referenceId: 7,
            effectKey,
          },
          tx
        );
      });

    const results = await Promise.allSettled([apply(), apply()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);

    expect(await db.getUserPointsBalance(user.id)).toBe("1.00");
    const ledger = await getTestDb()
      .select()
      .from(pointsTransactions)
      .where(and(eq(pointsTransactions.userId, user.id), eq(pointsTransactions.effectKey, effectKey)));
    expect(ledger).toHaveLength(1);
    const account = (await getTestDb().select().from(pointsAccounts).where(eq(pointsAccounts.userId, user.id)))[0];
    expect(Number(account.version)).toBe(1);
  }, 30000);
});
