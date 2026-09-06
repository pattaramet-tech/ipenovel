import { z } from "zod";
import { validatePaymentQrImageUrlForProduction } from "../client/src/constants/paymentQrImageUrl";

export const paymentQrModeSchema = z.enum(["static", "generated"]);
export const paymentQrUpdateSchema = z.object({
  mode: paymentQrModeSchema,
  expectedRevision: z.number().int().nonnegative(),
  reason: z.string().trim().min(1).max(300),
  staticImageUrl: z.string().trim().max(2048).optional(),
  merchantTemplate: z.string().trim().max(1024).optional(),
}).strict();
export const paymentQrRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("order"), orderId: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal("cart"), couponCode: z.string().max(100).optional(), pointsToRedeem: z.string().max(30).optional() }).strict(),
  z.object({ kind: z.literal("wallet"), amount: z.string().max(30) }).strict(),
]);
export type PaymentQrRequest = z.infer<typeof paymentQrRequestSchema>;
export type PaymentQrConfig = {
  mode: "static" | "generated";
  staticImageUrl: string;
  merchantTemplate: string;
  revision: number;
  updatedBy: number | null;
  updatedAt: string | null;
};
export type PaymentQrResult = {
  mode: PaymentQrConfig["mode"];
  revision: number;
  amount: string | null;
  imageUrl: string | null;
  error: "GENERATOR_UNAVAILABLE" | "NO_AMOUNT" | null;
};
export const defaultPaymentQrConfig: PaymentQrConfig = {
  mode: "static", staticImageUrl: "", merchantTemplate: "", revision: 0, updatedBy: null, updatedAt: null,
};
export function validStaticQrUrl(value: string): boolean {
  if (!value) return true; // empty means keep the original build-configured QR
  const valid = validatePaymentQrImageUrlForProduction(value);
  if (!valid.ok) return false;
  const url = new URL(value);
  return !url.username && !url.password;
}
/** Decimal to integer satang, without rounding or floating point multiplication. */
export function qrAmountSatang(value: string): number {
  const match = /^(\d{1,10})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new Error("INVALID_QR_AMOUNT");
  const amount = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > 999999999999) throw new Error("INVALID_QR_AMOUNT");
  return amount;
}
export function qrAmountText(satang: number): string {
  return Math.floor(satang / 100) + "." + String(satang % 100).padStart(2, "0");
}
