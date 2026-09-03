import { afterEach, beforeAll, describe, expect, it } from "vitest";
import * as db from "./db";
import * as orderService from "./services/orderService";
import { getTestDb } from "./test-helpers/testDb";
import { assertSafeTestDatabaseUrl } from "./test-helpers/testDatabaseGuard";
import { assertLiveTestDatabaseName } from "./test-helpers/liveTestDatabaseCheck";
import {
  createTestOrder,
  createTestPayment,
  createTestUser,
  deleteFixtures,
} from "./test-helpers/fixtures";

type Fixture = { userId: number; orderId: number; paymentId: number };

const fixtures: Fixture[] = [];

function requireTestDb() {
  if (!process.env.TEST_DATABASE_URL) {
    throw new Error(
      "IPE-020 integration tests require TEST_DATABASE_URL=.../ipenovel_test"
    );
  }
  return getTestDb();
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

async function settlesWithin(
  promise: Promise<unknown>,
  timeoutMs: number
): Promise<boolean> {
  return Promise.race([
    promise.then(() => true),
    new Promise<boolean>(resolve =>
      setTimeout(() => resolve(false), timeoutMs)
    ),
  ]);
}

describe.sequential(
  "IPE-020 order approval lock ordering - real database",
  () => {
    beforeAll(async () => {
      assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);
      await assertLiveTestDatabaseName(getTestDb());
    });

    afterEach(async () => {
      while (fixtures.length > 0) {
        const fixture = fixtures.pop()!;
        await deleteFixtures({
          paymentIds: [fixture.paymentId],
          orderIds: [fixture.orderId],
          userIds: [fixture.userId],
        });
      }
    });

    it("approval owns the exclusive user lock before payment, so Recheck cannot form the opposite half of a cycle", async () => {
      const user = await createTestUser();
      const order = await createTestOrder(user.id);
      const payment = await createTestPayment(order.id);
      fixtures.push({
        userId: user.id,
        orderId: order.id,
        paymentId: payment.id,
      });

      const database = await db.getDb();
      if (!database) throw new Error("Database unavailable");

      const approvalHasCanonicalLocks = deferred();
      const exercisePointsRelock = deferred();
      const pointsRelockCompleted = deferred();
      const releaseApproval = deferred();

      const approval = database.transaction(async (tx: any) => {
        await orderService.lockAndRequireReviewablePayment(
          payment.id,
          tx,
          undefined,
          "points_exclusive"
        );
        approvalHasCanonicalLocks.resolve();

        await exercisePointsRelock.promise;
        // finalizeOrderCompletion reaches this lock later in the same approval
        // transaction. It must be a re-entrant exclusive acquisition, never a
        // shared -> exclusive upgrade after the payment row is already owned.
        await db.lockUserForPoints(user.id, tx);
        pointsRelockCompleted.resolve();
        await releaseApproval.promise;
      });

      await approvalHasCanonicalLocks.promise;

      let recheckHasSharedUserLock = false;
      const recheck = database.transaction(async (tx: any) => {
        await db.assertAccountMergeClassifiedMutationAllowed(user.id, tx);
        recheckHasSharedUserLock = true;
        await db.lockPaymentForUpdate(payment.id, tx);
      });

      try {
        // Recheck must wait at the FIRST lock (user), not acquire a shared user
        // lock and then wait at payment while approval later waits to upgrade
        // that same user row.
        await new Promise(resolve => setTimeout(resolve, 100));
        expect(recheckHasSharedUserLock).toBe(false);

        exercisePointsRelock.resolve();
        expect(await settlesWithin(pointsRelockCompleted.promise, 500)).toBe(
          true
        );
      } finally {
        releaseApproval.resolve();
        await approval;
        await recheck;
      }

      expect(recheckHasSharedUserLock).toBe(true);
    }, 30_000);

    it("a wallet-style shared users-row guard blocks order points exclusivity until the wallet transaction releases", async () => {
      const user = await createTestUser();
      const order = await createTestOrder(user.id);
      const payment = await createTestPayment(order.id);
      fixtures.push({ userId: user.id, orderId: order.id, paymentId: payment.id });

      const database = await db.getDb();
      if (!database) throw new Error("Database unavailable");

      const walletHasSharedGuard = deferred();
      const releaseWallet = deferred();
      let orderHasExclusiveUserLock = false;

      const wallet = database.transaction(async (tx: any) => {
        // Exact users-row guard used at the start of approveWalletTopup.
        await db.assertAccountMergeClassifiedMutationAllowed(user.id, tx);
        walletHasSharedGuard.resolve();
        await releaseWallet.promise;
      });

      await walletHasSharedGuard.promise;

      const orderApproval = database.transaction(async (tx: any) => {
        await db.assertAccountMergePointsMutationAllowed(user.id, tx);
        orderHasExclusiveUserLock = true;
      });

      try {
        await new Promise(resolve => setTimeout(resolve, 100));
        expect(orderHasExclusiveUserLock).toBe(false);
      } finally {
        releaseWallet.resolve();
        await wallet;
        await orderApproval;
      }

      expect(orderHasExclusiveUserLock).toBe(true);
    }, 30_000);
  }
);
