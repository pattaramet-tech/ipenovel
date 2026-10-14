import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { authorContentProcedure, router } from "../_core/trpc";
import {
  getAuthorWorkspaceDraftReadModel,
  getAuthorWorkspaceReadModel,
  listAuthorWorkspaceNovels,
  listAuthorWorkspaceReadModels,
  listAuthorWorkspaceWorkItems,
} from "./authorRead.service";

/** Independent query-only Author read surface. Admin Workspace stays unchanged. */
const authorReadProcedure = authorContentProcedure.use(({ ctx, next }) => {
  if (ctx.user.role !== "author") throw new TRPCError({ code: "FORBIDDEN" });
  return next({ ctx });
});

const pagination = z.object({
  cursor: z.number().int().positive().safe().optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
const scope = z.object({ workspaceId: z.number().int().positive() });

export const workspaceAuthorReadRouter = router({
  list: authorReadProcedure
    .input(pagination.optional())
    .query(({ ctx, input }) => listAuthorWorkspaceReadModels(ctx.user.id, input)),
  detail: authorReadProcedure
    .input(scope)
    .query(({ ctx, input }) => getAuthorWorkspaceReadModel(ctx.user.id, input.workspaceId)),
  novels: authorReadProcedure
    .input(scope.merge(pagination))
    .query(({ ctx, input }) => listAuthorWorkspaceNovels(ctx.user.id, input.workspaceId, input)),
  workItems: authorReadProcedure
    .input(scope.merge(pagination))
    .query(({ ctx, input }) => listAuthorWorkspaceWorkItems(ctx.user.id, input.workspaceId, input)),
  draft: authorReadProcedure
    .input(scope.extend({ workItemId: z.number().int().positive() }))
    .query(({ ctx, input }) =>
      getAuthorWorkspaceDraftReadModel(ctx.user.id, input.workspaceId, input.workItemId)),
});
