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

    it("approval can take the points mutex while Recheck shares the account guard and waits on payment", async () => {
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
          undefined
        );
        approvalHasCanonicalLocks.resolve();

        await exercisePointsRelock.promise;
        // finalizeOrderCompletion reaches the dedicated points mutex later in
        // the same approval transaction. A concurrent Recheck may already
        // share the account guard, but it must not block this independent
        // balance lock while it waits on the payment row.
        await db.assertAccountMergePointsMutationAllowed(user.id, tx);
        pointsRelockCompleted.resolve();
        await releaseApproval.promise;
      });

      await approvalHasCanonicalLocks.promise;

      let recheckHasSharedAccountGuard = false;
      const recheck = database.transaction(async (tx: any) => {
        await db.assertAccountMergeClassifiedMutationAllowed(user.id, tx);
        recheckHasSharedAccountGuard = true;
        await db.lockPaymentForUpdate(payment.id, tx);
      });

      try {
        // Both paths can share ACCOUNT_GUARD. Recheck then waits on the
        // approval-owned payment row, while approval remains free to acquire
        // the distinct pointsAccounts mutex: no users-row lock upgrade and no
        // opposite half of a cycle.
        expect(await settlesWithin(
          (async () => {
            while (!recheckHasSharedAccountGuard) {
              await new Promise(resolve => setTimeout(resolve, 10));
            }
          })(),
          500
        )).toBe(true);

        exercisePointsRelock.resolve();
        expect(await settlesWithin(pointsRelockCompleted.promise, 500)).toBe(
          true
        );
      } finally {
        releaseApproval.resolve();
        await approval;
        await recheck;
      }

      expect(recheckHasSharedAccountGuard).toBe(true);
    }, 30_000);

    it("a wallet-style shared account guard does not block the dedicated order points mutex", async () => {
      const user = await createTestUser();
      const order = await createTestOrder(user.id);
      const payment = await createTestPayment(order.id);
      fixtures.push({ userId: user.id, orderId: order.id, paymentId: payment.id });

      const database = await db.getDb();
      if (!database) throw new Error("Database unavailable");

      const walletHasSharedGuard = deferred();
      const releaseWallet = deferred();
      let orderHasPointsLock = false;

      const wallet = database.transaction(async (tx: any) => {
        // Exact users-row guard used at the start of approveWalletTopup.
        await db.assertAccountMergeClassifiedMutationAllowed(user.id, tx);
        walletHasSharedGuard.resolve();
        await releaseWallet.promise;
      });

      await walletHasSharedGuard.promise;

      const orderApproval = database.transaction(async (tx: any) => {
        await db.assertAccountMergePointsMutationAllowed(user.id, tx);
        orderHasPointsLock = true;
      });

      try {
        expect(await settlesWithin(orderApproval, 500)).toBe(true);
        expect(orderHasPointsLock).toBe(true);
      } finally {
        releaseWallet.resolve();
        await wallet;
        await orderApproval;
      }

      expect(orderHasPointsLock).toBe(true);
    }, 30_000);
  }
);
