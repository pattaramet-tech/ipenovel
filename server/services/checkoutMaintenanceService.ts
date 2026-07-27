import { TRPCError } from "@trpc/server";
import { z } from "zod";
import * as db from "../db";
import { safeErrorSummary } from "../../scripts/lib/safeErrorSummary.mjs";

export const CHECKOUT_MAINTENANCE_SETTING_KEY = "checkout_maintenance";

export const checkoutMaintenanceStatusSchema = z.object({
  enabled: z.boolean(),
  scope: z.enum(["notice_only", "slip_only", "all_checkout"]),
  severity: z.enum(["info", "warning", "error"]),
  title: z.string().max(120),
  message: z.string().max(500),
});

export const checkoutMaintenanceAdminInputSchema = checkoutMaintenanceStatusSchema
  .extend({ updatedAt: z.string().datetime().optional() })
  .superRefine((value, ctx) => {
    if (/<[^>]*>/.test(value.title) || /<[^>]*>/.test(value.message)) {
      ctx.addIssue({ code: "custom", message: "Title and message must be plain text" });
    }
    if (value.enabled && (!value.title.trim() || !value.message.trim())) {
      ctx.addIssue({ code: "custom", message: "Title and message are required when enabled" });
    }
  });

export type CheckoutMaintenanceStatus = z.infer<typeof checkoutMaintenanceStatusSchema>;
export type CheckoutMaintenanceAdminInput = z.infer<typeof checkoutMaintenanceAdminInputSchema>;

export const DEFAULT_CHECKOUT_MAINTENANCE_STATUS: CheckoutMaintenanceStatus = {
  enabled: false,
  scope: "notice_only",
  severity: "warning",
  title: "",
  message: "",
};

export async function getCheckoutMaintenanceStatus(): Promise<CheckoutMaintenanceStatus> {
  try {
    const setting = await db.getSetting(CHECKOUT_MAINTENANCE_SETTING_KEY);
    if (!setting?.value) return DEFAULT_CHECKOUT_MAINTENANCE_STATUS;

    const parsed = checkoutMaintenanceStatusSchema.safeParse(JSON.parse(setting.value));
    if (!parsed.success) {
      console.warn("[checkout-maintenance] invalid configuration; failing open");
      return DEFAULT_CHECKOUT_MAINTENANCE_STATUS;
    }
    return parsed.data;
  } catch (error) {
    console.error(`[checkout-maintenance] configuration read failed; failing open: ${safeErrorSummary(error)}`);
    return DEFAULT_CHECKOUT_MAINTENANCE_STATUS;
  }
}

export async function saveCheckoutMaintenanceStatus(
  input: CheckoutMaintenanceAdminInput
): Promise<CheckoutMaintenanceStatus> {
  const validated = checkoutMaintenanceAdminInputSchema.parse(input);
  const status: CheckoutMaintenanceStatus = {
    enabled: validated.enabled,
    scope: validated.scope,
    severity: validated.severity,
    title: validated.title.trim(),
    message: validated.message.trim(),
  };
  await db.setSetting(
    CHECKOUT_MAINTENANCE_SETTING_KEY,
    JSON.stringify({ ...status, updatedAt: new Date().toISOString() }),
    "Checkout maintenance banner and payment-channel availability"
  );
  return status;
}

function maintenanceError(kind: "checkout" | "slip", operation: string, scope: CheckoutMaintenanceStatus["scope"]) {
  const causeCode = kind === "slip" ? "SLIP_PAYMENT_MAINTENANCE" : "CHECKOUT_MAINTENANCE";
  console.warn("[checkout-maintenance] blocked", { scope, operation });
  return new TRPCError({
    code: "SERVICE_UNAVAILABLE",
    message:
      kind === "slip"
        ? "ระบบแนบสลิปปิดให้บริการชั่วคราว กรุณาลองใหม่ภายหลัง"
        : "ระบบชำระเงินปิดให้บริการชั่วคราว กรุณาลองใหม่ภายหลัง",
    cause: { code: causeCode },
  });
}

export async function assertSlipCheckoutAvailable(operation = "slip_checkout"): Promise<void> {
  const status = await getCheckoutMaintenanceStatus();
  if (status.enabled && (status.scope === "slip_only" || status.scope === "all_checkout")) {
    throw maintenanceError(
      status.scope === "all_checkout" ? "checkout" : "slip",
      operation,
      status.scope
    );
  }
}

export async function assertCheckoutAvailable(operation = "checkout"): Promise<void> {
  const status = await getCheckoutMaintenanceStatus();
  if (status.enabled && status.scope === "all_checkout") {
    throw maintenanceError("checkout", operation, status.scope);
  }
}
