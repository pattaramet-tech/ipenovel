import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { settings } from "../../drizzle/schema";
import { getDb } from "../db";
import { authenticatedProcedure, router } from "../_core/trpc";

export const AUTO_APPROVE_KEY = "provider_auto_approve";
export const autoPolicySchema = z.object({
 enabled: z.boolean(), expectedRevision: z.number().int().nonnegative(), reason: z.string().trim().min(1).max(300),
}).strict();
export const defaultAutoPolicy = { enabled: false, revision: 0, updatedAt: null as string | null, updatedBy: null as number | null };
export function parseAutoPolicy(value?: string | null) {
 if (value == null) return { ...defaultAutoPolicy };
 const data = JSON.parse(value);
 if (typeof data?.enabled !== "boolean" || !Number.isSafeInteger(data.revision) || data.revision < 0) throw Error("INVALID_AUTO_APPROVE_SETTINGS");
 return { enabled: data.enabled as boolean, revision: data.revision as number,
  updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : null,
  updatedBy: Number.isSafeInteger(data.updatedBy) ? data.updatedBy as number : null };
}
export function isAutoPolicyKey(key: string) {
 const k = key.trim().toLowerCase();
 return k === AUTO_APPROVE_KEY || k.startsWith("paymentverification.autoaudit.");
}
export async function readAutoPolicy(tx?: any) {
 const database = tx ?? await getDb();
 if (!database) throw Error("AUTO_APPROVE_SETTINGS_UNAVAILABLE");
 const query = database.select().from(settings).where(eq(settings.key, AUTO_APPROVE_KEY)).limit(1);
 const rows = tx ? await query.for("update") : await query;
 return parseAutoPolicy(rows[0]?.value);
}
export async function saveAutoPolicy(raw: unknown, actorId: number) {
 const input = autoPolicySchema.parse(raw);
 const database = await getDb();
 if (!database) throw Error("AUTO_APPROVE_SETTINGS_UNAVAILABLE");
 return database.transaction(async tx => {
  await tx.insert(settings).values({ key: AUTO_APPROVE_KEY, value: JSON.stringify(defaultAutoPolicy) })
   .onDuplicateKeyUpdate({ set: { key: AUTO_APPROVE_KEY } });
  const rows = await tx.select().from(settings).where(eq(settings.key, AUTO_APPROVE_KEY)).limit(1).for("update");
  const old = parseAutoPolicy(rows[0]?.value);
  if (old.revision !== input.expectedRevision) throw new TRPCError({ code: "CONFLICT", message: "การตั้งค่าเปลี่ยนแล้ว กรุณาโหลดค่าล่าสุด" });
  const next = { enabled: input.enabled, revision: old.revision + 1, updatedAt: new Date().toISOString(), updatedBy: actorId };
  await tx.update(settings).set({ value: JSON.stringify(next) }).where(eq(settings.key, AUTO_APPROVE_KEY));
  await tx.insert(settings).values({ key: "paymentVerification.autoAudit." + randomUUID(),
   value: JSON.stringify({ ...next, reason: input.reason }), description: "Provider auto approval policy audit" });
  return next;
 });
}
const admin = authenticatedProcedure.use(({ctx, next}) => {
 if (ctx.user.role !== "admin") throw new TRPCError({code:"FORBIDDEN"});
 return next({ctx});
});
export const autoApprovalSettingsRouter = router({
 get: admin.query(() => readAutoPolicy()),
 update: admin.input(autoPolicySchema).mutation(({input,ctx}) => saveAutoPolicy(input,ctx.user.id)),
});
