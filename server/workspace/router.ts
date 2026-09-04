import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { authenticatedProcedure, router } from "../_core/trpc";
import { WORKSPACE_ROLES } from "./domain";
import {
  addOrUpdateMember,
  bindPublicationNovel,
  createWorkspace,
  getWorkspaceDetail,
  listMigrationOwnership,
  listReadOnlyBindings,
  listWorkspacesForUser,
  WorkspaceServiceError,
} from "./service";

/**
 * M01 intentionally uses session authentication rather than the standard gated procedure:
 * Workspace membership is its own authorization boundary and it must not imply
 * a Google Docs connection or change the existing login scope.
 */
function mapWorkspaceError(error: unknown): never {
  if (error instanceof WorkspaceServiceError) {
    const code =
      error.code === "WORKSPACE_NOT_FOUND" || error.code === "NOVEL_NOT_FOUND"
        ? "NOT_FOUND"
        : error.code === "MEMBERSHIP_REQUIRED" || error.code === "OWNER_ROLE_REQUIRED"
          ? "FORBIDDEN"
          : error.code === "INVALID_MEMBERSHIP_CHANGE" || error.code === "MEMBERSHIP_CONFLICT"
            ? "CONFLICT"
            : "SERVICE_UNAVAILABLE";
    throw new TRPCError({ code, message: error.message });
  }
  throw error;
}

const workspaceIdInput = z.object({ workspaceId: z.number().int().positive() });

export const workspaceRouter = router({
  list: authenticatedProcedure.query(async ({ ctx }) => {
    try {
      return await listWorkspacesForUser(ctx.user.id);
    } catch (error) {
      return mapWorkspaceError(error);
    }
  }),

  create: authenticatedProcedure
    .input(z.object({ name: z.string().trim().min(1).max(160) }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await createWorkspace(ctx.user.id, input.name);
      } catch (error) {
        return mapWorkspaceError(error);
      }
    }),

  detail: authenticatedProcedure
    .input(workspaceIdInput)
    .query(async ({ ctx, input }) => {
      try {
        return await getWorkspaceDetail(ctx.user.id, input.workspaceId);
      } catch (error) {
        return mapWorkspaceError(error);
      }
    }),

  members: router({
    addOrUpdate: authenticatedProcedure
      .input(workspaceIdInput.extend({
        userId: z.number().int().positive(),
        role: z.enum(WORKSPACE_ROLES).exclude(["owner"]),
      }))
      .mutation(async ({ ctx, input }) => {
        try {
          return await addOrUpdateMember({ actorUserId: ctx.user.id, ...input });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
  }),

  bindings: router({
    list: authenticatedProcedure
      .input(workspaceIdInput)
      .query(async ({ ctx, input }) => {
        try {
          return await listReadOnlyBindings(ctx.user.id, input.workspaceId);
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
    bindPublicationNovel: authenticatedProcedure
      .input(workspaceIdInput.extend({ novelId: z.number().int().positive() }))
      .mutation(async ({ ctx, input }) => {
        try {
          return await bindPublicationNovel({ actorUserId: ctx.user.id, ...input });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
  }),

  migrationOwnership: authenticatedProcedure
    .input(workspaceIdInput)
    .query(async ({ ctx, input }) => {
      try {
        return await listMigrationOwnership(ctx.user.id, input.workspaceId);
      } catch (error) {
        return mapWorkspaceError(error);
      }
    }),
});
