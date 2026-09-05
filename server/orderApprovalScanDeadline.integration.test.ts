import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  accountMutationGuards, couponUsages, orderHistory, orders, payments,
  paymentSlipClaims, pointsAccounts, pointsTransactions, purchases, users,
} from "../drizzle/schema";
import * as db from "./db";
import * as execution from "./helpers/orderApprovalExecution";
import { approvePayment } from "./services/orderService";
import * as slipBackfillStateService from "./services/slipBackfillStateService";
import * as slipFileHashService from "./services/slipFileHashService";
import { createTestOrder, createTestPayment, createTestUser } from "./test-helpers/fixtures";
import { closeTestDb, ensureVerifiedTestDb, getTestDb } from "./test-helpers/testDb";

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

// A test-only watchdog, never an application transaction timeout. Every
// operation is also awaited in finally before fixture cleanup can begin.
async function bounded<T>(operation: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Deadline regression barrier timed out: ${label}`)), 5_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
type Payment = typeof payments.$inferSelect;
type Order = typeof orders.$inferSelect;
type Fixtures = {
  userId: number;
  payment: Payment;
  order: Order;
  currentHash: string;
  historicalRefs: string[];
};

async function withFixtures(run: (fixture: Fixtures) => Promise<void>) {
  const testDb = getTestDb();
  const user = await createTestUser();
  const orderIds: number[] = [];
  const paymentIds: number[] = [];
  const tag = randomUUID();
  const currentHash = slipFileHashService.hashSlipBytes(Buffer.from(`current-${tag}`));
  const historicalRefs: string[] = [];
  try {
    for (let index = 0; index < 3; index += 1) {
      const order = await createTestOrder(user.id);
      orderIds.push(order.id);
      const payment = await createTestPayment(order.id);
      paymentIds.push(payment.id);
      const ref = `r2p:payment-slips/${user.id}/deadline-${tag}-${index}.png`;
      if (index > 0) historicalRefs.push(ref);
      await testDb.update(payments).set({
        status: index === 0 ? "pending_review" : "approved",
        slipImageUrl: ref,
        slipSubmittedAt: new Date("2026-09-01T00:00:00Z"),
        extractedData: index === 0
          ? JSON.stringify({ fileHash: currentHash, referenceRaw: `Deadline-${tag}` })
          : null,
        evidenceVersion: 1,
        extractedEvidenceVersion: index === 0 ? 1 : null,
      }).where(eq(payments.id, payment.id));
    }
    const payment = (await db.getPaymentById(paymentIds[0]))!;
    const order = (await db.getOrderById(orderIds[0]))!;
    await run({ userId: user.id, payment, order, currentHash, historicalRefs });
  } finally {
    vi.restoreAllMocks();
    await testDb.transaction(async (tx) => {
      for (const paymentId of paymentIds) {
        await tx.delete(paymentSlipClaims).where(and(
          eq(paymentSlipClaims.sourceType, "order_payment"), eq(paymentSlipClaims.sourceId, paymentId)
        ));
      }
      for (const orderId of orderIds) {
        await tx.delete(orderHistory).where(eq(orderHistory.orderId, orderId));
        await tx.delete(purchases).where(eq(purchases.orderId, orderId));
        await tx.delete(couponUsages).where(eq(couponUsages.orderId, orderId));
      }
      await tx.delete(pointsTransactions).where(eq(pointsTransactions.userId, user.id));
      for (const paymentId of paymentIds) await tx.delete(payments).where(eq(payments.id, paymentId));
      for (const orderId of orderIds) await tx.delete(orders).where(eq(orders.id, orderId));
      await tx.delete(pointsAccounts).where(eq(pointsAccounts.userId, user.id));
      await tx.delete(accountMutationGuards).where(eq(accountMutationGuards.userId, user.id));
      await tx.delete(users).where(eq(users.id, user.id));
    });
  }
}

function controlledBudget() {
  let clock = 0;
  const realCreateBudget = execution.createOrderApprovalVerificationBudget;
  vi.spyOn(execution, "createOrderApprovalVerificationBudget").mockImplementation(() =>
    realCreateBudget({ timeoutMs: 100, now: () => clock })
  );
  return { expire: () => { clock = 101; } };
}

async function expectNoFinancialEffects(fixture: Fixtures) {
  const testDb = getTestDb();
  expect(await db.getPaymentById(fixture.payment.id)).toEqual(fixture.payment);
  expect(await db.getOrderById(fixture.order.id)).toEqual(fixture.order);
  expect(await testDb.select().from(paymentSlipClaims).where(and(
    eq(paymentSlipClaims.sourceType, "order_payment"), eq(paymentSlipClaims.sourceId, fixture.payment.id)
  ))).toEqual([]);
  expect(await testDb.select().from(orderHistory).where(eq(orderHistory.orderId, fixture.order.id))).toEqual([]);
  expect(await testDb.select().from(pointsTransactions).where(eq(pointsTransactions.userId, fixture.userId))).toEqual([]);
  expect(await db.getUserPointsBalance(fixture.userId)).toBe("0.00");
  expect(await testDb.select().from(purchases).where(eq(purchases.orderId, fixture.order.id))).toEqual([]);
  expect(await testDb.select().from(couponUsages).where(eq(couponUsages.orderId, fixture.order.id))).toEqual([]);
}

describe.sequential("order approval historical-scan deadline releases real transaction locks", () => {
  beforeAll(async () => {
    // Stricter than the shared URL/live-name guard: this concurrency regression
    // is deliberately confined to the known disposable developer-machine DB.
    const url = new URL(process.env.TEST_DATABASE_URL ?? "");
    expect(url.hostname).toBe("127.0.0.1");
    expect(url.pathname).toBe("/ipenovel_test");
    expect(await db.getDb()).toBe(await ensureVerifiedTestDb());
  });

  afterAll(async () => {
    db.__setDbForTests(null);
    await closeTestDb();
  });

  it("executes the backfill current shared read on the supplied real transaction", async () => {
    const pooledRead = vi.spyOn(db, "getSetting").mockRejectedValue(new Error("No second pool lease allowed"));
    try {
      const state = await getTestDb().transaction((tx) => slipBackfillStateService.getSlipBackfillState(tx));
      expect(typeof state.complete).toBe("boolean");
      expect(pooledRead).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it.each([false, true])(
    "expires a finite slow historical scan, rolls back, and releases the payment lock (borrowed transaction: %s)",
    async (borrowedTransaction) => {
      await withFixtures(async (fixture) => {
        const budget = controlledBudget();
        const historicalHashStarted = barrier();
        const allowHistoricalHashToFinish = barrier();
        const competitorStarted = barrier();
        let hashInFlight = false;
        let approvalSettled = false;
        let competitorAcquired = false;
        let approval: Promise<unknown> | undefined;
        let competitor: Promise<unknown> | undefined;
        const fetchedRefs: string[] = [];
        const unrelatedHash = slipFileHashService.hashSlipBytes(Buffer.from(`unrelated-${randomUUID()}`));

        try {
          vi.spyOn(slipBackfillStateService, "isLegacyScanRequired").mockResolvedValue(true);
          const hash = async (ref: string | null | undefined): Promise<string> => {
            if (typeof ref !== "string") throw new Error("Expected a persisted synthetic slip reference");
            fetchedRefs.push(ref);
            if (ref === fixture.payment.slipImageUrl) return fixture.currentHash;
            if (ref === fixture.historicalRefs[0]) {
              hashInFlight = true;
              historicalHashStarted.release();
              await bounded(allowHistoricalHashToFinish.promise, "finish finite historical byte read");
              hashInFlight = false;
            }
            // Other historical rows remain real DB scan inputs. Substituting
            // their external bytes keeps this test offline without mutating,
            // deleting, or fabricating any unrelated database records.
            return unrelatedHash;
          };
          vi.spyOn(slipFileHashService, "computeSlipFileHash").mockImplementation(hash);
          vi.spyOn(slipFileHashService, "computeTrustedLegacySlipFileHash").mockImplementation(hash);

          approval = (borrowedTransaction
            ? getTestDb().transaction(async (tx) => {
                // A write made before approval proves the caller-owned
                // transaction really rolls back, not just that no later
                // financial statements happened to run.
                await tx.update(orders).set({ notes: "transaction-only deadline sentinel" })
                  .where(eq(orders.id, fixture.order.id));
                return approvePayment(fixture.payment.id, String(fixture.userId), "Synthetic admin", tx);
              }, { isolationLevel: "repeatable read" })
            : approvePayment(fixture.payment.id, String(fixture.userId), "Synthetic admin")
          ).then(
            (value) => { approvalSettled = true; return { value }; },
            (error: unknown) => { approvalSettled = true; return { error }; }
          );
          await bounded(Promise.race([
            historicalHashStarted.promise,
            approval.then(() => { throw new Error("Approval finished before reaching the historical byte read"); }),
          ]), "historical scan holds canonical payment lock");

          competitor = getTestDb().transaction(async (tx) => {
            const pendingLock = db.lockPaymentForUpdate(fixture.payment.id, tx);
            competitorStarted.release();
            await pendingLock;
            competitorAcquired = true;
            expect(hashInFlight).toBe(false);
            return db.getPaymentByIdForUpdate(fixture.payment.id, tx);
          }, { isolationLevel: "repeatable read" });
          void competitor.catch(() => {});
          await bounded(competitorStarted.promise, "competing payment lock starts");
          budget.expire();
          // Let an incorrectly detached transaction timeout surface while
          // finite I/O is still pending. The cooperative implementation must
          // await that operation, then throw and roll back before replying.
          await delay(150);
          expect(approvalSettled).toBe(false);
          expect(competitorAcquired).toBe(false);
          allowHistoricalHashToFinish.release();

          const outcome = await bounded(approval, "approval rolls back on exhausted budget") as { error?: unknown };
          expect(outcome.error).toMatchObject({ code: "ORDER_PAYMENT_VERIFICATION_TIMEOUT" });
          expect(await bounded(competitor, "competing lock acquired after rollback")).toEqual(fixture.payment);
          expect(competitorAcquired).toBe(true);
          expect(fetchedRefs).toContain(fixture.historicalRefs[0]);
          expect(fetchedRefs).not.toContain(fixture.historicalRefs[1]);
          await expectNoFinancialEffects(fixture);
        } finally {
          allowHistoricalHashToFinish.release();
          await Promise.allSettled([approval, competitor].filter((task): task is Promise<any> => Boolean(task)));
        }
      });
    }
  );

  it("a historical exact-byte duplicate still fails closed while within budget", async () => {
    await withFixtures(async (fixture) => {
      controlledBudget();
      vi.spyOn(slipBackfillStateService, "isLegacyScanRequired").mockResolvedValue(true);
      const unrelatedHash = slipFileHashService.hashSlipBytes(Buffer.from(`other-${randomUUID()}`));
      const hash = async (ref: string | null | undefined) => ref === fixture.payment.slipImageUrl || ref === fixture.historicalRefs[0]
        ? fixture.currentHash
        : unrelatedHash;
      vi.spyOn(slipFileHashService, "computeSlipFileHash").mockImplementation(hash);
      vi.spyOn(slipFileHashService, "computeTrustedLegacySlipFileHash").mockImplementation(hash);

      await expect(approvePayment(fixture.payment.id, String(fixture.userId), "Synthetic admin"))
        .rejects.toThrow("SLIP_ALREADY_CLAIMED");
      await expectNoFinancialEffects(fixture);
    });
  });

  it("within-budget registry approval commits one claim, history entry, and reward", async () => {
    await withFixtures(async (fixture) => {
      controlledBudget();
      const trace = vi.spyOn(console, "info").mockImplementation(() => {});
      // A read-only readiness substitution covers the indexed path without
      // changing the global backfill setting or requiring unrelated legacy
      // test fixtures to have complete file evidence.
      vi.spyOn(slipBackfillStateService, "isLegacyScanRequired").mockResolvedValue(false);
      vi.spyOn(slipFileHashService, "computeSlipFileHash").mockImplementation(async (ref) => {
        expect(ref).toBe(fixture.payment.slipImageUrl);
        return fixture.currentHash;
      });

      await approvePayment(fixture.payment.id, String(fixture.userId), "Synthetic admin");
      const records = trace.mock.calls.flatMap(([line]) => typeof line === "string" && line.startsWith("[OrderPaymentApprovalExecution] ")
        ? [JSON.parse(line.slice("[OrderPaymentApprovalExecution] ".length))] : []);
      const settled = records.at(-1);
      expect(settled).toMatchObject({ event: "run_end", outcome: "committed", paymentId: fixture.payment.id });
      expect(Number.isSafeInteger(settled.connectionId)).toBe(true);
      expect(settled.connectionId).toBeGreaterThan(0);
      expect(records.filter((record) => record.stage === "payment_lock")).toEqual(expect.arrayContaining([
        expect.objectContaining({ event: "stage_start", connectionId: settled.connectionId, runId: settled.runId }),
        expect.objectContaining({ event: "stage_end", connectionId: settled.connectionId, runId: settled.runId }),
      ]));
      const testDb = getTestDb();
      expect(await db.getPaymentById(fixture.payment.id)).toMatchObject({ status: "approved" });
      expect(await db.getOrderById(fixture.order.id)).toMatchObject({ status: "approved", paymentStatus: "approved" });
      const claims = await testDb.select().from(paymentSlipClaims).where(and(
        eq(paymentSlipClaims.sourceType, "order_payment"), eq(paymentSlipClaims.sourceId, fixture.payment.id)
      ));
      expect(claims).toHaveLength(1);
      expect(claims[0].fileHash).toBe(fixture.currentHash);
      const history = await testDb.select().from(orderHistory).where(eq(orderHistory.orderId, fixture.order.id));
      expect(history).toHaveLength(1);
      expect(history[0].action).toBe("payment_approved");
      const rewards = await testDb.select().from(pointsTransactions).where(eq(pointsTransactions.userId, fixture.userId));
      expect(rewards).toHaveLength(1);
      expect(rewards[0]).toMatchObject({
        type: "earn", referenceType: "order", referenceId: fixture.order.id,
        effectKey: `order:${fixture.order.id}:earn`,
      });
      expect(Number(rewards[0].amount)).toBeGreaterThan(0);
      expect(rewards[0].balanceAfter).toBe(rewards[0].amount);
      expect(await db.getUserPointsBalance(fixture.userId)).toBe(rewards[0].amount);
      expect(await testDb.select().from(purchases).where(eq(purchases.orderId, fixture.order.id))).toEqual([]);
      expect(await testDb.select().from(couponUsages).where(eq(couponUsages.orderId, fixture.order.id))).toEqual([]);
    });
  });
});
