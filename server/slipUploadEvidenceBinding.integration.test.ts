import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  accountMutationGuards,
  orders,
  payments,
  pointsAccounts,
  slipEvidenceBindings,
  slipEvidenceUploads,
  users,
  walletTopups,
} from "../drizzle/schema";
import * as db from "./db";
import { createTestOrder, createTestPayment, createTestUser } from "./test-helpers/fixtures";
import { closeTestDb, ensureVerifiedTestDb, getTestDb } from "./test-helpers/testDb";
import * as privateStorage from "./services/r2PrivateStorage";
import { computeSlipFileHash } from "./services/slipFileHashService";
import { uploadPaymentSlipFile } from "./services/slipFileUploadService";
import { deriveStrongIdentifiersFromExtractedData, hasStrongIdentifier } from "./services/slipIdentifierService";

// Exercise the actual uploader, hash reader, registry, and transactional
// publication together. Mocking either hash function or the registry would
// hide a disagreement between the upload digest and approval's file hash.
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);
const storedObjects = new Map<string, Buffer>();
type SourceType = "order_payment" | "wallet_topup";
type Publication = Parameters<typeof db.publishReplacementSlipIfReviewable>[1];

async function readStoredHash(objectIdentity: string, replacementBytes?: Buffer): Promise<string> {
  const uploadedBytes = storedObjects.get(objectIdentity);
  expect(uploadedBytes).toBeDefined();
  const signedUrl = "https://storage.example.test/synthetic-signed-slip";
  const resolveStoredFileValueFn = vi.fn(async () => signedUrl);
  const fetchImpl = vi.fn<typeof fetch>(async () =>
    new Response(new Uint8Array(replacementBytes ?? uploadedBytes!), { status: 200 })
  );
  const fileHash = await computeSlipFileHash(objectIdentity, { resolveStoredFileValueFn, fetchImpl });
  expect(resolveStoredFileValueFn).toHaveBeenCalledWith(objectIdentity, "paymentSlip");
  expect(fetchImpl).toHaveBeenCalledWith(signedUrl, { signal: expect.any(AbortSignal) });
  expect(fileHash).toMatch(/^[a-f0-9]{64}$/);
  return fileHash!;
}

async function uploadFor(userId: number, sourceType: SourceType, fileName: string) {
  return uploadPaymentSlipFile({
    userId,
    context: sourceType === "order_payment" ? "payment_page" : "wallet",
    fileName,
    mimeType: "image/png",
    fileBase64: PNG_BYTES.toString("base64"),
  });
}

async function withSubject(
  sourceType: SourceType,
  run: (subject: {
    ownerUserId: number;
    sourceId: number;
    publish: (fields: Publication) => Promise<boolean>;
    read: () => Promise<typeof payments.$inferSelect | typeof walletTopups.$inferSelect>;
  }) => Promise<void>
) {
  const testDb = getTestDb();
  const user = await createTestUser();
  let orderId: number | undefined;
  let paymentId: number | undefined;
  let topupId: number | undefined;
  try {
    if (sourceType === "order_payment") {
      orderId = (await createTestOrder(user.id)).id;
      paymentId = (await createTestPayment(orderId)).id;
      const id = paymentId;
      await testDb.update(payments).set({
        slipImageUrl: `r2p:payment-slips/${user.id}/legacy-unbound.png`,
        extractedData: null,
      }).where(eq(payments.id, id));
      await run({
        ownerUserId: user.id,
        sourceId: id,
        publish: (fields) => db.publishReplacementSlipIfReviewable(id, fields),
        read: async () => (await testDb.select().from(payments).where(eq(payments.id, id)))[0],
      });
    } else {
      const [inserted] = await testDb.insert(walletTopups).values({
        userId: user.id,
        requestedAmount: "100.00",
        slipImageUrl: `r2p:payment-slips/${user.id}/legacy-unbound.png`,
        extractedData: null,
      });
      topupId = inserted.insertId;
      const id = topupId;
      await run({
        ownerUserId: user.id,
        sourceId: id,
        publish: (fields) => db.publishWalletTopupReplacementIfReviewable(id, fields),
        read: async () => (await testDb.select().from(walletTopups).where(eq(walletTopups.id, id)))[0],
      });
    }
  } finally {
    // Only this test's fixture IDs/owner are removed, child before parent.
    // No schema reset, global DELETE, or mutation of another test's rows.
    await testDb.transaction(async (tx) => {
      if (paymentId !== undefined) await tx.delete(payments).where(eq(payments.id, paymentId));
      if (topupId !== undefined) await tx.delete(walletTopups).where(eq(walletTopups.id, topupId));
      await tx.delete(slipEvidenceBindings).where(eq(slipEvidenceBindings.ownerUserId, user.id));
      await tx.delete(slipEvidenceUploads).where(eq(slipEvidenceUploads.ownerUserId, user.id));
      if (orderId !== undefined) await tx.delete(orders).where(eq(orders.id, orderId));
      await tx.delete(pointsAccounts).where(eq(pointsAccounts.userId, user.id));
      await tx.delete(accountMutationGuards).where(eq(accountMutationGuards.userId, user.id));
      await tx.delete(users).where(eq(users.id, user.id));
    });
  }
}

