import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { authorContentProcedure, router } from "../_core/trpc";
import {
  approveAuthorEditorialDraft,
  confirmAuthorEditorialAnomaly,
  editAuthorEditorialDraft,
  getAuthorEditorialSurface,
  resolveAuthorEditorialFinding,
  runAuthorEditorialChecker,
  stageAuthorEditorialDraft,
  undoAuthorEditorialDraft,
} from "./authorEditorial.service";
import { mapWorkspaceError } from "./router";

const authorEditorialProcedure = authorContentProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== "author") throw new TRPCError({ code: "FORBIDDEN" });
  return next({ ctx });
});

const scope = z.object({
  workspaceId: z.number().int().positive(),
  workItemId: z.number().int().positive(),
});

const draftExpectation = scope.extend({
  expectedDraftId: z.number().int().positive(),
  expectedDraftVersion: z.number().int().positive(),
  expectedDraftSha256: z.string().trim().length(64),
  idempotencyKey: z.string().trim().min(1).max(255),
});

const editCommand = z.discriminatedUnion("kind", [
  z.object({
    kind: z.enum(["replace_sentence", "replace_range"]),
    paragraphKey: z.string().trim().length(64),
    expectedParagraphFingerprint: z.string().trim().length(64),
    startOffset: z.number().int().nonnegative(),
    endOffset: z.number().int().nonnegative(),
    expectedText: z.string().max(200000),
    replacementText: z.string().max(200000),
  }),
  z.object({
    kind: z.literal("replace_paragraph"),
    paragraphKey: z.string().trim().length(64),
    expectedParagraphFingerprint: z.string().trim().length(64),
    expectedText: z.string().max(200000),
    replacementText: z.string().max(200000),
  }),
  z.object({
    kind: z.literal("replace_tab"),
    sourceTabId: z.string().trim().min(1).max(255),
    expectedTabStructuralSha256: z.string().trim().length(64),
    expectedText: z.string().max(2_000_000),
    replacementText: z.string().max(2_000_000),
    replacementParagraphKeys: z
      .array(z.union([z.string().trim().length(64), z.literal("")]))
      .max(10_000)
      .optional(),
  }),
]);

export const workspaceAuthorEditorialRouter = router({
  surface: authorEditorialProcedure.input(scope).query(async ({ ctx, input }) => {
    try {
      return await getAuthorEditorialSurface({ actorUserId: ctx.user.id, ...input });
    } catch (error) {
      return mapWorkspaceError(error);
    }
  }),
  edit: authorEditorialProcedure.input(draftExpectation.extend({
    command: editCommand,
    findingId: z.number().int().positive().optional(),
    findingKey: z.string().trim().length(64).optional(),
  })).mutation(async ({ ctx, input }) => {
    try {
      return await editAuthorEditorialDraft({ actorUserId: ctx.user.id, ...input });
    } catch (error) {
      return mapWorkspaceError(error);
    }
  }),
  undo: authorEditorialProcedure.input(draftExpectation).mutation(async ({ ctx, input }) => {
    try {
      return await undoAuthorEditorialDraft({ actorUserId: ctx.user.id, ...input });
    } catch (error) {
      return mapWorkspaceError(error);
    }
  }),
  runChecker: authorEditorialProcedure.input(scope.extend({
    expectedDraftId: z.number().int().positive().optional(),
  })).mutation(async ({ ctx, input }) => {
    try {
      return await runAuthorEditorialChecker({ actorUserId: ctx.user.id, ...input });
    } catch (error) {
      return mapWorkspaceError(error);
    }
  }),
  resolveFinding: authorEditorialProcedure.input(scope.extend({
    findingId: z.number().int().positive(),
    disposition: z.enum(["open", "fixed", "ignored"]),
    note: z.string().trim().max(4000).optional(),
    expectedVersion: z.number().int().nonnegative(),
    idempotencyKey: z.string().trim().min(1).max(255),
  })).mutation(async ({ ctx, input }) => {
    try {
      return await resolveAuthorEditorialFinding({ actorUserId: ctx.user.id, ...input });
    } catch (error) {
      return mapWorkspaceError(error);
    }
  }),
  confirmAnomaly: authorEditorialProcedure.input(scope.extend({
    anomalyId: z.number().int().positive(),
    confirmed: z.boolean(),
    expectedVersion: z.number().int().nonnegative(),
  })).mutation(async ({ ctx, input }) => {
    try {
      return await confirmAuthorEditorialAnomaly({ actorUserId: ctx.user.id, ...input });
    } catch (error) {
      return mapWorkspaceError(error);
    }
  }),
  approve: authorEditorialProcedure.input(draftExpectation.extend({
    expectedCheckerRunId: z.number().int().positive(),
    expectedQcEvidenceSha256: z.string().trim().length(64),
  })).mutation(async ({ ctx, input }) => {
    try {
      return await approveAuthorEditorialDraft({ actorUserId: ctx.user.id, ...input });
    } catch (error) {
      return mapWorkspaceError(error);
    }
  }),
  stage: authorEditorialProcedure.input(draftExpectation.extend({
    approvalId: z.number().int().positive(),
  })).mutation(async ({ ctx, input }) => {
    try {
      return await stageAuthorEditorialDraft({ actorUserId: ctx.user.id, ...input });
    } catch (error) {
      return mapWorkspaceError(error);
    }
  }),
});
