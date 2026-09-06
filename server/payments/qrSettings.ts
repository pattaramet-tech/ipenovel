import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { settings } from "../../drizzle/schema";
import * as db from "../db";
import { defaultPaymentQrConfig, paymentQrUpdateSchema, validStaticQrUrl, type PaymentQrConfig } from "../../shared/paymentQr";

export const PAYMENT_QR_KEY = "paymentQr.config";
export function decodePaymentQrConfig(raw: string | null | undefined): PaymentQrConfig {
  let value: any;
  try { value = JSON.parse(raw ?? "{}"); } catch { value = {}; }
  return {
    ...defaultPaymentQrConfig,
    mode: value?.mode === "generated" ? "generated" : "static",
    staticImageUrl: typeof value?.staticImageUrl === "string" && validStaticQrUrl(value.staticImageUrl) ? value.staticImageUrl : "",
    // Do not validate the generator here: admin recovery must remain available.
    merchantTemplate: typeof value?.merchantTemplate === "string" ? value.merchantTemplate : "",
    revision: Number.isSafeInteger(value?.revision) && value.revision >= 0 ? value.revision : 0,
    updatedBy: Number.isSafeInteger(value?.updatedBy) ? value.updatedBy : null,
    updatedAt: typeof value?.updatedAt === "string" ? value.updatedAt : null,
  };
}
async function connection() {
  const database = await db.getDb();
  if (!database) throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "ไม่สามารถอ่านหรือบันทึกการตั้งค่า QR ได้ กรุณาลองใหม่" });
  return database;
}
export async function readPaymentQrConfig(): Promise<PaymentQrConfig> {
  const database = await connection();
  const [row] = await database.select().from(settings).where(eq(settings.key, PAYMENT_QR_KEY)).limit(1);
  return decodePaymentQrConfig(row?.value);
}
export async function savePaymentQrConfig(raw: unknown, actorId: number): Promise<PaymentQrConfig> {
  const input = paymentQrUpdateSchema.parse(raw);
  if (input.staticImageUrl !== undefined && !validStaticQrUrl(input.staticImageUrl))
    throw new TRPCError({ code: "BAD_REQUEST", message: "ลิงก์ QR เดิมต้องเป็น HTTPS และไม่ใช่ CDN เดิมที่เลิกใช้" });
  const database = await connection();
  return database.transaction(async tx => {
    // Seed and lock the single row, including the first concurrent saves.
    await tx.insert(settings).values({ key: PAYMENT_QR_KEY, value: JSON.stringify(defaultPaymentQrConfig) })
      .onDuplicateKeyUpdate({ set: { key: PAYMENT_QR_KEY } });
    const [row] = await tx.select().from(settings).where(eq(settings.key, PAYMENT_QR_KEY)).limit(1).for("update");
    const current = decodePaymentQrConfig(row?.value);
    if (input.expectedRevision !== current.revision)
      throw new TRPCError({ code: "CONFLICT", message: "การตั้งค่าเปลี่ยนแล้ว กรุณาโหลดข้อมูลล่าสุดก่อนบันทึก" });
    const next: PaymentQrConfig = {
      ...current, mode: input.mode,
      staticImageUrl: input.staticImageUrl ?? current.staticImageUrl,
      merchantTemplate: input.merchantTemplate ?? current.merchantTemplate,
      revision: current.revision + 1, updatedBy: actorId, updatedAt: new Date().toISOString(),
    };
    if (next.mode === "generated") {
      try {
        const { generateMerchantQrPayload } = await import("./merchantQr");
        generateMerchantQrPayload(next.merchantTemplate, 100);
      } catch {
        throw new TRPCError({ code: "BAD_REQUEST", message: "ต้นแบบ QR ไม่ถูกต้อง หรือตัวเจนไม่พร้อมใช้งาน สามารถเลือก QR เดิมได้" });
      }
    }
    await tx.update(settings).set({ value: JSON.stringify(next) }).where(eq(settings.key, PAYMENT_QR_KEY));
    // Atomic append-only audit in the existing settings store; no new migration.
    await tx.insert(settings).values({
      key: "paymentQr.audit." + randomUUID(),
      value: JSON.stringify({ revision: next.revision, actorId, at: next.updatedAt, from: current.mode, to: next.mode,
        reason: input.reason, templateChanged: next.merchantTemplate !== current.merchantTemplate, imageChanged: next.staticImageUrl !== current.staticImageUrl }),
      description: "Payment QR mode/config change audit",
    });
    return next;
  });
}
