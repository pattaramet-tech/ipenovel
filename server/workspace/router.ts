import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { authenticatedProcedure, router } from "../_core/trpc";
import { WORKSPACE_ROLES } from "./domain";
import {
  cancelAiJob,
  getAiJobDetail,
  listAiJobs,
  queueAiJob,
  retryAiJob,
  WorkspaceAiQueueError,
} from "./aiQueue.service";
import {
  getAiQcOperationalReadModel,
  WorkspaceAiQcReconciliationError,
} from "./aiQcReconciliation.service";
import {
  compareCheckerRunWithCopiedLegacy,
  createKanbanBoard,
  createKanbanCardFromFingerprint,
  getCheckerRunDetail,
  listCheckerRuns,
  listDualRunState,
  listOperationalReconciliationState,
  publishCheckerRuleSet,
  reconcileCopiedLegacyOperationalState,
  queueCheckerRun,
  transitionKanbanCard,
  WorkspaceCheckerKanbanError,
} from "./checkerKanban.service";
import {
  listDocumentFingerprints,
  WorkspaceDocsServiceError,
} from "./googleDocs.service";
import {
  createPublishDestination,
  createPublishDryRun,
  getPublishRunDetail,
  listPublishDestinations,
  previewPublishReconciliation,
  WorkspacePublishDryRunError,
} from "./publishDryRun.service";
import {
  requestPublishExecution,
  WorkspacePublishExecutionError,
} from "./publishExecution.service";
import {
  getPublishCutoverReadiness,
  rehearsePublishCutoverRollback,
  WorkspacePublishCutoverError,
} from "./publishCutover.service";
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
  if (error instanceof WorkspacePublishCutoverError) {
    const code =
      error.code === "MEMBERSHIP_REQUIRED"
        ? "FORBIDDEN"
        : error.code === "DATABASE_UNAVAILABLE"
          ? "SERVICE_UNAVAILABLE"
          : error.code === "PUBLISH_RUN_NOT_FOUND"
            ? "NOT_FOUND"
            : error.code === "PUBLISH_OWNERSHIP_AMBIGUOUS"
              ? "CONFLICT"
              : "BAD_REQUEST";
    throw new TRPCError({ code, message: error.message });
  }
  if (error instanceof WorkspacePublishExecutionError) {
    const code =
      error.code === "MEMBERSHIP_REQUIRED" || error.code === "EDITOR_ROLE_REQUIRED"
        ? "FORBIDDEN"
        : error.code === "DATABASE_UNAVAILABLE"
          ? "SERVICE_UNAVAILABLE"
          : error.code === "PUBLISH_RUN_NOT_FOUND" || error.code === "OUTBOX_NOT_FOUND"
            ? "NOT_FOUND"
            : error.code === "EXECUTION_DISABLED" || error.code === "EXTERNAL_PROVIDER_DISABLED"
              ? "PRECONDITION_FAILED"
              : error.code.endsWith("_CONFLICT") || error.code === "STALE_PUBLISH_HASH" || error.code === "PUBLISH_OWNERSHIP_AMBIGUOUS" || error.code === "OUTBOX_LEASE_INVALID"
                ? "CONFLICT"
                : "BAD_REQUEST";
    throw new TRPCError({ code, message: error.message });
  }
  if (error instanceof WorkspacePublishDryRunError) {
    const code =
      error.code === "MEMBERSHIP_REQUIRED" || error.code === "EDITOR_ROLE_REQUIRED"
        ? "FORBIDDEN"
        : error.code === "DATABASE_UNAVAILABLE"
          ? "SERVICE_UNAVAILABLE"
          : error.code === "DESTINATION_NOT_FOUND" || error.code === "PUBLISH_RUN_NOT_FOUND" || error.code === "SNAPSHOT_NOT_BOUND"
            ? "NOT_FOUND"
            : error.code === "STALE_PUBLISH_HASH" || error.code === "PUBLISH_OWNERSHIP_AMBIGUOUS" || error.code.endsWith("_CONFLICT")
              ? "CONFLICT"
              : "BAD_REQUEST";
    throw new TRPCError({ code, message: error.message });
  }
  if (error instanceof WorkspaceAiQcReconciliationError) {
    const code =
      error.code === "MEMBERSHIP_REQUIRED" || error.code === "EDITOR_ROLE_REQUIRED"
        ? "FORBIDDEN"
        : error.code === "DATABASE_UNAVAILABLE"
          ? "SERVICE_UNAVAILABLE"
          : error.code === "AI_JOB_NOT_FOUND"
            ? "NOT_FOUND"
            : error.code.startsWith("RECOVERY_")
              ? "CONFLICT"
              : "BAD_REQUEST";
    throw new TRPCError({ code, message: error.message });
  }
  if (error instanceof WorkspaceAiQueueError) {
    const code =
      error.code === "MEMBERSHIP_REQUIRED" || error.code === "EDITOR_ROLE_REQUIRED"
        ? "FORBIDDEN"
        : error.code === "DATABASE_UNAVAILABLE"
          ? "SERVICE_UNAVAILABLE"
          : error.code === "AI_JOB_NOT_FOUND" || error.code === "AI_ATTEMPT_NOT_FOUND" || error.code === "SNAPSHOT_NOT_BOUND"
            ? "NOT_FOUND"
            : error.code.endsWith("_CONFLICT") || error.code === "AI_LEASE_INVALID"
              ? "CONFLICT"
              : "BAD_REQUEST";
    throw new TRPCError({ code, message: error.message });
  }
  if (error instanceof WorkspaceCheckerKanbanError) {
    const code =
      error.code === "MEMBERSHIP_REQUIRED" || error.code === "EDITOR_ROLE_REQUIRED"
        ? "FORBIDDEN"
        : error.code === "DATABASE_UNAVAILABLE"
          ? "SERVICE_UNAVAILABLE"
          : error.code.endsWith("_NOT_FOUND") || error.code === "SNAPSHOT_NOT_BOUND"
            ? "NOT_FOUND"
            : error.code.endsWith("_CONFLICT") || error.code === "KANBAN_CONFLICT"
              ? "CONFLICT"
              : "BAD_REQUEST";
    throw new TRPCError({ code, message: error.message });
  }
  if (error instanceof WorkspaceDocsServiceError) {
    const code =
      error.code === "MEMBERSHIP_REQUIRED"
        ? "FORBIDDEN"
        : error.code === "DATABASE_UNAVAILABLE"
          ? "SERVICE_UNAVAILABLE"
          : "BAD_REQUEST";
    throw new TRPCError({ code, message: error.message });
  }
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

  fingerprints: router({
    list: authenticatedProcedure
      .input(workspaceIdInput)
      .query(async ({ ctx, input }) => {
        try {
          return await listDocumentFingerprints({
            actorUserId: ctx.user.id,
            workspaceId: input.workspaceId,
          });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
  }),

  checker: router({
    publishRuleSet: authenticatedProcedure
      .input(workspaceIdInput.extend({
        name: z.string().trim().min(1).max(160),
        versionNo: z.number().int().positive(),
        engineVersion: z.string().trim().min(1).max(120),
        rulesJson: z.string().min(2),
      }))
      .mutation(async ({ ctx, input }) => {
        try {
          JSON.parse(input.rulesJson);
          return await publishCheckerRuleSet({ actorUserId: ctx.user.id, ...input });
        } catch (error) {
          if (error instanceof SyntaxError) {
            throw new TRPCError({ code: "BAD_REQUEST", message: "rulesJson must be valid JSON." });
          }
          return mapWorkspaceError(error);
        }
      }),
    queueRun: authenticatedProcedure
      .input(workspaceIdInput.extend({
        snapshotId: z.number().int().positive(),
        ruleSetId: z.number().int().positive(),
      }))
      .mutation(async ({ ctx, input }) => {
        try {
          return await queueCheckerRun({ actorUserId: ctx.user.id, ...input });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
    listRuns: authenticatedProcedure
      .input(workspaceIdInput)
      .query(async ({ ctx, input }) => {
        try {
          return await listCheckerRuns({ actorUserId: ctx.user.id, workspaceId: input.workspaceId });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
    runDetail: authenticatedProcedure
      .input(workspaceIdInput.extend({ runId: z.number().int().positive() }))
      .query(async ({ ctx, input }) => {
        try {
          return await getCheckerRunDetail({ actorUserId: ctx.user.id, ...input });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
    compareCopiedLegacy: authenticatedProcedure
      .input(workspaceIdInput.extend({
        runId: z.number().int().positive(),
        legacyFindings: z.array(z.object({
          ruleKey: z.string().trim().min(1).max(160),
          severity: z.enum(["info", "warning", "error"]),
          locationKey: z.string().trim().min(1).max(255),
          excerptSha256: z.string().regex(/^[a-f0-9]{64}$/i),
        })),
      }))
      .query(async ({ ctx, input }) => {
        try {
          return await compareCheckerRunWithCopiedLegacy({ actorUserId: ctx.user.id, ...input });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
  }),

  aiQueue: router({
    queue: authenticatedProcedure
      .input(workspaceIdInput.extend({
        snapshotId: z.number().int().positive(),
        operation: z.string().trim().min(1).max(120),
        promptVersion: z.string().trim().min(1).max(120),
        modelPolicyVersion: z.string().trim().min(1).max(120),
        priority: z.number().int().min(-1000).max(1000).optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        try {
          return await queueAiJob({ actorUserId: ctx.user.id, ...input });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
    retry: authenticatedProcedure
      .input(workspaceIdInput.extend({ jobId: z.number().int().positive() }))
      .mutation(async ({ ctx, input }) => {
        try {
          return await retryAiJob({ actorUserId: ctx.user.id, ...input });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
    cancel: authenticatedProcedure
      .input(workspaceIdInput.extend({ jobId: z.number().int().positive() }))
      .mutation(async ({ ctx, input }) => {
        try {
          return await cancelAiJob({ actorUserId: ctx.user.id, ...input });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
    list: authenticatedProcedure
      .input(workspaceIdInput)
      .query(async ({ ctx, input }) => {
        try {
          return await listAiJobs({ actorUserId: ctx.user.id, workspaceId: input.workspaceId });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
    detail: authenticatedProcedure
      .input(workspaceIdInput.extend({ jobId: z.number().int().positive() }))
      .query(async ({ ctx, input }) => {
        try {
          return await getAiJobDetail({ actorUserId: ctx.user.id, ...input });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
    operational: authenticatedProcedure
      .input(workspaceIdInput.extend({ jobId: z.number().int().positive() }))
      .query(async ({ ctx, input }) => {
        try {
          return await getAiQcOperationalReadModel({ actorUserId: ctx.user.id, ...input });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
  }),

  publishDryRun: router({
    createDestination: authenticatedProcedure
      .input(workspaceIdInput.extend({
        workspaceNovelId: z.number().int().positive(),
        targetType: z.literal("novel"),
        targetId: z.number().int().positive(),
        policyVersion: z.string().trim().min(1).max(120),
      }))
      .mutation(async ({ ctx, input }) => {
        try {
          return await createPublishDestination({ actorUserId: ctx.user.id, ...input });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
    listDestinations: authenticatedProcedure
      .input(workspaceIdInput)
      .query(async ({ ctx, input }) => {
        try {
          return await listPublishDestinations({ actorUserId: ctx.user.id, workspaceId: input.workspaceId });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
    createPlan: authenticatedProcedure
      .input(workspaceIdInput.extend({
        destinationId: z.number().int().positive(),
        snapshotId: z.number().int().positive(),
        checkerRunId: z.number().int().positive().optional(),
        expectedLastPublishedSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
        items: z.array(z.object({
          itemKey: z.string().trim().min(1).max(255),
          episodeId: z.number().int().positive().optional(),
          sourceSha256: z.string().regex(/^[a-f0-9]{64}$/i),
        })).min(1).max(500),
      }))
      .mutation(async ({ ctx, input }) => {
        try {
          return await createPublishDryRun({ actorUserId: ctx.user.id, ...input });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
    detail: authenticatedProcedure
      .input(workspaceIdInput.extend({ runId: z.number().int().positive() }))
      .query(async ({ ctx, input }) => {
        try {
          return await getPublishRunDetail({ actorUserId: ctx.user.id, ...input });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
    previewReconciliation: authenticatedProcedure
      .input(workspaceIdInput.extend({
        runId: z.number().int().positive(),
        observedResults: z.array(z.object({
          itemKey: z.string().trim().min(1).max(255),
          status: z.enum(["published", "failed", "pending"]),
          providerReceipt: z.string().trim().min(1).max(500).optional(),
          errorClass: z.string().trim().min(1).max(160).optional(),
        })).max(500),
      }))
      .query(async ({ ctx, input }) => {
        try {
          return await previewPublishReconciliation({ actorUserId: ctx.user.id, ...input });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
    requestExecution: authenticatedProcedure
      .input(workspaceIdInput.extend({ runId: z.number().int().positive() }))
      .mutation(async ({ ctx, input }) => {
        try {
          return await requestPublishExecution({
            actorUserId: ctx.user.id,
            workspaceId: input.workspaceId,
            runId: input.runId,
            executionEnabled: process.env.WORKSPACE_PUBLISH_EXECUTION_ENABLED === "true",
          });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
  }),

  publishCutover: router({
    readiness: authenticatedProcedure
      .input(workspaceIdInput.extend({ runId: z.number().int().positive() }))
      .query(async ({ ctx, input }) => {
        try {
          return await getPublishCutoverReadiness({ actorUserId: ctx.user.id, ...input });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
    rehearse: authenticatedProcedure
      .input(workspaceIdInput.extend({ runId: z.number().int().positive() }))
      .query(async ({ ctx, input }) => {
        try {
          return await rehearsePublishCutoverRollback({ actorUserId: ctx.user.id, ...input });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
  }),

  kanban: router({
    createBoard: authenticatedProcedure
      .input(workspaceIdInput.extend({
        name: z.string().trim().min(1).max(160),
        slug: z.string().trim().min(1).max(120),
        columns: z.array(z.object({
          key: z.string().trim().min(1).max(80),
          name: z.string().trim().min(1).max(160),
          position: z.number().int().nonnegative(),
          wipLimit: z.number().int().positive().optional(),
        })).min(1),
      }))
      .mutation(async ({ ctx, input }) => {
        try {
          return await createKanbanBoard({ actorUserId: ctx.user.id, ...input });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
    createCardFromFingerprint: authenticatedProcedure
      .input(workspaceIdInput.extend({
        boardId: z.number().int().positive(),
        columnKey: z.string().trim().min(1).max(80),
        bindingId: z.number().int().positive(),
        logicalItemKey: z.string().trim().min(1).max(255),
        rank: z.number().int().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        try {
          return await createKanbanCardFromFingerprint({ actorUserId: ctx.user.id, ...input });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
    transitionCard: authenticatedProcedure
      .input(workspaceIdInput.extend({
        cardId: z.number().int().positive(),
        toColumnKey: z.string().trim().min(1).max(80),
        reason: z.string().trim().min(1).max(500),
        idempotencyKey: z.string().trim().min(1).max(255),
        expectedVersion: z.number().int().positive(),
      }))
      .mutation(async ({ ctx, input }) => {
        try {
          return await transitionKanbanCard({ actorUserId: ctx.user.id, ...input });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
  }),

  operationalState: authenticatedProcedure
    .input(workspaceIdInput)
    .query(async ({ ctx, input }) => {
      try {
        return await listOperationalReconciliationState({
          actorUserId: ctx.user.id,
          workspaceId: input.workspaceId,
        });
      } catch (error) {
        return mapWorkspaceError(error);
      }
    }),

  reconcileCopiedLegacy: authenticatedProcedure
    .input(workspaceIdInput.extend({
      baselines: z.array(z.object({
        bindingId: z.number().int().positive(),
        runId: z.number().int().positive(),
        providerRevisionId: z.string().trim().min(1).max(255),
        normalizedSha256: z.string().regex(/^[a-f0-9]{64}$/i),
        ruleSetContentSha256: z.string().regex(/^[a-f0-9]{64}$/i),
        legacyFindings: z.array(z.object({
          ruleKey: z.string().trim().min(1).max(160),
          severity: z.enum(["info", "warning", "error"]),
          locationKey: z.string().trim().min(1).max(255),
          excerptSha256: z.string().regex(/^[a-f0-9]{64}$/i),
        })),
      })),
    }))
    .query(async ({ ctx, input }) => {
      try {
        return await reconcileCopiedLegacyOperationalState({
          actorUserId: ctx.user.id,
          workspaceId: input.workspaceId,
          baselines: input.baselines,
        });
      } catch (error) {
        return mapWorkspaceError(error);
      }
    }),

  dualRunState: authenticatedProcedure
    .input(workspaceIdInput)
    .query(async ({ ctx, input }) => {
      try {
        return await listDualRunState({ actorUserId: ctx.user.id, workspaceId: input.workspaceId });
      } catch (error) {
        return mapWorkspaceError(error);
      }
    }),
});
