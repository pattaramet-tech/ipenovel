import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { authenticatedProcedure, router } from "../_core/trpc";
import {
  listWorkspaceAiProviderAuditLogsForAdmin,
  listWorkspaceAiProviderProfilesForAdmin,
  saveWorkspaceAiProviderProfile,
  setActiveWorkspaceAiProvider,
  WorkspaceAiProviderConfigError,
} from "./aiProviderConfig.service";
import { WorkspaceAiProviderSecretVaultError } from "./aiProviderSecretVault";

const adminProcedure = authenticatedProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== "admin") throw new TRPCError({ code: "FORBIDDEN" });
  return next({ ctx });
});

function mapError(error: unknown): never {
  if (error instanceof WorkspaceAiProviderConfigError) {
    const code = error.code === "NOT_FOUND" ? "NOT_FOUND"
      : error.code === "CONFLICT" ? "CONFLICT"
        : "BAD_REQUEST";
    throw new TRPCError({ code, message: error.message });
  }
  if (error instanceof WorkspaceAiProviderSecretVaultError) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Workspace AI provider secret vault is not ready." });
  }
  throw error;
}

const saveSchema = z.object({
  id: z.number().int().positive().optional(),
  expectedRevision: z.number().int().positive().optional(),
  name: z.string().min(1).max(160),
  providerType: z.string().min(1).max(80),
  providerName: z.string().min(1).max(120),
  apiUrl: z.string().min(1).max(2048),
  apiKey: z.string().max(16_384).optional(),
  model: z.string().min(1).max(160),
  reconcileUrlTemplate: z.string().max(2048).nullable().optional(),
  timeoutMs: z.number().int().positive().max(120_000).optional(),
  maxInputChars: z.number().int().positive().max(1_000_000).optional(),
  status: z.enum(["enabled", "disabled"]).optional(),
});

export const aiProviderSettingsRouter = router({
  list: adminProcedure.query(async () => {
    try { return await listWorkspaceAiProviderProfilesForAdmin(); }
    catch (error) { mapError(error); }
  }),
  save: adminProcedure.input(saveSchema).mutation(async ({ ctx, input }) => {
    try { return await saveWorkspaceAiProviderProfile(ctx.user.id, input); }
    catch (error) { mapError(error); }
  }),
  setActive: adminProcedure.input(z.object({
    profileId: z.number().int().positive().nullable(),
    expectedStateRevision: z.number().int().nonnegative(),
  })).mutation(async ({ ctx, input }) => {
    try { return await setActiveWorkspaceAiProvider(ctx.user.id, input.profileId, input.expectedStateRevision); }
    catch (error) { mapError(error); }
  }),
  audit: adminProcedure.input(z.object({ limit: z.number().int().positive().max(200).default(50) }).optional()).query(async ({ input }) => {
    try { return await listWorkspaceAiProviderAuditLogsForAdmin(input?.limit ?? 50); }
    catch (error) { mapError(error); }
  }),
});