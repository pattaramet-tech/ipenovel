import { TRPCError } from "@trpc/server";
import { authenticatedProcedure, protectedProcedure, router } from "../_core/trpc";
import { paymentQrRequestSchema, paymentQrUpdateSchema } from "../../shared/paymentQr";
import { readPaymentQrConfig, savePaymentQrConfig } from "./qrSettings";
import { getPaymentQr } from "./qrService";

const adminProcedure = authenticatedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN" });
  return next({ ctx });
});
export const paymentQrSettingsRouter = router({
  get: adminProcedure.query(() => readPaymentQrConfig()),
  update: adminProcedure.input(paymentQrUpdateSchema).mutation(({ ctx, input }) => savePaymentQrConfig(input, ctx.user.id)),
});
export const paymentQrRouter = router({
  get: protectedProcedure.input(paymentQrRequestSchema).query(({ ctx, input }) => getPaymentQr(ctx.user.id, input)),
});
