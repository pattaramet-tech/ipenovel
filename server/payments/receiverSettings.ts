import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { settings } from "../../drizzle/schema";
import * as db from "../db";
import { defaultReceiverConfig, receiverUpdateSchema, validReceiver, type ReceiverConfig } from "../../shared/paymentReceiver";

export const RECEIVER_KEY = "paymentVerification.receiverConfig";
const LEGACY_TYPE = "paymentVerification.receiverAccountType";
const LEGACY_NUMBER = "paymentVerification.receiverAccountNumber";
export function isReceiverSettingKey(key: string) {
  const normalized = key.trim().toLowerCase();
  return [RECEIVER_KEY, LEGACY_TYPE, LEGACY_NUMBER].some(value => value.toLowerCase() === normalized)
    || normalized.startsWith("paymentverification.receiveraudit.");
}
function decode(rows: { key: string; value: string | null }[]): ReceiverConfig {
  const raw = rows.find(r => r.key === RECEIVER_KEY);
  if (raw) {
    try {
      const v = JSON.parse(raw.value ?? "");
      if (!v || typeof v.accountType !== "string" || typeof v.accountNumber !== "string" ||
          !Number.isSafeInteger(v.revision) || v.revision < 0) throw Error();
      return { accountType: v.accountType, accountNumber: v.accountNumber, revision: v.revision,
        updatedAt: typeof v.updatedAt === "string" ? v.updatedAt : null,
        updatedBy: Number.isSafeInteger(v.updatedBy) ? v.updatedBy : null };
    } catch { throw new TRPCError({ code: "PRECONDITION_FAILED", message: "INVALID_PROVIDER_RECEIVER_SETTINGS" }); }
  }
  return { ...defaultReceiverConfig,
    accountType: rows.find(r => r.key === LEGACY_TYPE)?.value?.trim() ?? "",
    accountNumber: rows.find(r => r.key === LEGACY_NUMBER)?.value?.trim() ?? "" };
}
async function connection() {
  const database = await db.getDb();
  if (!database) throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "RECEIVER_SETTINGS_UNAVAILABLE" });
  return database;
}
export async function readReceiverConfig(): Promise<ReceiverConfig> {
  const database = await connection();
  return decode(await database.select().from(settings).where(inArray(settings.key, [RECEIVER_KEY, LEGACY_TYPE, LEGACY_NUMBER])));
}
export async function getReceiverCondition() {
  const v = await readReceiverConfig();
  if (!v.accountType && !v.accountNumber) return undefined;
  if (!validReceiver(v.accountType, v.accountNumber)) throw new Error("INVALID_PROVIDER_RECEIVER_SETTINGS");
  return { accountType: v.accountType, accountNumber: v.accountNumber };
}
export async function saveReceiverConfig(raw: unknown, actorId: number): Promise<ReceiverConfig> {
  const input = receiverUpdateSchema.parse(raw);
  const database = await connection();
  return database.transaction(async tx => {
    // Atomic single-row policy: readers cannot observe a mixed type/number pair.
    await tx.insert(settings).values({ key: RECEIVER_KEY, value: JSON.stringify(defaultReceiverConfig) })
      .onDuplicateKeyUpdate({ set: { key: RECEIVER_KEY } });
    const rows = await tx.select().from(settings).where(eq(settings.key, RECEIVER_KEY)).limit(1).for("update");
    const current = decode(rows);
    if (input.expectedRevision !== current.revision)
      throw new TRPCError({ code: "CONFLICT", message: "การตั้งค่าเปลี่ยนแล้ว กรุณาโหลดค่าล่าสุด" });
    const next: ReceiverConfig = { accountType: input.accountType, accountNumber: input.accountNumber,
      revision: current.revision + 1, updatedAt: new Date().toISOString(), updatedBy: actorId };
    await tx.update(settings).set({ value: JSON.stringify(next) }).where(eq(settings.key, RECEIVER_KEY));
    await tx.insert(settings).values({ key: "paymentVerification.receiverAudit." + randomUUID(),
      value: JSON.stringify({ revision: next.revision, actorId, at: next.updatedAt, reason: input.reason,
        accountType: next.accountType, recipientChanged: current.accountType !== next.accountType || current.accountNumber !== next.accountNumber }),
      description: "Payment provider receiver configuration audit" });
    return next;
  });
}
