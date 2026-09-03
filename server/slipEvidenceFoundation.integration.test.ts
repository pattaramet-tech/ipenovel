import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { payments, slipEvidenceObjects, walletTopups } from "../drizzle/schema";
import * as db from "./db";
import { getTestDb } from "./test-helpers/testDb";
import { assertSafeTestDatabaseUrl } from "./test-helpers/testDatabaseGuard";
import { assertLiveTestDatabaseName } from "./test-helpers/liveTestDatabaseCheck";
import { createTestOrder, createTestUser, deleteFixtures, uniqueTestTag } from "./test-helpers/fixtures";

const usersToDelete: number[] = [];
const ordersToDelete: number[] = [];
const paymentsToDelete: number[] = [];
const walletTopupsToDelete: number[] = [];

function requireTestDb() {
  if (!process.env.TEST_DATABASE_URL) throw new Error("0047 evidence integration requires TEST_DATABASE_URL=.../ipenovel_test");
  return getTestDb();
}

beforeAll(async () => {
  assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);
  await assertLiveTestDatabaseName(getTestDb());
});

afterEach(async () => {
  const t = requireTestDb();
  for (const id of walletTopupsToDelete.splice(0)) {
    await t.delete(walletTopups).where(eq(walletTopups.id, id));
  }
  await deleteFixtures({
    paymentIds: paymentsToDelete.splice(0),
    orderIds: ordersToDelete.splice(0),
    userIds: usersToDelete.splice(0),
  });
});

describe.sequential("IPE-021-D / 0047 immutable evidence - real database", () => {
  it("registry is write-once/idempotent and payment publication binds the registered object + monotonic version", async () => {
    const user = await createTestUser();
    usersToDelete.push(user.id);
    const order = await createTestOrder(user.id);
    ordersToDelete.push(order.id);

    const hashA = "a".repeat(64);
    const keyA = `payment-slips/${user.id}/${hashA}/${uniqueTestTag("a")}.jpg`;
    const registryA = {
      objectKey: keyA,
      ownerUserId: user.id,
      fileHash: hashA,
      byteSize: 1234,
      contentType: "image/jpeg",
    };

    await db.registerModernSlipEvidenceObject(registryA);
    await expect(db.registerModernSlipEvidenceObject(registryA)).resolves.toMatchObject(registryA);
    await expect(
      db.registerModernSlipEvidenceObject({ ...registryA, fileHash: "b".repeat(64) })
    ).rejects.toThrow(/SLIP_EVIDENCE_OBJECT_IDENTITY_CONFLICT/);

    const payment = await db.createPayment(order.id, `r2p:${keyA}`);
    if (!payment) throw new Error("payment creation failed");
    paymentsToDelete.push(payment.id);

    let stored = await db.getPaymentById(payment.id);
    expect(stored).toMatchObject({
      evidenceClass: "modern_immutable",
      evidenceObjectKey: keyA,
      evidenceFileHash: hashA,
    });
    expect(Number(stored?.evidenceVersion)).toBe(1);
    expect(stored?.extractedDataEvidenceVersion).toBeNull();

    const hashB = "b".repeat(64);
    const keyB = `payment-slips/${user.id}/${hashB}/${uniqueTestTag("b")}.jpg`;
    await db.registerModernSlipEvidenceObject({
      objectKey: keyB,
      ownerUserId: user.id,
      fileHash: hashB,
      byteSize: 2222,
      contentType: "image/jpeg",
    });

    const published = await db.publishReplacementSlipIfReviewable(payment.id, {
      slipImageUrl: `r2p:${keyB}`,
      slipSubmittedAt: new Date(),
      extractedData: JSON.stringify({ fileHash: hashB }),
    });
    expect(published).toBe(true);

    stored = await db.getPaymentById(payment.id);
    expect(Number(stored?.evidenceVersion)).toBe(2);
    expect(Number(stored?.extractedDataEvidenceVersion)).toBe(2);
    expect(stored?.evidenceClass).toBe("modern_immutable");
    expect(stored?.evidenceObjectKey).toBe(keyB);
    expect(stored?.evidenceFileHash).toBe(hashB);

    // Runtime bypass protection: a JavaScript/as-any caller cannot reintroduce
    // a bare slip setter through the generic update API.
    await expect(
      (db.updatePayment as any)(payment.id, { slipImageUrl: `r2p:${keyA}` })
    ).rejects.toThrow(/SLIP_EVIDENCE_PUBLISH_REQUIRED/);
    expect((await db.getPaymentById(payment.id))?.evidenceObjectKey).toBe(keyB);
  }, 30000);

  it("wallet replacement uses the same evidence registry/version contract and the old bare setter is disabled", async () => {
    const user = await createTestUser();
    usersToDelete.push(user.id);
    const t = requireTestDb();

    const topupResult: any = await t.insert(walletTopups).values({
      userId: user.id,
      requestedAmount: "100.00",
      bonusAmount: "0.00",
      creditedAmount: "100.00",
      status: "pending",
      approvalSource: "manual",
    });
    const topupId = Number(topupResult?.[0]?.insertId ?? topupResult?.insertId);
    walletTopupsToDelete.push(topupId);

    const hash = "c".repeat(64);
    const key = `payment-slips/${user.id}/${hash}/${uniqueTestTag("wallet")}.png`;
    await db.registerModernSlipEvidenceObject({
      objectKey: key,
      ownerUserId: user.id,
      fileHash: hash,
      byteSize: 999,
      contentType: "image/png",
    });

    const published = await db.publishWalletTopupReplacementIfReviewable(topupId, {
      slipImageUrl: `r2p:${key}`,
      slipSubmittedAt: new Date(),
      extractedData: JSON.stringify({ fileHash: hash }),
    });
    expect(published).toBe(true);

    const topup = await db.getWalletTopupById(topupId);
    expect(Number(topup.evidenceVersion)).toBe(1);
    expect(Number(topup.extractedDataEvidenceVersion)).toBe(1);
    expect(topup.evidenceClass).toBe("modern_immutable");
    expect(topup.evidenceObjectKey).toBe(key);
    expect(topup.evidenceFileHash).toBe(hash);

    await expect(db.updateWalletTopupSlip(topupId, `r2p:${key}`)).rejects.toThrow(
      /SLIP_EVIDENCE_PUBLISH_REQUIRED/
    );

    const registry = await t.select().from(slipEvidenceObjects).where(eq(slipEvidenceObjects.objectKey, key));
    expect(registry).toHaveLength(1);
  }, 30000);

  it("registry ownership is enforced at publication time", async () => {
    const owner = await createTestUser();
    const other = await createTestUser();
    usersToDelete.push(owner.id, other.id);
    const order = await createTestOrder(other.id);
    ordersToDelete.push(order.id);

    const hash = "d".repeat(64);
    const key = `payment-slips/${owner.id}/${hash}/${uniqueTestTag("owner")}.jpg`;
    await db.registerModernSlipEvidenceObject({
      objectKey: key,
      ownerUserId: owner.id,
      fileHash: hash,
      byteSize: 100,
      contentType: "image/jpeg",
    });

    await expect(db.createPayment(order.id, `r2p:${key}`)).rejects.toThrow(/SLIP_EVIDENCE_OWNER_MISMATCH/);
    const rows = await requireTestDb().select().from(payments).where(eq(payments.orderId, order.id));
    expect(rows).toHaveLength(0);
  }, 30000);
});
