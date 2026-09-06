import { eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { carts } from "../../drizzle/schema";
import * as db from "../db";
import { quoteCartPricing } from "../services/orderService";
import { readPaymentQrConfig } from "./qrSettings";
import { qrAmountSatang, qrAmountText, type PaymentQrConfig, type PaymentQrRequest, type PaymentQrResult } from "../../shared/paymentQr";

const badAmount = () => new TRPCError({ code: "BAD_REQUEST", message: "กรุณาตรวจสอบยอดชำระแล้วโหลดข้อมูลใหม่" });
export async function resolveQrAmount(userId: number, input: PaymentQrRequest): Promise<number> {
  if (input.kind === "wallet") {
    // A pre-transfer top-up intent: validate on the server. No top-up is created
    // until the existing slip-first flow completes.
    let amount: number;
    try { amount = qrAmountSatang(input.amount); } catch { throw badAmount(); }
    if (amount <= 0) throw badAmount();
    return amount;
  }
  if (input.kind === "order") {
    const order = await db.getOrderById(input.orderId);
    if (!order || order.userId !== userId) throw new TRPCError({ code: "NOT_FOUND" });
    if (order.paymentStatus === "approved" || order.status === "approved" || order.status === "cancelled")
      throw new TRPCError({ code: "BAD_REQUEST", message: "รายการนี้ไม่อยู่ระหว่างรอชำระเงิน" });
    try { return qrAmountSatang(String(order.totalAmount)); } catch { throw badAmount(); }
  }
  const database = await db.getDb();
  if (!database) throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "ไม่สามารถอ่านยอดชำระได้ กรุณาลองใหม่" });
  // Read-only snapshot. Never create a cart, order, payment or reservation for QR.
  const quote = await database.transaction(async tx => {
    const [cart] = await tx.select().from(carts).where(eq(carts.userId, userId)).limit(1);
    if (!cart) throw badAmount();
    const items = await db.getCartItems(cart.id, tx);
    if (!items.length) throw badAmount();
    return quoteCartPricing(String(userId), items, input.couponCode, input.pointsToRedeem, tx);
  });
  // Same pricing as checkout; convert its final currency precision to satang.
  try { return qrAmountSatang(quote.totalAmount.toFixed(2)); } catch { throw badAmount(); }
}
export type QrRenderer = (template: string, amount: number) => Promise<{ png: Buffer }>;
const render: QrRenderer = async (template, amount) => (await import("./merchantQr")).generateMerchantQr(template, amount);
export async function renderPaymentQr(config: PaymentQrConfig, amountSatang: number, generator: QrRenderer = render): Promise<PaymentQrResult> {
  const base = { mode: config.mode, revision: config.revision, amount: qrAmountText(amountSatang), imageUrl: null };
  if (amountSatang <= 0) return { ...base, error: "NO_AMOUNT" };
  if (config.mode === "static") return { ...base, imageUrl: config.staticImageUrl || null, error: null };
  try {
    const result = await generator(config.merchantTemplate, amountSatang);
    return { ...base, imageUrl: "data:image/png;base64," + result.png.toString("base64"), error: null };
  } catch {
    // Stable recoverable response, no raw exception or receiver config in logs.
    // Admin explicitly controls mode; an error is never a payment approval.
    return { ...base, error: "GENERATOR_UNAVAILABLE" };
  }
}
export async function getPaymentQr(userId: number, input: PaymentQrRequest) {
  const config = await readPaymentQrConfig();
  const amount = await resolveQrAmount(userId, input);
  return renderPaymentQr(config, amount);
}
