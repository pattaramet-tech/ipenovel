import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  accountMutationGuards, couponUsages, orderHistory, orders, payments,
  paymentSlipClaims, pointsAccounts, pointsTransactions, purchases, users,
} from "../drizzle/schema";
import * as db from "./db";
import { approvePayment, lockAndRequireReviewablePayment, SLIP_INTEGRITY_BLOCK_REASON } from "./services/orderService";
import { deriveStrongIdentifiersFromExtractedData, hasStrongIdentifier } from "./services/slipIdentifierService";
import * as slipFileHashService from "./services/slipFileHashService";
import * as slipBackfillStateService from "./services/slipBackfillStateService";
import { createTestOrder, createTestPayment, createTestUser } from "./test-helpers/fixtures";
import { closeTestDb, ensureVerifiedTestDb, getTestDb } from "./test-helpers/testDb";

// Exercise the actual approval guard and SQL locks with overlapping real
// transactions. Financial effects below belong only to scoped synthetic
// fixtures in the verified disposable database; no object-store access occurs.
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function bounded<T>(operation: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Concurrency barrier timed out: ${label}`)), 5_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const SYNTHETIC_HASH = "d".repeat(64);
const EXTRACTED = JSON.stringify({ fileHash: SYNTHETIC_HASH });
type Payment = typeof payments.$inferSelect;
type PaymentUpdate = Partial<typeof payments.$inferInsert>;

async function withPayment(run: (payment: Payment, ownerUserId: number) => Promise<void>) {
  const testDb = getTestDb();
  const user = await createTestUser();
  let orderId: number | undefined;
  let paymentId: number | undefined;
  try {
    orderId = (await createTestOrder(user.id)).id;
    paymentId = (await createTestPayment(orderId)).id;
    await testDb.update(payments).set({
      slipImageUrl: `r2p:payment-slips/${user.id}/test-current-read.png`,
      slipSubmittedAt: new Date("2026-09-01T00:00:00Z"),
      status: "pending_review",
      extractedData: null,
      evidenceVersion: 1,
    }).where(eq(payments.id, paymentId));
    await run((await db.getPaymentById(paymentId))!, user.id);
  } finally {
    await testDb.transaction(async (tx) => {
      if (paymentId !== undefined) await tx.delete(paymentSlipClaims).where(and(
        eq(paymentSlipClaims.sourceType, "order_payment"), eq(paymentSlipClaims.sourceId, paymentId)
      ));
      if (orderId !== undefined) {
        await tx.delete(orderHistory).where(eq(orderHistory.orderId, orderId));
        await tx.delete(purchases).where(eq(purchases.orderId, orderId));
        await tx.delete(couponUsages).where(eq(couponUsages.orderId, orderId));
      }
      await tx.delete(pointsTransactions).where(eq(pointsTransactions.userId, user.id));
      if (paymentId !== undefined) await tx.delete(payments).where(eq(payments.id, paymentId));
      if (orderId !== undefined) await tx.delete(orders).where(eq(orders.id, orderId));
      await tx.delete(pointsAccounts).where(eq(pointsAccounts.userId, user.id));
      await tx.delete(accountMutationGuards).where(eq(accountMutationGuards.userId, user.id));
      await tx.delete(users).where(eq(users.id, user.id));
    });
  }
}

async function raceCurrentRead(
  initial: Payment,
  ownerUserId: number,
  changes: PaymentUpdate,
  check: (outcome: { payment: Payment } | { error: unknown }, current: Payment) => void
) {
  const testDb = getTestDb();
  const writerUpdated = barrier();
  const allowWriterCommit = barrier();
  const readerReachedLock = barrier();
  let writer: Promise<unknown> | undefined;
  let reader: Promise<{ payment: Payment } | { error: unknown }> | undefined;
  let readerTx: unknown;
  const realGetPayment = db.getPaymentById;
  const realLockPayment = db.lockPaymentForUpdate;
  const readerSelections: Array<Awaited<ReturnType<typeof db.getPaymentById>>> = [];

  try {
    // Forward every argument and execute every real select/lock. The taps
    // expose scheduling barriers; they never fabricate database responses.
    vi.spyOn(db, "getPaymentById").mockImplementation(async (...args) => {
      const row = await realGetPayment(...args);
      if (args[0] === initial.id && args[1] === readerTx) readerSelections.push(row);
      return row;
    });
    vi.spyOn(db, "lockPaymentForUpdate").mockImplementation(async (id, tx) => {
      if (id === initial.id && tx === readerTx) readerReachedLock.release();
      return realLockPayment(id, tx);
    });

    writer = testDb.transaction(async (tx) => {
      await db.assertAccountMergeClassifiedMutationAllowed(ownerUserId, tx);
      await realLockPayment(initial.id, tx);
      await tx.update(payments).set(changes).where(eq(payments.id, initial.id));
      writerUpdated.release();
      await bounded(allowWriterCommit.promise, "release writer commit");
    }, { isolationLevel: "repeatable read" });
    void writer.catch(() => {});
    await bounded(Promise.race([
      writerUpdated.promise,
      writer.then(() => { throw new Error("Writer completed before its update barrier"); }),
    ]), "writer update");

    reader = testDb.transaction(async (tx) => {
      readerTx = tx;
      return lockAndRequireReviewablePayment(initial.id, tx, {
        slipImageUrl: initial.slipImageUrl,
        slipSubmittedAt: initial.slipSubmittedAt,
        evidenceVersion: initial.evidenceVersion,
      });
    }, { isolationLevel: "repeatable read" }).then(
      (payment) => ({ payment }),
      (error: unknown) => ({ error })
    );
    await bounded(Promise.race([
      readerReachedLock.promise,
      reader.then(() => { throw new Error("Reader completed before its subject lock"); }),
    ]), "reader reaches subject lock");

    // The helper itself established the old RR snapshot before waiting for
    // the locked row. Releasing this writer must make its committed state
    // authoritative to the helper's post-lock checks, not the old snapshot.
    expect(readerSelections).toHaveLength(1);
    expect(readerSelections[0]).toEqual(initial);
    allowWriterCommit.release();
    await bounded(writer, "writer commit");
    const outcome = await bounded(reader, "reader finishes");
    const current = (await realGetPayment(initial.id))!;
    expect(current).toMatchObject(changes);
    check(outcome, current);
    expect(await realGetPayment(initial.id)).toEqual(current);
  } finally {
    allowWriterCommit.release();
    await Promise.allSettled([writer, reader].filter((task): task is Promise<any> => Boolean(task)));
    vi.restoreAllMocks();
  }
}

const races: Array<{ name: string; changes: PaymentUpdate; code?: string }> = [
  {
    name: "same-slip Recheck publishes a hash while approval waits",
    changes: { extractedData: EXTRACTED, extractedEvidenceVersion: 1 },
  },
  {
    // Keep URL and timestamp unchanged to prove the monotonic version is
    // checked independently of the other two slip-identity dimensions.
    name: "replacement evidence version invalidates the waiting OCR snapshot",
    changes: { extractedData: EXTRACTED, evidenceVersion: 2, extractedEvidenceVersion: 2 },
    code: "SLIP_VERSION_CHANGED",
  },
  {
    name: "concurrent approval makes the payment non-reviewable",
    changes: { status: "approved" },
    code: "PAYMENT_NOT_REVIEWABLE",
  },
  {
    name: "concurrent rejection makes the payment non-reviewable",
    changes: { status: "rejected" },
    code: "PAYMENT_NOT_REVIEWABLE",
  },
  {
    name: "concurrent Recheck integrity block remains authoritative",
    changes: { reviewReason: SLIP_INTEGRITY_BLOCK_REASON },
    code: "SLIP_INTEGRITY_BLOCKED",
  },
];

describe.sequential("order approval reads current locked payment under REPEATABLE READ", () => {
  beforeAll(async () => {
    // Both URL validation and a live SELECT DATABASE() require ipenovel_test.
    // The integration setup injects this exact verified connection into db.
    expect(await db.getDb()).toBe(await ensureVerifiedTestDb());
  });

  afterAll(async () => {
    db.__setDbForTests(null);
    await closeTestDb();
  });

  it.each(races)("$name", async ({ changes, code }) => {
    await withPayment(async (initial, ownerUserId) => {
      await raceCurrentRead(initial, ownerUserId, changes, (outcome, current) => {
        if (code) {
          expect(outcome).toHaveProperty("error");
          if (!("error" in outcome)) throw new Error("Approval guard accepted stale reviewable state");
          expect(outcome.error).toMatchObject({ code });
        } else {
          expect(outcome).toHaveProperty("payment");
          if (!("payment" in outcome)) throw outcome.error;
          expect(outcome.payment).toEqual(current);
          const derived = deriveStrongIdentifiersFromExtractedData(outcome.payment.extractedData);
          expect(derived.identifiers.fileHash).toBe(SYNTHETIC_HASH);
          expect(hasStrongIdentifier(derived.identifiers)).toBe(true);
          expect(outcome.payment.evidenceVersion).toBe(1);
          expect(outcome.payment.extractedEvidenceVersion).toBe(1);
        }
      });
    });
  });

  it("a fresh transaction reads already-committed extraction and maps timestamps and numeric versions", async () => {
    await withPayment(async (initial) => {
      await getTestDb().update(payments).set({
        extractedData: EXTRACTED,
        evidenceVersion: 2,
        extractedEvidenceVersion: 2,
      }).where(eq(payments.id, initial.id));
      const fresh = await getTestDb().transaction(
        (tx) => lockAndRequireReviewablePayment(initial.id, tx),
        { isolationLevel: "repeatable read" }
      );
      expect(fresh).toEqual(await db.getPaymentById(initial.id));
      expect(fresh.slipSubmittedAt).toBeInstanceOf(Date);
      expect(fresh.evidenceVersion).toBe(2);
      expect(fresh.extractedEvidenceVersion).toBe(2);
      const derived = deriveStrongIdentifiersFromExtractedData(fresh.extractedData);
      expect(derived.identifiers.fileHash).toBe(SYNTHETIC_HASH);
      expect(hasStrongIdentifier(derived.identifiers)).toBe(true);
    });
  });

  it("two overlapping real approvals commit exactly one claim, approval history entry, and points award", async () => {
    await withPayment(async (initial, ownerUserId) => {
      const testDb = getTestDb();
      const uniqueReference = `ApprovalRace-${randomUUID()}`;
      const uniqueHash = slipFileHashService.hashSlipBytes(Buffer.from(uniqueReference));
      await testDb.update(payments).set({
        extractedData: JSON.stringify({ fileHash: uniqueHash, referenceRaw: uniqueReference }),
        extractedEvidenceVersion: initial.evidenceVersion,
      }).where(eq(payments.id, initial.id));
      const order = (await db.getOrderById(initial.orderId))!;
      expect(order.couponCodeSnapshot).toBeNull();
      expect(Number(order.pointsDiscountAmount)).toBe(0);
      expect(Number(order.totalAmount)).toBe(100);
      expect(await db.getOrderItems(order.id)).toEqual([]);

      const firstHashReached = barrier();
      const allowFirstHash = barrier();
      const secondReachedLock = barrier();
      let secondTx: unknown;
      let firstApproval: Promise<{ message: string }> | undefined;
      let secondApproval: Promise<{ message: string }> | undefined;
      const realLockPayment = db.lockPaymentForUpdate;

      try {
        // Only the external byte fetch is substituted. The hash/identifier
        // derivation, collision indexes, claim INSERT, metadata, points and
        // order finalization all execute the real implementation.
        const byteHash = vi.spyOn(slipFileHashService, "computeSlipFileHash").mockImplementation(async (ref) => {
          expect(ref).toBe(initial.slipImageUrl);
          firstHashReached.release();
          await bounded(allowFirstHash.promise, "release first approval byte check");
          return uniqueHash;
        });
        // Isolate this test from unrelated historical fixture coverage without
        // altering any setting. Unique reference + file identifiers still use
        // the real indexed conflict evaluator and real UNIQUE claim registry.
        vi.spyOn(slipBackfillStateService, "isLegacyScanRequired").mockResolvedValue(false);
        vi.spyOn(db, "lockPaymentForUpdate").mockImplementation(async (id, tx) => {
          if (id === initial.id && tx === secondTx) secondReachedLock.release();
          return realLockPayment(id, tx);
        });

        firstApproval = testDb.transaction(
          (tx) => approvePayment(initial.id, String(ownerUserId), "Synthetic regression admin", tx),
          { isolationLevel: "repeatable read" }
        );
        void firstApproval.catch(() => {});
        await bounded(Promise.race([
          firstHashReached.promise,
          firstApproval.then(() => { throw new Error("First approval skipped its byte-integrity check"); }),
        ]), "first approval holds payment lock");

        secondApproval = testDb.transaction((tx) => {
          secondTx = tx;
          return approvePayment(initial.id, String(ownerUserId), "Synthetic regression admin", tx);
        }, { isolationLevel: "repeatable read" });
        void secondApproval.catch(() => {});
        await bounded(Promise.race([
          secondReachedLock.promise,
          secondApproval.then(() => { throw new Error("Second approval skipped its payment lock"); }),
        ]), "second approval waits for same payment");

        allowFirstHash.release();
        const outcomes = await bounded(Promise.allSettled([firstApproval, secondApproval]), "both approvals finish");
        expect(outcomes[0].status).toBe("fulfilled");
        expect(outcomes[1].status).toBe("rejected");
        if (outcomes[1].status !== "rejected") throw new Error("Second approval unexpectedly succeeded");
        expect(outcomes[1].reason).toMatchObject({ code: "PAYMENT_NOT_REVIEWABLE", currentStatus: "approved" });
        expect(byteHash).toHaveBeenCalledTimes(1);

        expect(await db.getPaymentById(initial.id)).toMatchObject({
          status: "approved", approvalSource: "manual", evidenceVersion: initial.evidenceVersion,
        });
        expect(await db.getOrderById(initial.orderId)).toMatchObject({ status: "approved", paymentStatus: "approved" });
        const claims = await testDb.select().from(paymentSlipClaims).where(and(
          eq(paymentSlipClaims.sourceType, "order_payment"), eq(paymentSlipClaims.sourceId, initial.id)
        ));
        expect(claims).toHaveLength(1);
        expect(claims[0]).toMatchObject({ userId: ownerUserId, fileHash: uniqueHash });
        const history = await testDb.select().from(orderHistory).where(eq(orderHistory.orderId, initial.orderId));
        expect(history).toHaveLength(1);
        expect(history[0].action).toBe("payment_approved");
        const awards = await testDb.select().from(pointsTransactions).where(eq(pointsTransactions.userId, ownerUserId));
        expect(awards).toHaveLength(1);
        expect(awards[0]).toMatchObject({
          type: "earn", referenceType: "order", referenceId: initial.orderId,
          effectKey: `order:${initial.orderId}:earn`, amount: "1.00", balanceAfter: "1.00",
        });
        expect(await db.getUserPointsBalance(ownerUserId)).toBe("1.00");
        expect(await testDb.select().from(purchases).where(eq(purchases.orderId, initial.orderId))).toEqual([]);
        expect(await testDb.select().from(couponUsages).where(eq(couponUsages.orderId, initial.orderId))).toEqual([]);
      } finally {
        allowFirstHash.release();
        await Promise.allSettled([firstApproval, secondApproval].filter((task): task is Promise<any> => Boolean(task)));
        vi.restoreAllMocks();
      }
    });
  });
});
