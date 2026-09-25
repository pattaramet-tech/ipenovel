import { TRPCError } from "@trpc/server";
import { z } from "zod";

import { authenticatedProcedure, router } from "../../_core/trpc";
import {
  NqaAdminStartRunInputSchema,
  NqaAdminWritebackColumnSchema,
} from "./contracts";
import {
  NqaAdminRuntimeError,
  getNqaAdminRun,
  getNqaAdminStatus,
  listNqaAdminRuns,
  processNqaAdminRunNext,
  startNqaAdminRun,
} from "./runtime";
import {
  NqaAdminWritebackError,
  confirmNqaAdminWriteback,
  previewNqaAdminWriteback,
} from "./writeback";

const adminProcedure = authenticatedProcedure.use(async ({ ctx, next }) => {
  if (ctx.user.role !== "admin") {
    throw new TRPCError({ code: "FORBIDDEN" });
  }
  return next({ ctx });
});

function mapNqaAdminError(error: unknown): TRPCError {
  if (error instanceof NqaAdminRuntimeError) {
    const code =
      error.code === "GOOGLE_CONNECTION_NOT_READY" ||
      error.code === "RUNTIME_NOT_READY"
        ? "PRECONDITION_FAILED"
        : error.code === "RUN_COMPLETE"
          ? "CONFLICT"
          : "BAD_REQUEST";
    return new TRPCError({
      code,
      message: error.message,
    });
  }

  if (error instanceof NqaAdminWritebackError) {
    const code =
      error.code === "WRITEBACK_DISABLED" ||
      error.code === "WRITE_CREDENTIAL_MISSING" ||
      error.code === "WRITE_SCOPE_MISSING"
        ? "PRECONDITION_FAILED"
        : error.code === "PREVIEW_STALE"
          ? "CONFLICT"
          : "BAD_REQUEST";
    return new TRPCError({
      code,
      message: error.message,
    });
  }

  console.error("[NQA Admin] unexpected runtime failure", {
    name: error instanceof Error ? error.name : "UnknownError",
  });
  return new TRPCError({
    code: "INTERNAL_SERVER_ERROR",
    message: "NQA operation failed. Review runtime readiness and try again.",
  });
}

export const nqaAdminRouter = router({
  status: adminProcedure.query(async ({ ctx }) => {
    try {
      return await getNqaAdminStatus(ctx.user.id);
    } catch (error) {
      throw mapNqaAdminError(error);
    }
  }),

  startRun: adminProcedure
    .input(NqaAdminStartRunInputSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        return await startNqaAdminRun(ctx.user.id, input);
      } catch (error) {
        throw mapNqaAdminError(error);
      }
    }),

  processNext: adminProcedure
    .input(
      z.object({
        runId: z.string().regex(/^nqa-admin-[a-f0-9-]{36}$/),
      })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await processNqaAdminRunNext(ctx.user.id, input.runId);
      } catch (error) {
        throw mapNqaAdminError(error);
      }
    }),

  run: adminProcedure
    .input(
      z.object({
        runId: z.string().regex(/^nqa-admin-[a-f0-9-]{36}$/),
      })
    )
    .query(async ({ ctx, input }) => {
      try {
        return await getNqaAdminRun(ctx.user.id, input.runId);
      } catch (error) {
        throw mapNqaAdminError(error);
      }
    }),

  history: adminProcedure
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(100).default(30),
        })
        .optional()
    )
    .query(async ({ ctx, input }) => {
      try {
        return await listNqaAdminRuns(ctx.user.id, input?.limit ?? 30);
      } catch (error) {
        throw mapNqaAdminError(error);
      }
    }),

  previewWriteback: adminProcedure
    .input(
      z.object({
        runId: z.string().regex(/^nqa-admin-[a-f0-9-]{36}$/),
        row: z.number().int().min(2),
        column: NqaAdminWritebackColumnSchema,
      })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await previewNqaAdminWriteback({
          actorUserId: ctx.user.id,
          ...input,
        });
      } catch (error) {
        throw mapNqaAdminError(error);
      }
    }),

  confirmWriteback: adminProcedure
    .input(
      z.object({
        runId: z.string().regex(/^nqa-admin-[a-f0-9-]{36}$/),
        row: z.number().int().min(2),
        column: NqaAdminWritebackColumnSchema,
        previewFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
        confirmation: z.string().min(1).max(200),
      })
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await confirmNqaAdminWriteback({
          actorUserId: ctx.user.id,
          ...input,
        });
      } catch (error) {
        throw mapNqaAdminError(error);
      }
    }),
});
