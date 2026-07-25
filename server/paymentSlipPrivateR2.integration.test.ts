import { describe, it, expect, beforeAll, vi } from "vitest";
import { eq } from "drizzle-orm";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";
import { getTestDb } from "./test-helpers/testDb";
import { createTestUser, createTestOrder, createTestPayment, deleteFixtures } from "./test-helpers/fixtures";
import { payments } from "../drizzle/schema";

/**
 * Payment slips must move to the PRIVATE R2 bucket end to end:
 *   upload (payment.uploadSlipFile) -> stored as an "r2p:payment-slips/..."
 *   reference (never a public URL) -> submit (orders.uploadPaymentSlip)
 *   persists that exact reference to payments.slipImageUrl, never a signed
 *   URL -> an admin read (admin.orders.detail) resolves it to a fresh,
 *   short-lived signed URL only at read time.
 *
 * OCR_ENABLED must be "false" in the environment before this file is
 * imported (same requirement as server/checkout-after-slip-upload-diagnosis.integration.test.ts)
 * so submitPaymentSlip's OCR branch is skipped and this file can assert on
 * deterministic manual-review behavior. R2_PRIVATE_* dummy config comes from
 * vitest.integration.config.ts's `test.env` - real S3 calls are mocked
 * below, so no network call ever happens.
 */

const sendMock = vi.fn();
vi.mock("@aws-sdk/client-s3", async () => {
  const actual = await vi.importActual<typeof import("@aws-sdk/client-s3")>("@aws-sdk/client-s3");
  return {
    ...actual,
    S3Client: vi.fn().mockImplementation(() => ({ send: sendMock })),
  };
});

const getSignedUrlMock = vi.fn();
vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: getSignedUrlMock,
}));

function makeUserContext(userId: number, role: "user" | "admin" = "user"): TrpcContext {
  return {
    user: {
      id: userId,
      openId: `slip-private-r2-${userId}`,
      email: `slip-private-r2-${userId}@example.test`,
      name: "Private R2 Slip Test User",
      loginMethod: "test",
      role,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastSignedIn: new Date(),
    } as TrpcContext["user"],
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

// 1x1 PNG, so validateMagicBytes passes.
const TINY_PNG_BASE64 =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

describe.sequential("Payment slips on private R2 (real disposable test database)", () => {
  beforeAll(() => {
    if (!process.env.TEST_DATABASE_URL) return;
    expect(process.env.OCR_ENABLED).toBe("false");
  });

  it("upload -> submit -> DB stores the raw r2p: reference -> admin read resolves a signed URL", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    sendMock.mockReset().mockResolvedValue({});
    getSignedUrlMock.mockReset().mockResolvedValue("https://signed.example/payment-slips/1/x.jpg?X-Amz-Signature=fake");

    const user = await createTestUser();
    const order = await createTestOrder(user.id);
    const payment = await createTestPayment(order.id);
    const userCaller = appRouter.createCaller(makeUserContext(user.id));
    const adminCaller = appRouter.createCaller(makeUserContext(999999, "admin"));

    const uploadResult = await userCaller.payment.uploadSlipFile({
      fileName: "slip.png",
      mimeType: "image/png",
      fileBase64: TINY_PNG_BASE64,
      context: "checkout",
    });

    // Never a public/permanent URL - always the private object reference.
    expect(uploadResult.slipImageUrl).toMatch(/^r2p:payment-slips\//);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(getSignedUrlMock).not.toHaveBeenCalled();

    await userCaller.orders.uploadPaymentSlip({ orderId: order.id, slipImageUrl: uploadResult.slipImageUrl });

    // The DB must hold the raw reference, never a presigned URL.
    const testDb = getTestDb();
    const [storedPayment] = await testDb.select().from(payments).where(eq(payments.orderId, order.id));
    expect(storedPayment.slipImageUrl).toBe(uploadResult.slipImageUrl);
    expect(storedPayment.slipImageUrl).not.toMatch(/^https?:\/\//);

    // An admin reading the order gets a resolved, working (signed) URL -
    // never the raw reference.
    const detail = await adminCaller.admin.orders.detail({ orderId: order.id });
    expect(detail.payment?.slipImageUrl).toBe("https://signed.example/payment-slips/1/x.jpg?X-Amz-Signature=fake");
    expect(detail.payment?.slipImageUrl).not.toMatch(/^r2p:/);
    expect(getSignedUrlMock).toHaveBeenCalledTimes(1);

    await deleteFixtures({ paymentIds: [payment.id], orderIds: [order.id], userIds: [user.id] });
  }, 30000);

  it("a legacy https:// slipImageUrl already in the DB is still returned as-is by an admin read (no signing attempted)", async () => {
    if (!process.env.TEST_DATABASE_URL) return;
    sendMock.mockReset();
    getSignedUrlMock.mockReset();

    const user = await createTestUser();
    const order = await createTestOrder(user.id);
    const payment = await createTestPayment(order.id);
    const LEGACY_URL = "https://media.ipenovel.com/payment-slips/legacy-slip.jpg";

    const testDb = getTestDb();
    await testDb.update(payments).set({ slipImageUrl: LEGACY_URL }).where(eq(payments.id, payment.id));

    const adminCaller = appRouter.createCaller(makeUserContext(999999, "admin"));
    const detail = await adminCaller.admin.orders.detail({ orderId: order.id });

    expect(detail.payment?.slipImageUrl).toBe(LEGACY_URL);
    expect(getSignedUrlMock).not.toHaveBeenCalled();

    await deleteFixtures({ paymentIds: [payment.id], orderIds: [order.id], userIds: [user.id] });
  }, 30000);
});
