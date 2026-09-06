import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultPaymentQrConfig, paymentQrRequestSchema, qrAmountSatang } from "../../shared/paymentQr";
import fixture from "./fixtures/merchant-qr.synthetic.json";
const deps = vi.hoisted(() => ({ getDb: vi.fn(), getOrderById: vi.fn(), getCartItems: vi.fn(), getPurchaseByUserAndEpisode: vi.fn(),
  getUserPointsBalance: vi.fn(), getCouponByCode: vi.fn(), resolveCouponOwnership: vi.fn(),
  createOrder: vi.fn(), createOrderItems: vi.fn(), createPayment: vi.fn() }));
vi.mock("../db", () => deps);
import { renderPaymentQr, resolveQrAmount } from "./qrService";
import { quoteCartPricing, createOrderFromCart } from "../services/orderService";
beforeEach(() => { vi.clearAllMocks(); deps.getPurchaseByUserAndEpisode.mockResolvedValue(null); });
describe("QR selection and server amounts", () => {
  it("renders the static QR without calling a broken renderer", async () => {
    const render = vi.fn().mockRejectedValue(Error("engine down"));
    const result = await renderPaymentQr({ ...defaultPaymentQrConfig, merchantTemplate: "invalid" }, 100, render);
    expect(result).toMatchObject({ mode: "static", imageUrl: null, amount: "1.00", error: null });
    expect(render).not.toHaveBeenCalled();
  });
  it("returns recoverable errors without falling back or leaking template/exception", async () => {
    const render = vi.fn().mockRejectedValue(Error("private details"));
    const result = await renderPaymentQr({ ...defaultPaymentQrConfig, mode: "generated", merchantTemplate: "secret" }, 100, render);
    expect(result).toMatchObject({ mode: "generated", imageUrl: null, error: "GENERATOR_UNAVAILABLE" });
    expect(JSON.stringify(result)).not.toMatch(/secret|private details/);
  });
  it("uses the actual generator to produce a PNG for server satang", async () => {
    const result = await renderPaymentQr({ ...defaultPaymentQrConfig, mode: "generated", merchantTemplate: fixture.template }, 123);
    expect(result.amount).toBe("1.23");
    expect(result.imageUrl).toMatch(/^data:image\/png;base64,iVBOR/);
  });
  it("does not generate a zero payment QR", async () => {
    const render = vi.fn();
    expect((await renderPaymentQr(defaultPaymentQrConfig, 0, render)).error).toBe("NO_AMOUNT");
    expect(render).not.toHaveBeenCalled();
  });
  it("loads stored order amount and checks ownership", async () => {
    deps.getOrderById.mockResolvedValue({ userId: 7, totalAmount: "345.67", paymentStatus: "unpaid", status: "pending" });
    expect(await resolveQrAmount(7, { kind: "order", orderId: 1 })).toBe(34567);
    await expect(resolveQrAmount(8, { kind: "order", orderId: 1 })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it.each([{ status: "approved" }, { status: "cancelled" }, { paymentStatus: "approved" }])("refuses settled/cancelled order %s", async fields => {
    deps.getOrderById.mockResolvedValue({ userId: 7, totalAmount: "1.00", ...fields });
    await expect(resolveQrAmount(7, { kind: "order", orderId: 1 })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
  it.each(["", "-1", "0", "1.001", "1abc", "Infinity", "1e2", "10000000000"])("rejects invalid top-up intent %s", async amount => {
    await expect(resolveQrAmount(7, { kind: "wallet", amount })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
  it("validates top-up amount without creating any payment record", async () => {
    expect(await resolveQrAmount(7, { kind: "wallet", amount: " 001.20 " })).toBe(120);
    expect(deps.getDb).not.toHaveBeenCalled();
    expect(deps.createPayment).not.toHaveBeenCalled();
  });
  it("rejects client-supplied totals and merchant templates on order/cart requests", () => {
    expect(paymentQrRequestSchema.safeParse({ kind: "order", orderId: 1, amount: "0.01" }).success).toBe(false);
    expect(paymentQrRequestSchema.safeParse({ kind: "cart", merchantTemplate: fixture.template }).success).toBe(false);
  });
  it("computes cart amount from DB items and shared coupon/points rules", async () => {
    const tx: any = { select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: 22 }] }) }) }) };
    deps.getDb.mockResolvedValue({ transaction: (fn: any) => fn(tx) });
    deps.getCartItems.mockResolvedValue([{ episodeId: 1, price: "100.00" }, { episodeId: 2, price: "50.25" }]);
    deps.getCouponByCode.mockResolvedValue({ isActive: true, discountType: "flat", discountValue: "10.00", code: "SAVE" });
    deps.resolveCouponOwnership.mockResolvedValue({ isOwnershipRestricted: false });
    deps.getUserPointsBalance.mockResolvedValue("50.00");
    expect(await resolveQrAmount(7, { kind: "cart", couponCode: "SAVE", pointsToRedeem: "5.25" })).toBe(13500);
    expect(deps.getCartItems).toHaveBeenCalledWith(22, tx);
    expect(deps.createOrder).not.toHaveBeenCalled();
  });
  it("keeps checkout pricing identical to its QR quote", async () => {
    const items = [{ episodeId: 1, novelId: 1, price: "12.50" }];
    deps.getUserPointsBalance.mockResolvedValue("10");
    const quote = await quoteCartPricing("7", items, undefined, "2.25");
    deps.createOrder.mockResolvedValue({ id: 1 });
    deps.getOrderById.mockResolvedValue({ id: 1 });
    await createOrderFromCart("7", items, undefined, "2.25");
    expect(quote.totalAmount).toBe(10.25);
    expect(deps.createOrder.mock.calls[0][0]).toMatchObject({ userId: 7, totalAmount: "10.25", pointsDiscountAmount: "2.25", subtotal: "12.5" });
  });
  it("rejects insufficient points instead of generating an underpayment QR", async () => {
    deps.getUserPointsBalance.mockResolvedValue("1");
    await expect(quoteCartPricing("7", [{ price: "10.00" }], undefined, "2")).rejects.toThrow("Insufficient points");
  });
  it("converts currency exactly at the upper bound", () => {
    expect(qrAmountSatang("9999999999.99")).toBe(999999999999);
    expect(qrAmountSatang("0.29")).toBe(29);
  });
});