describe.sequential("slip upload to immutable evidence publication - real disposable database", () => {
  beforeAll(async () => {
    const verified = await ensureVerifiedTestDb();
    // The integration setup injects this verified ipenovel_test connection
    // into production db functions; never fall back to DATABASE_URL.
    expect(await db.getDb()).toBe(verified);
  });

  beforeEach(() => {
    storedObjects.clear();
    vi.spyOn(privateStorage, "putPrivateObjectCreateOnly").mockImplementation(async (context, key, bytes) => {
      expect(context).toBe("paymentSlip");
      const identity = `r2p:${key}`;
      expect(storedObjects.has(identity)).toBe(false);
      storedObjects.set(identity, Buffer.from(bytes));
      return { key };
    });
  });

  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    db.__setDbForTests(null);
    await closeTestDb();
  });

  it.each<SourceType>(["order_payment", "wallet_topup"])(
    "%s: uploaded bytes publish as modern evidence with a strong file identifier even without OCR",
    async (sourceType) => {
      await withSubject(sourceType, async ({ ownerUserId, sourceId, publish, read }) => {
        const previous = await read();
        expect(previous).toMatchObject({
          extractedData: null,
          evidenceVersion: 0,
          slipEvidenceClass: "legacy_compatibility_required",
        });
        expect(hasStrongIdentifier(deriveStrongIdentifiersFromExtractedData(previous.extractedData).identifiers)).toBe(false);
        const uploaded = await uploadFor(ownerUserId, sourceType, "slip.png");
        expect(uploaded.slipImageUrl).not.toBe(previous.slipImageUrl);
        expect(storedObjects.get(uploaded.slipImageUrl)).toEqual(PNG_BYTES);
        const fileHash = await readStoredHash(uploaded.slipImageUrl);

        expect(await publish({
          slipImageUrl: uploaded.slipImageUrl,
          slipSubmittedAt: new Date(),
          extractedData: JSON.stringify({ fileHash }),
          fileHash,
        })).toBe(true);

        const subject = await read();
        expect(subject).toMatchObject({
          status: "pending",
          slipImageUrl: uploaded.slipImageUrl,
          evidenceVersion: 1,
          extractedEvidenceVersion: 1,
          slipEvidenceClass: "modern_immutable",
        });
        expect(subject.slipEvidenceId).not.toBeNull();

        const testDb = getTestDb();
        const [registered] = await testDb.select().from(slipEvidenceUploads)
          .where(eq(slipEvidenceUploads.objectIdentity, uploaded.slipImageUrl));
        const [binding] = await testDb.select().from(slipEvidenceBindings)
          .where(eq(slipEvidenceBindings.id, subject.slipEvidenceId!));
        expect(registered).toMatchObject({
          ownerUserId, fileHash, objectSize: PNG_BYTES.length, mimeType: "image/png",
        });
        expect(binding).toMatchObject({
          uploadId: registered.id,
          sourceType,
          sourceId,
          ownerUserId,
          evidenceClass: "modern_immutable",
          evidenceVersion: 1,
          objectIdentity: uploaded.slipImageUrl,
          fileHash,
          objectSize: PNG_BYTES.length,
          mimeType: "image/png",
        });
        const { identifiers } = deriveStrongIdentifiersFromExtractedData(subject.extractedData);
        expect(identifiers.fileHash).toBe(registered.fileHash);
        expect(identifiers.fileHash).toBe(binding.fileHash);
        expect(hasStrongIdentifier(identifiers)).toBe(true);
      });
    }
  );

  it.each<SourceType>(["order_payment", "wallet_topup"])(
    "%s: different bytes fetched for a replacement remain blocked without mutating the current subject",
    async (sourceType) => {
      await withSubject(sourceType, async ({ ownerUserId, publish, read }) => {
        const first = await uploadFor(ownerUserId, sourceType, "original.png");
        const firstHash = await readStoredHash(first.slipImageUrl);
        expect(await publish({
          slipImageUrl: first.slipImageUrl,
          slipSubmittedAt: new Date(),
          extractedData: JSON.stringify({ fileHash: firstHash }),
          fileHash: firstHash,
        })).toBe(true);
        const before = await read();

        const replacement = await uploadFor(ownerUserId, sourceType, "replacement.png");
        const changedBytes = Buffer.from(PNG_BYTES);
        changedBytes[changedBytes.length - 1] ^= 1;
        const changedHash = await readStoredHash(replacement.slipImageUrl, changedBytes);
        expect(changedHash).not.toBe(firstHash);
        await expect(publish({
          slipImageUrl: replacement.slipImageUrl,
          slipSubmittedAt: new Date(),
          extractedData: JSON.stringify({ fileHash: changedHash }),
          fileHash: changedHash,
        })).rejects.toMatchObject({ code: "IMMUTABLE_EVIDENCE_HASH_MISMATCH" });

        expect(await read()).toEqual(before);
        const bindings = await getTestDb().select().from(slipEvidenceBindings)
          .where(eq(slipEvidenceBindings.ownerUserId, ownerUserId));
        expect(bindings).toHaveLength(1);
        expect(bindings[0].id).toBe(before.slipEvidenceId);
        expect(bindings[0].fileHash).toBe(firstHash);
      });
    }
  );
});
