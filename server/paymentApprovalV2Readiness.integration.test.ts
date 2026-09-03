import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { payments, slipEvidenceObjects, walletTopups } from "../drizzle/schema";
import * as db from "./db";
import { getTestDb } from "./test-helpers/testDb";
import { assertSafeTestDatabaseUrl } from "./test-helpers/testDatabaseGuard";
import { assertLiveTestDatabaseName } from "./test-helpers/liveTestDatabaseCheck";
import { createTestOrder, createTestPayment, createTestUser, deleteFixtures } from "./test-helpers/fixtures";
import {
  SLIP_BACKFILL_STATE_KEY,
  TRUSTED_SLIP_BACKFILL_TOOL_VERSION,
  clearSlipBackfillComplete,
  markSlipBackfillComplete,
} from "./services/slipBackfillStateService";
import {
  getOrderPaymentV2Eligibility,
  getPaymentApprovalV2GlobalReadiness,
  getWalletTopupV2Eligibility,
} from "./services/paymentApprovalV2ReadinessService";

const testDb = getTestDb();
const userIds: number[] = [];
const orderIds: number[] = [];
const paymentIds: number[] = [];
const topupIds: number[] = [];
const evidenceKeys: string[] = [];

async function trustBackfill() {
  await markSlipBackfillComplete({
    toolVersion: TRUSTED_SLIP_BACKFILL_TOOL_VERSION,
    paymentMaxId: 0,
    walletTopupMaxId: 0,
    claimsInserted: 0,
    collisionMembersRecorded: 0,
    unknownRowsRecorded: 0,
  });
}

async function createRegisteredEvidence(userId: number, suffix: string) {
  const fileHash = suffix.padEnd(64, suffix[0] ?? "a").slice(0, 64).replace(/[^a-f0-9]/g, "a");
  const objectKey = `payment-slips/${userId}/${fileHash}/${Date.now()}-${suffix}.png`;
  await db.registerModernSlipEvidenceObject({
    objectKey,
    ownerUserId: userId,
    fileHash,
    byteSize: 2048,
    contentType: "image/png",
  });
  evidenceKeys.push(objectKey);
  return { fileHash, objectKey, ref: `r2p:${objectKey}` };
}

describe.sequential("IPE-021-D Payment Approval V2 readiness - real database", () => {
  beforeAll(async () => {
    assertSafeTestDatabaseUrl(process.env.TEST_DATABASE_URL);
    await assertLiveTestDatabaseName(testDb);
  });

  afterEach(async () => {
    await clearSlipBackfillComplete();
    if (topupIds.length) {
      await testDb.delete(walletTopups).where(inArray(walletTopups.id, topupIds.splice(0)));
    }
    if (evidenceKeys.length) {
      await testDb.delete(slipEvidenceObjects).where(inArray(slipEvidenceObjects.objectKey, evidenceKeys.splice(0)));
    }
    await deleteFixtures({
      paymentIds: paymentIds.splice(0),
      orderIds: orderIds.splice(0),
      userIds: userIds.splice(0),
    });
  });

  it("keeps V2 closed for an old complete=true record that lacks trusted version/checksum provenance", async () => {
    await db.setSetting(SLIP_BACKFILL_STATE_KEY, JSON.stringify({ complete: true }), "legacy test state");
    expect(await getPaymentApprovalV2GlobalReadiness()).toMatchObject({
      ready: false,
      code: "LEGACY_COMPATIBILITY_NOT_READY",
      backfillReason: "STATE_VERSION_UNTRUSTED",
    });
  });

  it("opens Order V2 eligibility only when trusted backfill and exact immutable/version-bound evidence agree", async () => {
    await trustBackfill();
    const user = await createTestUser();
    userIds.push(user.id);
    const order = await createTestOrder(user.id);
    orderIds.push(order.id);
    const payment = await createTestPayment(order.id);
    paymentIds.push(payment.id);
    const evidence = await createRegisteredEvidence(user.id, "a1");

    await testDb.update(payments).set({
      status: "pending_review",
      slipImageUrl: evidence.ref,
      slipSubmittedAt: new Date(),
      extractedData: JSON.stringify({ fileHash: evidence.fileHash, reference: "ORDER-V2-READY" }),
      evidenceVersion: 2,
      evidenceClass: "modern_immutable",
      evidenceObjectKey: evidence.objectKey,
      evidenceFileHash: evidence.fileHash,
      extractedDataEvidenceVersion: 2,
    }).where(eq(payments.id, payment.id));

    expect(await getOrderPaymentV2Eligibility(payment.id)).toMatchObject({
      ready: true,
      code: "READY",
      evidenceVersion: 2,
      evidenceClass: "modern_immutable",
    });
  });

  it("keeps an otherwise strong legacy Order subject off the V2 fast path", async () => {
    await trustBackfill();
    const user = await createTestUser();
    userIds.push(user.id);
    const order = await createTestOrder(user.id);
    orderIds.push(order.id);
    const payment = await createTestPayment(order.id);
    paymentIds.push(payment.id);

    await testDb.update(payments).set({
      status: "pending_review",
      slipImageUrl: "https://legacy.example/slip.png",
      slipSubmittedAt: new Date(),
      extractedData: JSON.stringify({ fileHash: "b".repeat(64) }),
      evidenceVersion: 1,
      evidenceClass: "legacy_compatibility_required",
      evidenceFileHash: "b".repeat(64),
      extractedDataEvidenceVersion: null,
    }).where(eq(payments.id, payment.id));

    expect(await getOrderPaymentV2Eligibility(payment.id)).toMatchObject({
      ready: false,
      code: "EVIDENCE_NOT_IMMUTABLE",
    });
  });

  it("applies the same trusted immutable gate to Wallet V2", async () => {
    await trustBackfill();
    const user = await createTestUser();
    userIds.push(user.id);
    const evidence = await createRegisteredEvidence(user.id, "c2");
    const now = new Date();
    const result: any = await testDb.insert(walletTopups).values({
      userId: user.id,
      requestedAmount: "100.00",
      bonusAmount: "0.00",
      creditedAmount: "100.00",
      slipImageUrl: evidence.ref,
      slipSubmittedAt: now,
      status: "pending_review",
      extractedData: JSON.stringify({ fileHash: evidence.fileHash, reference: "WALLET-V2-READY" }),
      evidenceVersion: 1,
      evidenceClass: "modern_immutable",
      evidenceObjectKey: evidence.objectKey,
      evidenceFileHash: evidence.fileHash,
      extractedDataEvidenceVersion: 1,
      approvalSource: "manual",
      createdAt: now,
      updatedAt: now,
    });
    const header = Array.isArray(result) ? result[0] : result;
    const topupId = Number(header.insertId);
    topupIds.push(topupId);

    expect(await getWalletTopupV2Eligibility(topupId)).toMatchObject({
      ready: true,
      code: "READY",
      evidenceVersion: 1,
      evidenceClass: "modern_immutable",
    });
  });
});
