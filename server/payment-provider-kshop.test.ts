import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
const mocks = vi.hoisted(() => ({
 getPaymentById: vi.fn(), getOrderById: vi.fn(), updatePayment: vi.fn(),
 getWalletTopupById: vi.fn(), updateWalletTopupProviderVerification: vi.fn(),
 getReceiverCondition: vi.fn(), resolveStoredFileValue: vi.fn(),
}));
vi.mock("./db", () => mocks);
vi.mock("./payments/receiverSettings", () => mocks);
vi.mock("./services/r2PrivateStorage", () => mocks);
import { verifyOrderPaymentWithProvider, verifyWalletTopupWithProvider, __test } from "./services/paymentProviderVerificationService";
const raw = () => ({ code: "200200", data: { referenceId: "synthetic-provider-1", transRef: "synthetic-bank-1",
 amount: 100, dateTime: "2026-09-07T17:53:12+07:00", ref1: "KB000000000001",
 receiver: { account: { name: "Synthetic shop", bank: { account: null }, proxy: { type: null, account: null } }, bank: { id: "000" } } } });
let network: ReturnType<typeof vi.fn>;
beforeEach(() => {
 vi.resetAllMocks();
 vi.stubEnv("SLIP2GO_SECRET_KEY", "test-secret-only");
 mocks.getPaymentById.mockResolvedValue({ id: 1, orderId: 2, slipImageUrl: "stored-fixture" });
 mocks.getOrderById.mockResolvedValue({ id: 2, totalAmount: "100.00" });
 mocks.getWalletTopupById.mockResolvedValue({ id: 3, slipImageUrl: "stored-fixture", requestedAmount: "100.00" });
 mocks.resolveStoredFileValue.mockResolvedValue("https://example.test/slip.png");
 mocks.getReceiverCondition.mockResolvedValue({ accountType: "03000", accountNumber: "KB000000000001" });
 network = vi.fn().mockResolvedValueOnce(new Response(new Uint8Array([137,80,78,71,13,10,26,10])))
   .mockResolvedValueOnce(new Response(JSON.stringify(raw()), { status: 200 }));
 vi.stubGlobal("fetch", network);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe("KSHOP provider request and diagnostics", () => {
 it.each(["order", "wallet"])("sends explicit merchant/amount/duplicate checks for %s without crediting", async kind => {
  const r = kind === "order" ? await verifyOrderPaymentWithProvider(1) : await verifyWalletTopupWithProvider(3);
  expect(r).toMatchObject({ outcome: "VERIFIED", recipientCheckApplied: true, httpStatus: 200, reason: "CHECKS_PASSED", amount: "100.00" });
  const [url, req] = network.mock.calls[1];
  expect(url).toBe("https://connect.slip2go.com/api/verify-slip/qr-image/info");
  expect(req.headers.Authorization).toBe("Bearer test-secret-only");
  expect(JSON.parse(req.body.get("payload"))).toEqual({ checkDuplicate: true, checkAmount: { type: "eq", amount: "100.00" },
    checkReceiver: [{ accountType: "03000", accountNumber: "KB000000000001" }] });
  const writes = kind === "order" ? mocks.updatePayment : mocks.updateWalletTopupProviderVerification;
  expect(writes).toHaveBeenCalledOnce();
  expect(writes.mock.calls[0][1].extractedData).toContain('"httpStatus":200');
  expect(writes.mock.calls[0][1]).not.toHaveProperty("approvedAt");
  if (kind === "order") expect(writes.mock.calls[0][1].status).toBe("pending_review");
 });
 it("keeps missing receiver review-required even for valid provider result", async () => {
  mocks.getReceiverCondition.mockResolvedValue(undefined);
  const r = await verifyOrderPaymentWithProvider(1);
  expect(r).toMatchObject({ outcome: "REVIEW_REQUIRED", recipientCheckApplied: false, reason: "RECEIVER_CHECK_NOT_APPLIED" });
  expect(JSON.parse(network.mock.calls[1][1].body.get("payload"))).not.toHaveProperty("checkReceiver");
 });
 it("rejects invalid receiver configuration before the paid API call", async () => {
  mocks.getReceiverCondition.mockRejectedValue(Error("INVALID_PROVIDER_RECEIVER_SETTINGS"));
  expect(await verifyOrderPaymentWithProvider(1)).toMatchObject({ outcome: "ERROR", reason: "INVALID_PROVIDER_RECEIVER_SETTINGS" });
  expect(network).toHaveBeenCalledTimes(1);
 });
 it.each(["200401", "200402", "200501", "200502", "200000", "200202"])("does not approve provider code %s", code => {
  expect(__test.normalizeSlip2GoResponse({ ...raw(), code }, 200, "100.00", true).outcome).toBe("REVIEW_REQUIRED");
 });
 it("does not trust 200200 when returned amount differs", () => {
  expect(__test.normalizeSlip2GoResponse(raw(), 200, "101.00", true)).toMatchObject({ outcome: "REVIEW_REQUIRED", reason: "AMOUNT_MISMATCH" });
 });
 it("reproduces 200200 + ERROR for unexpected HTTP and retains redacted diagnostics", async () => {
  network.mockReset().mockResolvedValueOnce(new Response(new Uint8Array([137,80,78,71,13,10,26,10])))
    .mockResolvedValueOnce(new Response(JSON.stringify(raw()), { status: 201 }));
  const r = await verifyOrderPaymentWithProvider(1);
  expect(r).toMatchObject({ code: "200200", outcome: "ERROR", httpStatus: 201, reason: "UNEXPECTED_PROVIDER_HTTP_STATUS", providerReference: "synthetic-provider-1" });
  expect(JSON.stringify(r)).not.toContain("Synthetic shop");
 });
 it("redacts unknown exceptions", async () => {
  mocks.resolveStoredFileValue.mockRejectedValue(Error("secret URL and customer PII"));
  expect(await verifyOrderPaymentWithProvider(1)).toMatchObject({ outcome: "ERROR", reason: "PROVIDER_REQUEST_FAILED" });
  expect(JSON.stringify(mocks.updatePayment.mock.calls)).not.toContain("secret URL");
 });
 it("records timeout without approving", async () => {
  network.mockReset().mockRejectedValue(new DOMException("private URL", "TimeoutError"));
  expect(await verifyWalletTopupWithProvider(3)).toMatchObject({ outcome: "ERROR", reason: "PROVIDER_TIMEOUT" });
 });
 it.each(["{}", "{bad", '{"code":"200200","data":{"amount":100,"dateTime":"invalid"}}'])("fails closed for malformed data %s", async text => {
  network.mockReset().mockResolvedValueOnce(new Response(new Uint8Array([137,80,78,71,13,10,26,10])))
    .mockResolvedValueOnce(new Response(text));
  expect((await verifyOrderPaymentWithProvider(1)).outcome).not.toBe("VERIFIED");
 });
 it("never stores secret echoed by provider", async () => {
  network.mockReset().mockResolvedValueOnce(new Response(new Uint8Array([137,80,78,71,13,10,26,10])))
    .mockResolvedValueOnce(new Response(JSON.stringify({ ...raw(), message: "test-secret-only" })));
  expect(await verifyOrderPaymentWithProvider(1)).toMatchObject({ reason: "PROVIDER_SECRET_ECHO", outcome: "ERROR" });
  expect(JSON.stringify(mocks.updatePayment.mock.calls)).not.toContain("test-secret-only");
 });
});
