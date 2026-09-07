import { TRPCError } from "@trpc/server";
import { authenticatedProcedure, router } from "../_core/trpc";
import { receiverUpdateSchema } from "../../shared/paymentReceiver";
import { readReceiverConfig, saveReceiverConfig } from "./receiverSettings";
const adminProcedure = authenticatedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN" });
  return next({ ctx });
});
export const paymentReceiverSettingsRouter = router({
  get: adminProcedure.query(() => readReceiverConfig()),
  update: adminProcedure.input(receiverUpdateSchema).mutation(({ ctx, input }) => saveReceiverConfig(input, ctx.user.id)),
});
