import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { adminProcedure, router } from "../_core/trpc";
import { WorkspaceAdminAccessError } from "./adminAccess";
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
  getWorkspacePublishOperationalOverview,
  WorkspaceControlCenterError,
} from "./controlCenter.service";
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
  assignEditorialWorkItem,
  createEditorialEpisodeWorkItem,
  ensureEditorialBoard,
  getEditorialBoard,
  listEditorialAssignees,
  removeEditorialEpisodeWorkItem,
  updateEditorialEpisodeSaleMetadata,
  updateEditorialEpisodeWorkItem,
  updateEditorialWorkItemNote,
  WorkspaceEditorialBoardError,
} from "./editorialBoard.service";
import { projectEditorialBoardSaleFallback } from "./editorialBoardCommerceProjection.service";
import {
  getEditorialDraftReadModel,
  getEditorialSourceSnapshot,
  importEditorialSource,
  WorkspaceEditorialDraftError,
} from "./editorialDraft.service";
import {
  fetchEditorialGoogleDocSource,
  listEditorialGoogleConnections,
  WorkspaceEditorialGoogleSourceError,
} from "./editorialSource.googleDocs";
import {
  getHistoricalPackRepairPreview,
  repairHistoricalPublishedPack,
  WorkspaceHistoricalPackRepairError,
} from "./editorialHistoricalPackRepair.service";
import {
  allowEditorialFindingWord,
  getEditorialForeignCheckerReadModel,
  listEditorialFindingResolutionEvents,
  removeEditorialAllowedWord,
  runEditorialForeignChecker,
  setEditorialFindingDisposition,
  WorkspaceEditorialForeignCheckerError,
} from "./editorialForeignChecker.service";
import {
  applyEditorialEditorEdit,
  excludeEditorialDraftTab,
  getEditorialEditorReadModel,
  restoreEditorialDraftTab,
  undoEditorialEditorEdit,
  WorkspaceEditorialEditorError,
} from "./editorialEditor.service";
import {
  approveEditorialDraft,
  getEditorialApprovalReadModel,
  stageEditorialEpisodeDraft,
  WorkspaceEditorialApprovalError,
} from "./editorialApproval.service";
import {
  getEditorialPublishReadModel,
  prepareEditorialPublishOwnership,
  requestEditorialPublish,
  WorkspaceEditorialPublishError,
} from "./editorialPublish.service";
import { getEditorialEvidenceStatuses } from "./editorialStatus.service";
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
import { requirePreviewPublishExecutionSafety, WorkspacePublishRuntimeError } from "./publishExecution.runtime";
import {
  getPublishCutoverReadiness,
  rehearsePublishCutoverRollback,
  WorkspacePublishCutoverError,
} from "./publishCutover.service";
import {
  cutoverPublishOwnership,
  rollbackPublishOwnership,
  WorkspacePublishOwnershipTransitionError,
} from "./publishOwnershipTransition.service";
import {
  getPublishFinalGatePackage,
  requirePublishFinalGate,
  WorkspacePublishFinalGateError,
} from "./publishFinalGate.service";
import {
  getLegacyRetirementCandidatePackage,
  requireLegacyRetirementCandidate,
  WorkspaceLegacyRetirementError,
} from "./legacyRetirement.service";
import {
  addOrUpdateMember,
  bindPublicationNovel,
  createWorkspace,
  deleteWorkspace,
  createWorkspacePublicationNovel,
  getWorkspaceDetail,
  listMigrationOwnership,
  listPublicationNovelOptions,
  listReadOnlyBindings,
  listWorkspacesForUser,
  unbindPublicationNovel,
  WorkspaceServiceError,
} from "./service";

/**
 * Workspace is an admin-only back-office surface. Every procedure requires a
 * platform-admin session through adminProcedure. Workspace membership rows are
 * retained only for compatibility/history and never grant, restrict, or divide
 * authority between admins. The service layer re-checks the current DB role as
 * defense in depth. Customer-facing Google-connection gating remains bypassed.
 */
function mapWorkspaceError(error: unknown): never {
  if (error instanceof WorkspaceAdminAccessError) {
    throw new TRPCError({ code: "FORBIDDEN", message: error.message });
  }
  if (error instanceof WorkspaceControlCenterError) {
    throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: error.message });
  }
  if (error instanceof WorkspacePublishRuntimeError) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: error.message });
  }
  if (error instanceof WorkspaceLegacyRetirementError) {
    const code =
      error.code === "DATABASE_UNAVAILABLE"
          ? "SERVICE_UNAVAILABLE"
          : error.code === "WORKSPACE_NOVEL_NOT_FOUND"
            ? "NOT_FOUND"
            : error.code === "PUBLISH_OWNERSHIP_AMBIGUOUS" || error.code === "RETIREMENT_CANDIDATE_BLOCKED"
              ? "CONFLICT"
              : "BAD_REQUEST";
    throw new TRPCError({ code, message: error.message });
  }
  if (error instanceof WorkspacePublishFinalGateError) {
    const code =
      error.code === "DATABASE_UNAVAILABLE"
          ? "SERVICE_UNAVAILABLE"
          : error.code === "PUBLISH_OWNERSHIP_AMBIGUOUS" || error.code === "PREVIEW_GATE_BLOCKED"
            ? "CONFLICT"
            : "BAD_REQUEST";
    throw new TRPCError({ code, message: error.message });
  }
  if (error instanceof WorkspacePublishOwnershipTransitionError) {
    const code =
      error.code === "DATABASE_UNAVAILABLE"
          ? "SERVICE_UNAVAILABLE"
          : error.code === "PUBLISH_RUN_NOT_FOUND"
            ? "NOT_FOUND"
            : error.code === "PUBLISH_READINESS_BLOCKED" || error.code === "PUBLISH_OWNERSHIP_AMBIGUOUS" || error.code === "PUBLISH_OWNERSHIP_CONFLICT" || error.code === "STALE_PUBLISH_HASH"
              ? "CONFLICT"
              : "BAD_REQUEST";
    throw new TRPCError({ code, message: error.message });
  }
  if (error instanceof WorkspacePublishCutoverError) {
    const code =
      error.code === "DATABASE_UNAVAILABLE"
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
      error.code === "DATABASE_UNAVAILABLE"
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
      error.code === "DATABASE_UNAVAILABLE"
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
      error.code === "DATABASE_UNAVAILABLE"
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
      error.code === "DATABASE_UNAVAILABLE"
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
      error.code === "DATABASE_UNAVAILABLE"
          ? "SERVICE_UNAVAILABLE"
          : error.code.endsWith("_NOT_FOUND") || error.code === "SNAPSHOT_NOT_BOUND"
            ? "NOT_FOUND"
            : error.code.endsWith("_CONFLICT") || error.code === "KANBAN_CONFLICT"
              ? "CONFLICT"
              : "BAD_REQUEST";
    throw new TRPCError({ code, message: error.message });
  }
  if (error instanceof WorkspaceEditorialBoardError) {
    const code =
      error.code === "DATABASE_UNAVAILABLE"
        ? "SERVICE_UNAVAILABLE"
        : error.code.endsWith("_NOT_FOUND")
          ? "NOT_FOUND"
          : error.code.endsWith("_CONFLICT")
            ? "CONFLICT"
            : "BAD_REQUEST";
    throw new TRPCError({ code, message: error.message });
  }
  if (error instanceof WorkspaceHistoricalPackRepairError) {
    const code =
      error.code === "DATABASE_UNAVAILABLE"
        ? "SERVICE_UNAVAILABLE"
        : error.code === "WORK_ITEM_NOT_FOUND"
          ? "NOT_FOUND"
          : "CONFLICT";
    throw new TRPCError({ code, message: error.message });
  }
  if (error instanceof WorkspaceEditorialDraftError) {
    const code =
      error.code === "DATABASE_UNAVAILABLE"
        ? "SERVICE_UNAVAILABLE"
        : error.code.endsWith("_NOT_FOUND")
          ? "NOT_FOUND"
          : error.code.endsWith("_CONFLICT") ||
              error.code === "REFRESH_REQUIRES_REVIEW"
            ? "CONFLICT"
            : "BAD_REQUEST";
    throw new TRPCError({ code, message: error.message });
  }
  if (error instanceof WorkspaceEditorialGoogleSourceError) {
    const code =
      error.code === "DATABASE_UNAVAILABLE"
        ? "SERVICE_UNAVAILABLE"
        : error.code === "CONNECTION_NOT_FOUND"
          ? "NOT_FOUND"
          : error.code === "CONNECTION_RECONNECT_REQUIRED" ||
              error.code === "RUNTIME_CONFIG_INVALID"
            ? "PRECONDITION_FAILED"
            : "BAD_REQUEST";
    throw new TRPCError({ code, message: error.message });
  }
  if (error instanceof WorkspaceEditorialForeignCheckerError) {
    const code =
      error.code === "DATABASE_UNAVAILABLE"
        ? "SERVICE_UNAVAILABLE"
        : error.code.endsWith("_NOT_FOUND")
          ? "NOT_FOUND"
          : error.code.endsWith("_CONFLICT")
            ? "CONFLICT"
            : "BAD_REQUEST";
    throw new TRPCError({ code, message: error.message });
  }
  if (error instanceof WorkspaceEditorialEditorError) {
    const code =
      error.code === "DATABASE_UNAVAILABLE"
        ? "SERVICE_UNAVAILABLE"
        : error.code.endsWith("_NOT_FOUND")
          ? "NOT_FOUND"
          : error.code.endsWith("_CONFLICT") ||
              error.code === "UNDO_NOT_AVAILABLE"
            ? "CONFLICT"
            : "BAD_REQUEST";
    throw new TRPCError({ code, message: error.message });
  }
  if (error instanceof WorkspaceEditorialApprovalError) {
    const code =
      error.code === "DATABASE_UNAVAILABLE"
        ? "SERVICE_UNAVAILABLE"
        : error.code.endsWith("_NOT_FOUND")
          ? "NOT_FOUND"
          : error.code.endsWith("_CONFLICT") ||
              error.code === "CHECKER_STALE" ||
              error.code === "QC_UNRESOLVED" ||
              error.code === "EPISODE_PUBLISHED" ||
              error.code === "KANBAN_CONFLICT"
            ? "CONFLICT"
            : "BAD_REQUEST";
    throw new TRPCError({ code, message: error.message });
  }
  if (error instanceof WorkspaceEditorialPublishError) {
    const code =
      error.code === "DATABASE_UNAVAILABLE"
        ? "SERVICE_UNAVAILABLE"
        : error.code === "WORK_ITEM_NOT_FOUND"
          ? "NOT_FOUND"
          : "CONFLICT";
    throw new TRPCError({ code, message: error.message });
  }
  if (error instanceof WorkspaceDocsServiceError) {
    const code =
      error.code === "DATABASE_UNAVAILABLE"
          ? "SERVICE_UNAVAILABLE"
          : "BAD_REQUEST";
    throw new TRPCError({ code, message: error.message });
  }
  if (error instanceof WorkspaceServiceError) {
    const code =
      error.code === "WORKSPACE_NOT_FOUND" || error.code === "NOVEL_NOT_FOUND"
        ? "NOT_FOUND"
        : error.code === "INVALID_NOVEL_INPUT"
          ? "BAD_REQUEST"
          : error.code === "INVALID_MEMBERSHIP_CHANGE" || error.code === "MEMBERSHIP_CONFLICT"
            ? "CONFLICT"
            : "SERVICE_UNAVAILABLE";
    throw new TRPCError({ code, message: error.message });
  }
  throw error;
}

const workspaceIdInput = z.object({ workspaceId: z.number().int().positive() });
const editorialSourcePayloadInput = z.object({
  sourceKind: z.enum(["google_doc", "uploaded_file"]),
  sourceKey: z.string().trim().min(1).max(255),
  providerDocumentId: z.string().trim().max(255).nullable().optional(),
  mimeType: z.string().trim().min(1).max(160),
  title: z.string().trim().min(1).max(500),
  revisionKey: z.string().trim().max(255).nullable().optional(),
  tabs: z.array(z.object({
    sourceTabId: z.string().trim().min(1).max(255),
    tabOrder: z.number().int().nonnegative(),
    title: z.string().max(500),
    paragraphs: z.array(z.string().max(200000)).max(10000),
  })).min(1).max(500),
});
const editorialEditCommandInput = z.discriminatedUnion("kind", [
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
]);
const legacyRetirementEvidenceInput = z.object({
  sustainedParity: z.object({ passed: z.boolean(), evidenceRef: z.string().trim().min(1).max(255) }),
  slo: z.object({ passed: z.boolean(), evidenceRef: z.string().trim().min(1).max(255) }),
  rollbackDrill: z.object({ passed: z.boolean(), evidenceRef: z.string().trim().min(1).max(255) }),
  legacyActionFreeze: z.object({ passed: z.boolean(), evidenceRef: z.string().trim().min(1).max(255) }),
});

export const workspaceRouter = router({
  list: adminProcedure.query(async ({ ctx }) => {
    try {
      return await listWorkspacesForUser(ctx.user.id);
    } catch (error) {
      return mapWorkspaceError(error);
    }
  }),

  create: adminProcedure
    .input(z.object({ name: z.string().trim().min(1).max(160) }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await createWorkspace(ctx.user.id, input.name);
      } catch (error) {
        return mapWorkspaceError(error);
      }
    }),

  delete: adminProcedure
    .input(workspaceIdInput)
    .mutation(async ({ ctx, input }) => {
      try {
        return await deleteWorkspace(ctx.user.id, input.workspaceId);
      } catch (error) {
        return mapWorkspaceError(error);
      }
    }),

  detail: adminProcedure
    .input(workspaceIdInput)
    .query(async ({ ctx, input }) => {
      try {
        return await getWorkspaceDetail(ctx.user.id, input.workspaceId);
      } catch (error) {
        return mapWorkspaceError(error);
      }
    }),

  members: router({
    addOrUpdate: adminProcedure
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
    list: adminProcedure
      .input(workspaceIdInput)
      .query(async ({ ctx, input }) => {
        try {
          return await listReadOnlyBindings(ctx.user.id, input.workspaceId);
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
    availablePublicationNovels: adminProcedure
      .input(workspaceIdInput)
      .query(async ({ ctx, input }) => {
        try {
          return await listPublicationNovelOptions(ctx.user.id, input.workspaceId);
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
    removePublicationNovel: adminProcedure
      .input(workspaceIdInput.extend({ workspaceNovelId: z.number().int().positive() }))
      .mutation(async ({ ctx, input }) => {
        try {
          return await unbindPublicationNovel({ actorUserId: ctx.user.id, ...input });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),

    bindPublicationNovel: adminProcedure
      .input(workspaceIdInput.extend({ novelId: z.number().int().positive() }))
      .mutation(async ({ ctx, input }) => {
        try {
          return await bindPublicationNovel({ actorUserId: ctx.user.id, ...input });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
  }),

  migrationOwnership: adminProcedure
    .input(workspaceIdInput)
    .query(async ({ ctx, input }) => {
      try {
        return await listMigrationOwnership(ctx.user.id, input.workspaceId);
      } catch (error) {
        return mapWorkspaceError(error);
      }
    }),

  controlCenter: router({
    publishOverview: adminProcedure
      .input(workspaceIdInput)
      .query(async ({ ctx, input }) => {
        try {
          return await getWorkspacePublishOperationalOverview({
            actorUserId: ctx.user.id,
            workspaceId: input.workspaceId,
          });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
  }),

  fingerprints: router({
    list: adminProcedure
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
    publishRuleSet: adminProcedure
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
    queueRun: adminProcedure
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
    listRuns: adminProcedure
      .input(workspaceIdInput)
      .query(async ({ ctx, input }) => {
        try {
          return await listCheckerRuns({ actorUserId: ctx.user.id, workspaceId: input.workspaceId });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
    runDetail: adminProcedure
      .input(workspaceIdInput.extend({ runId: z.number().int().positive() }))
      .query(async ({ ctx, input }) => {
        try {
          return await getCheckerRunDetail({ actorUserId: ctx.user.id, ...input });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
    compareCopiedLegacy: adminProcedure
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
    queue: adminProcedure
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
    retry: adminProcedure
      .input(workspaceIdInput.extend({ jobId: z.number().int().positive() }))
      .mutation(async ({ ctx, input }) => {
        try {
          return await retryAiJob({ actorUserId: ctx.user.id, ...input });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
    cancel: adminProcedure
      .input(workspaceIdInput.extend({ jobId: z.number().int().positive() }))
      .mutation(async ({ ctx, input }) => {
        try {
          return await cancelAiJob({ actorUserId: ctx.user.id, ...input });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
    list: adminProcedure
      .input(workspaceIdInput)
      .query(async ({ ctx, input }) => {
        try {
          return await listAiJobs({ actorUserId: ctx.user.id, workspaceId: input.workspaceId });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
    detail: adminProcedure
      .input(workspaceIdInput.extend({ jobId: z.number().int().positive() }))
      .query(async ({ ctx, input }) => {
        try {
          return await getAiJobDetail({ actorUserId: ctx.user.id, ...input });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
    operational: adminProcedure
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
    createDestination: adminProcedure
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
    listDestinations: adminProcedure
      .input(workspaceIdInput)
      .query(async ({ ctx, input }) => {
        try {
          return await listPublishDestinations({ actorUserId: ctx.user.id, workspaceId: input.workspaceId });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
    createPlan: adminProcedure
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
    detail: adminProcedure
      .input(workspaceIdInput.extend({ runId: z.number().int().positive() }))
      .query(async ({ ctx, input }) => {
        try {
          return await getPublishRunDetail({ actorUserId: ctx.user.id, ...input });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
    previewReconciliation: adminProcedure
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
    requestExecution: adminProcedure
      .input(workspaceIdInput.extend({
        runId: z.number().int().positive(),
        expectedCutoverEpoch: z.number().int().positive(),
        expectedOwnershipVersion: z.number().int().positive(),
      }))
      .mutation(async ({ ctx, input }) => {
        try {
          const executionEnabled = process.env.WORKSPACE_PUBLISH_EXECUTION_ENABLED === "true";
          const externalProviderEnabled = process.env.WORKSPACE_PUBLISH_EXTERNAL_PROVIDER_ENABLED === "true";
          if (executionEnabled && !externalProviderEnabled) {
            throw new WorkspacePublishExecutionError("EXTERNAL_PROVIDER_DISABLED", "Workspace publish external provider is not enabled.");
          }
          if (executionEnabled) requirePreviewPublishExecutionSafety();
          return await requestPublishExecution({
            actorUserId: ctx.user.id,
            workspaceId: input.workspaceId,
            runId: input.runId,
            expectedCutoverEpoch: input.expectedCutoverEpoch,
            expectedOwnershipVersion: input.expectedOwnershipVersion,
            executionEnabled,
          });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
  }),

  publishFinalGate: router({
    package: adminProcedure
      .input(workspaceIdInput.extend({ runId: z.number().int().positive() }))
      .query(async ({ ctx, input }) => {
        try {
          return await getPublishFinalGatePackage({
            actorUserId: ctx.user.id,
            workspaceId: input.workspaceId,
            runId: input.runId,
            executionEnabled: process.env.WORKSPACE_PUBLISH_EXECUTION_ENABLED === "true",
          });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
    requirePreviewReadiness: adminProcedure
      .input(workspaceIdInput.extend({ runId: z.number().int().positive() }))
      .query(async ({ ctx, input }) => {
        try {
          return await requirePublishFinalGate({
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
    readiness: adminProcedure
      .input(workspaceIdInput.extend({ runId: z.number().int().positive() }))
      .query(async ({ ctx, input }) => {
        try {
          return await getPublishCutoverReadiness({ actorUserId: ctx.user.id, ...input });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
    rehearse: adminProcedure
      .input(workspaceIdInput.extend({ runId: z.number().int().positive() }))
      .query(async ({ ctx, input }) => {
        try {
          return await rehearsePublishCutoverRollback({ actorUserId: ctx.user.id, ...input });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
    cutover: adminProcedure
      .input(workspaceIdInput.extend({
        runId: z.number().int().positive(),
        expectedOwner: z.literal("sheets"),
        expectedCutoverEpoch: z.literal(0),
        expectedVersion: z.number().int().positive(),
      }))
      .mutation(async ({ ctx, input }) => {
        try {
          return await cutoverPublishOwnership({ actorUserId: ctx.user.id, ...input });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
    rollback: adminProcedure
      .input(workspaceIdInput.extend({
        runId: z.number().int().positive(),
        expectedOwner: z.literal("workspace"),
        expectedCutoverEpoch: z.number().int().positive(),
        expectedVersion: z.number().int().positive(),
      }))
      .mutation(async ({ ctx, input }) => {
        try {
          return await rollbackPublishOwnership({ actorUserId: ctx.user.id, ...input });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
  }),

  legacyRetirement: router({
    package: adminProcedure
      .input(workspaceIdInput.extend({
        workspaceNovelId: z.number().int().positive(),
        evidence: legacyRetirementEvidenceInput,
      }))
      .query(async ({ ctx, input }) => {
        try {
          return await getLegacyRetirementCandidatePackage({ actorUserId: ctx.user.id, ...input });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
    requireCandidateReadiness: adminProcedure
      .input(workspaceIdInput.extend({
        workspaceNovelId: z.number().int().positive(),
        evidence: legacyRetirementEvidenceInput,
      }))
      .query(async ({ ctx, input }) => {
        try {
          return await requireLegacyRetirementCandidate({ actorUserId: ctx.user.id, ...input });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
  }),

  editorial: router({
    historicalPackRepairPreview: adminProcedure
      .input(workspaceIdInput.extend({ workItemId: z.number().int().positive() }))
      .query(async ({ ctx, input }) => {
        try {
          return await getHistoricalPackRepairPreview({ actorUserId: ctx.user.id, ...input });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
    repairHistoricalPack: adminProcedure
      .input(workspaceIdInput.extend({
        workItemId: z.number().int().positive(),
        expectedChapterEpisodeIds: z.array(z.number().int().positive()).min(1).max(5000),
        price: z.string().trim().regex(/^\d+(?:\.\d{1,2})?$/),
        isFree: z.boolean(),
      }))
      .mutation(async ({ ctx, input }) => {
        try {
          requirePreviewPublishExecutionSafety();
          return await repairHistoricalPublishedPack({ actorUserId: ctx.user.id, ...input });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
    bulkApproveDrafts: adminProcedure
      .input(workspaceIdInput.extend({ workItemIds: z.array(z.number().int().positive()).min(1).max(100) }))
      .mutation(async ({ ctx, input }) => {
        const results = [];
        for (const workItemId of Array.from(new Set(input.workItemIds))) {
          try {
            const state = await getEditorialApprovalReadModel({ actorUserId: ctx.user.id, workspaceId: input.workspaceId, workItemId });
            if (state.approvalStatus?.valid) { results.push({ workItemId, ok: true as const, skipped: true as const }); continue; }
            if (!state.latestDraft?.id || !state.latestDraft?.version || !state.latestDraft?.contentSha256 || !state.qc?.ready || !state.qc?.checkerRunId || !state.qc?.qcEvidenceSha256) throw new Error(state.qc?.reason ?? "Draft/QC evidence is not ready for approval.");
            await approveEditorialDraft({ actorUserId: ctx.user.id, workspaceId: input.workspaceId, workItemId, expectedDraftId: state.latestDraft.id, expectedDraftVersion: state.latestDraft.version, expectedDraftSha256: state.latestDraft.contentSha256, expectedCheckerRunId: state.qc.checkerRunId, expectedQcEvidenceSha256: state.qc.qcEvidenceSha256, idempotencyKey: `bulk-approve:${input.workspaceId}:${workItemId}:${state.latestDraft.id}:${state.qc.checkerRunId}` });
            results.push({ workItemId, ok: true as const, skipped: false as const });
          } catch (error) { results.push({ workItemId, ok: false as const, error: error instanceof Error ? error.message : String(error) }); }
        }
        return results;
      }),
    bulkStageDrafts: adminProcedure
      .input(workspaceIdInput.extend({ workItemIds: z.array(z.number().int().positive()).min(1).max(100) }))
      .mutation(async ({ ctx, input }) => {
        const results = [];
        for (const workItemId of Array.from(new Set(input.workItemIds))) {
          try {
            const state = await getEditorialApprovalReadModel({ actorUserId: ctx.user.id, workspaceId: input.workspaceId, workItemId });
            if (state.stageStatus?.valid) { results.push({ workItemId, ok: true as const, skipped: true as const }); continue; }
            if (!state.approvalStatus?.valid || !state.approval?.id || !state.latestDraft?.id || !state.latestDraft?.version || !state.latestDraft?.contentSha256) throw new Error(state.approvalStatus?.reason ?? state.stagePlanError ?? "Approval/stage evidence is not ready.");
            await stageEditorialEpisodeDraft({ actorUserId: ctx.user.id, workspaceId: input.workspaceId, workItemId, approvalId: state.approval.id, expectedDraftId: state.latestDraft.id, expectedDraftVersion: state.latestDraft.version, expectedDraftSha256: state.latestDraft.contentSha256, idempotencyKey: `bulk-stage:${input.workspaceId}:${workItemId}:${state.approval.id}:${state.latestDraft.id}` });
            results.push({ workItemId, ok: true as const, skipped: false as const });
          } catch (error) { results.push({ workItemId, ok: false as const, error: error instanceof Error ? error.message : String(error) }); }
        }
        return results;
      }),
    bulkRunChecker: adminProcedure
      .input(workspaceIdInput.extend({ workItemIds: z.array(z.number().int().positive()).min(1).max(100) }))
      .mutation(async ({ ctx, input }) => {
        const results = [];
        for (const workItemId of Array.from(new Set(input.workItemIds))) {
          try {
            const checker = await runEditorialForeignChecker({ actorUserId: ctx.user.id, workspaceId: input.workspaceId, workItemId });
            results.push({
              workItemId,
              ok: true as const,
              runId: checker.run?.id ?? null,
              effectiveStatus: checker.effectiveStatus,
              findingCount: checker.findings.length,
              unresolvedCount: checker.unresolvedCount,
              sampleFindings: checker.findings
                .filter((finding: any) => finding.disposition === "open")
                .slice(0, 5)
                .map((finding: any) => ({ token: finding.token, ruleKey: finding.ruleKey })),
            });
          } catch (error) {
            results.push({ workItemId, ok: false as const, error: error instanceof Error ? error.message : String(error) });
          }
        }
        return results;
      }),
    bulkRequestPublish: adminProcedure
      .input(workspaceIdInput.extend({ workItemIds: z.array(z.number().int().positive()).min(1).max(100) }))
      .mutation(async ({ ctx, input }) => {
        const executionEnabled = process.env.WORKSPACE_PUBLISH_EXECUTION_ENABLED === "true";
        const externalProviderEnabled = process.env.WORKSPACE_PUBLISH_EXTERNAL_PROVIDER_ENABLED === "true";
        if (executionEnabled && !externalProviderEnabled) {
          throw new WorkspacePublishExecutionError("EXTERNAL_PROVIDER_DISABLED", "Workspace publish external provider is not enabled.");
        }
        if (executionEnabled) requirePreviewPublishExecutionSafety();
        const results = [];
        for (const workItemId of Array.from(new Set(input.workItemIds))) {
          try {
            await prepareEditorialPublishOwnership({ actorUserId: ctx.user.id, workspaceId: input.workspaceId, workItemId });
            const state = await getEditorialPublishReadModel({ actorUserId: ctx.user.id, workspaceId: input.workspaceId, workItemId });
            const stagedDraftSha256 = state.stages[0]?.draftSha256;
            if (!state.requestReady || !state.stageSetSha256 || !stagedDraftSha256 || !state.ownership) throw new Error(state.blocker ?? "Publish evidence is incomplete.");
            await requestEditorialPublish({ actorUserId: ctx.user.id, workspaceId: input.workspaceId, workItemId, expectedStageSetSha256: state.stageSetSha256, expectedStagedDraftSha256: stagedDraftSha256, expectedCutoverEpoch: state.ownership.cutoverEpoch, expectedOwnershipVersion: state.ownership.version, executionEnabled });
            results.push({ workItemId, ok: true as const });
          } catch (error) {
            results.push({ workItemId, ok: false as const, error: error instanceof Error ? error.message : String(error) });
          }
        }
        return results;
      }),
    evidenceStatuses: adminProcedure
      .input(workspaceIdInput.extend({
        workItemIds: z.array(z.number().int().positive()).max(500),
      }))
      .query(async ({ ctx, input }) => {
        try {
          return await getEditorialEvidenceStatuses({
            actorUserId: ctx.user.id,
            workspaceId: input.workspaceId,
            workItemIds: input.workItemIds,
          });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
    board: adminProcedure
      .input(workspaceIdInput)
      .query(async ({ ctx, input }) => {
        try {
          const board = await getEditorialBoard({
            actorUserId: ctx.user.id,
            workspaceId: input.workspaceId,
          });
          return board ? await projectEditorialBoardSaleFallback(board) : board;
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
    assignees: adminProcedure
      .input(workspaceIdInput)
      .query(async ({ ctx, input }) => {
        try {
          return await listEditorialAssignees({
            actorUserId: ctx.user.id,
            workspaceId: input.workspaceId,
          });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
    googleConnections: adminProcedure.query(async ({ ctx }) => {
      try {
        return await listEditorialGoogleConnections(ctx.user.id);
      } catch (error) {
        return mapWorkspaceError(error);
      }
    }),
    sourceDraft: adminProcedure
      .input(workspaceIdInput.extend({
        workItemId: z.number().int().positive(),
      }))
      .query(async ({ ctx, input }) => {
        try {
          return await getEditorialDraftReadModel({
            actorUserId: ctx.user.id,
            ...input,
          });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
    sourceSnapshot: adminProcedure
      .input(workspaceIdInput.extend({
        workItemId: z.number().int().positive(),
        snapshotId: z.number().int().positive(),
      }))
      .query(async ({ ctx, input }) => {
        try {
          return await getEditorialSourceSnapshot({
            actorUserId: ctx.user.id,
            ...input,
          });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
    editor: adminProcedure
      .input(workspaceIdInput.extend({
        workItemId: z.number().int().positive(),
      }))
      .query(async ({ ctx, input }) => {
        try {
          return await getEditorialEditorReadModel({
            actorUserId: ctx.user.id,
            ...input,
          });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
    editorExcludeTab: adminProcedure
      .input(workspaceIdInput.extend({ workItemId: z.number().int().positive(), expectedDraftId: z.number().int().positive(), expectedDraftSha256: z.string().trim().length(64), sourceTabId: z.string().trim().min(1).max(255) }))
      .mutation(async ({ ctx, input }) => {
        try { return await excludeEditorialDraftTab({ actorUserId: ctx.user.id, ...input }); }
        catch (error) { return mapWorkspaceError(error); }
      }),
    editorRestoreTab: adminProcedure
      .input(workspaceIdInput.extend({ workItemId: z.number().int().positive(), expectedDraftId: z.number().int().positive(), expectedDraftSha256: z.string().trim().length(64), sourceTabId: z.string().trim().min(1).max(255) }))
      .mutation(async ({ ctx, input }) => {
        try { return await restoreEditorialDraftTab({ actorUserId: ctx.user.id, ...input }); }
        catch (error) { return mapWorkspaceError(error); }
      }),
    editorEdit: adminProcedure
      .input(workspaceIdInput.extend({
        workItemId: z.number().int().positive(),
        expectedDraftId: z.number().int().positive(),
        expectedDraftVersion: z.number().int().positive(),
        expectedDraftSha256: z.string().trim().length(64),
        findingId: z.number().int().positive().optional(),
        findingKey: z.string().trim().length(64).optional(),
        command: editorialEditCommandInput,
        idempotencyKey: z.string().trim().min(1).max(255),
      }))
      .mutation(async ({ ctx, input }) => {
        try {
          return await applyEditorialEditorEdit({
            actorUserId: ctx.user.id,
            ...input,
          });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
    editorUndo: adminProcedure
      .input(workspaceIdInput.extend({
        workItemId: z.number().int().positive(),
        expectedDraftId: z.number().int().positive(),
        expectedDraftVersion: z.number().int().positive(),
        expectedDraftSha256: z.string().trim().length(64),
        idempotencyKey: z.string().trim().min(1).max(255),
      }))
      .mutation(async ({ ctx, input }) => {
        try {
          return await undoEditorialEditorEdit({
            actorUserId: ctx.user.id,
            ...input,
          });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
    approval: adminProcedure
      .input(workspaceIdInput.extend({
        workItemId: z.number().int().positive(),
      }))
      .query(async ({ ctx, input }) => {
        try {
          return await getEditorialApprovalReadModel({
            actorUserId: ctx.user.id,
            ...input,
          });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
    approveDraft: adminProcedure
      .input(workspaceIdInput.extend({
        workItemId: z.number().int().positive(),
        expectedDraftId: z.number().int().positive(),
        expectedDraftVersion: z.number().int().positive(),
        expectedDraftSha256: z.string().trim().length(64),
        expectedCheckerRunId: z.number().int().positive(),
        expectedQcEvidenceSha256: z.string().trim().length(64),
        idempotencyKey: z.string().trim().min(1).max(255),
      }))
      .mutation(async ({ ctx, input }) => {
        try {
          return await approveEditorialDraft({
            actorUserId: ctx.user.id,
            ...input,
          });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
    stageEpisodeDraft: adminProcedure
      .input(workspaceIdInput.extend({
        workItemId: z.number().int().positive(),
        approvalId: z.number().int().positive(),
        expectedDraftId: z.number().int().positive(),
        expectedDraftVersion: z.number().int().positive(),
        expectedDraftSha256: z.string().trim().length(64),
        idempotencyKey: z.string().trim().min(1).max(255),
      }))
      .mutation(async ({ ctx, input }) => {
        try {
          return await stageEditorialEpisodeDraft({
            actorUserId: ctx.user.id,
            ...input,
          });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
    publish: adminProcedure
      .input(workspaceIdInput.extend({
        workItemId: z.number().int().positive(),
      }))
      .query(async ({ ctx, input }) => {
        try {
          return await getEditorialPublishReadModel({
            actorUserId: ctx.user.id,
            ...input,
          });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
    preparePublishOwnership: adminProcedure
      .input(workspaceIdInput.extend({
        workItemId: z.number().int().positive(),
      }))
      .mutation(async ({ ctx, input }) => {
        try {
          return await prepareEditorialPublishOwnership({ actorUserId: ctx.user.id, ...input });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
    requestPublish: adminProcedure
      .input(workspaceIdInput.extend({
        workItemId: z.number().int().positive(),
        expectedStageSetSha256: z.string().trim().length(64),
        expectedStagedDraftSha256: z.string().trim().length(64),
        expectedCutoverEpoch: z.number().int().positive(),
        expectedOwnershipVersion: z.number().int().positive(),
      }))
      .mutation(async ({ ctx, input }) => {
        try {
          const executionEnabled = process.env.WORKSPACE_PUBLISH_EXECUTION_ENABLED === "true";
          const externalProviderEnabled = process.env.WORKSPACE_PUBLISH_EXTERNAL_PROVIDER_ENABLED === "true";
          if (executionEnabled && !externalProviderEnabled) {
            throw new WorkspacePublishExecutionError("EXTERNAL_PROVIDER_DISABLED", "Workspace publish external provider is not enabled.");
          }
          if (executionEnabled) requirePreviewPublishExecutionSafety();
          return await requestEditorialPublish({
            actorUserId: ctx.user.id,
            ...input,
            executionEnabled,
          });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
    foreignChecker: adminProcedure
      .input(workspaceIdInput.extend({
        workItemId: z.number().int().positive(),
        runId: z.number().int().positive().optional(),
      }))
      .query(async ({ ctx, input }) => {
        try {
          return await getEditorialForeignCheckerReadModel({
            actorUserId: ctx.user.id,
            ...input,
          });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
    foreignCheckerRun: adminProcedure
      .input(workspaceIdInput.extend({
        workItemId: z.number().int().positive(),
        expectedDraftId: z.number().int().positive().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        try {
          return await runEditorialForeignChecker({
            actorUserId: ctx.user.id,
            ...input,
          });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
    foreignCheckerResolve: adminProcedure
      .input(workspaceIdInput.extend({
        workItemId: z.number().int().positive(),
        findingId: z.number().int().positive(),
        disposition: z.enum(["open", "fixed", "ignored"]),
        note: z.string().trim().max(4000).optional(),
        expectedVersion: z.number().int().nonnegative(),
        idempotencyKey: z.string().trim().min(1).max(255),
      }))
      .mutation(async ({ ctx, input }) => {
        try {
          return await setEditorialFindingDisposition({
            actorUserId: ctx.user.id,
            ...input,
          });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
    foreignCheckerAllow: adminProcedure
      .input(workspaceIdInput.extend({
        workItemId: z.number().int().positive(),
        findingId: z.number().int().positive(),
        expectedVersion: z.number().int().nonnegative(),
        idempotencyKey: z.string().trim().min(1).max(255),
      }))
      .mutation(async ({ ctx, input }) => {
        try {
          return await allowEditorialFindingWord({
            actorUserId: ctx.user.id,
            ...input,
          });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
    foreignCheckerUnallow: adminProcedure
      .input(workspaceIdInput.extend({
        normalizedWord: z.string().trim().min(1).max(500),
      }))
      .mutation(async ({ ctx, input }) => {
        try {
          return await removeEditorialAllowedWord({
            actorUserId: ctx.user.id,
            ...input,
          });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
    foreignCheckerResolutionEvents: adminProcedure
      .input(workspaceIdInput.extend({
        workItemId: z.number().int().positive(),
      }))
      .query(async ({ ctx, input }) => {
        try {
          return await listEditorialFindingResolutionEvents({
            actorUserId: ctx.user.id,
            ...input,
          });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
    importSource: adminProcedure
      .input(workspaceIdInput.extend({
        workItemId: z.number().int().positive(),
        payload: editorialSourcePayloadInput,
      }))
      .mutation(async ({ ctx, input }) => {
        try {
          return await importEditorialSource({
            actorUserId: ctx.user.id,
            workspaceId: input.workspaceId,
            workItemId: input.workItemId,
            payload: input.payload,
          });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
    importGoogleDoc: adminProcedure
      .input(workspaceIdInput.extend({
        workItemId: z.number().int().positive(),
        connectionId: z.number().int().positive(),
        documentUrlOrId: z.string().trim().min(1).max(1000),
      }))
      .mutation(async ({ ctx, input }) => {
        try {
          const payload = await fetchEditorialGoogleDocSource({
            actorUserId: ctx.user.id,
            connectionId: input.connectionId,
            documentUrlOrId: input.documentUrlOrId,
          });
          return await importEditorialSource({
            actorUserId: ctx.user.id,
            workspaceId: input.workspaceId,
            workItemId: input.workItemId,
            payload,
            googleConnectionId: input.connectionId,
          });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
    createNovel: adminProcedure
      .input(workspaceIdInput.extend({
        title: z.string().trim().min(1).max(500),
        author: z.string().trim().max(255).optional(),
        description: z.string().trim().max(10000).optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        try {
          return await createWorkspacePublicationNovel({
            actorUserId: ctx.user.id,
            ...input,
          });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
    createEpisode: adminProcedure
      .input(workspaceIdInput.extend({
        workspaceNovelId: z.number().int().positive(),
        episodeNumber: z.string().trim().min(1).max(100),
        episodeTitle: z.string().trim().max(500).optional(),
        saleMode: z.literal("package").default("package"),
        price: z.string().trim().regex(/^\d+(?:\.\d{1,2})?$/),
        isFree: z.boolean(),
        assigneeUserId: z.number().int().positive().nullable().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        try {
          return await createEditorialEpisodeWorkItem({
            actorUserId: ctx.user.id,
            ...input,
          });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
    bulkImportGoogleDocs: adminProcedure
      .input(workspaceIdInput.extend({
        workspaceNovelId: z.number().int().positive(),
        connectionId: z.number().int().positive(),
        price: z.string().trim().regex(/^\d+(?:\.\d{1,2})?$/),
        isFree: z.boolean(),
        assigneeUserId: z.number().int().positive().nullable().optional(),
        rows: z.array(z.object({
          episodeNumber: z.string().trim().min(1).max(100),
          episodeTitle: z.string().trim().max(500).optional(),
          documentUrlOrId: z.string().trim().min(1).max(1000),
        })).min(1).max(30),
      }))
      .mutation(async ({ ctx, input }) => {
        const results = [];
        for (let rowIndex = 0; rowIndex < input.rows.length; rowIndex += 1) {
          const row = input.rows[rowIndex]!;
          try {
            const payload = await fetchEditorialGoogleDocSource({
              actorUserId: ctx.user.id,
              connectionId: input.connectionId,
              documentUrlOrId: row.documentUrlOrId,
            });
            const created = await createEditorialEpisodeWorkItem({
              actorUserId: ctx.user.id,
              workspaceId: input.workspaceId,
              workspaceNovelId: input.workspaceNovelId,
              episodeNumber: row.episodeNumber,
              episodeTitle: row.episodeTitle,
              saleMode: "package",
              price: input.isFree ? "0.00" : input.price,
              isFree: input.isFree,
              assigneeUserId: input.assigneeUserId ?? null,
            });
            const card = (created.board?.columns ?? [])
              .flatMap((column: any) => column.cards ?? [])
              .find((candidate: any) =>
                candidate.workItemType === "NEW_EPISODE" &&
                candidate.workspaceNovelId === input.workspaceNovelId &&
                String(candidate.episodeNumber ?? "").trim() === row.episodeNumber.trim()
              );
            if (!card?.workItemId) throw new Error("Created Episode Pack work item could not be resolved.");
            const imported = await importEditorialSource({
              actorUserId: ctx.user.id,
              workspaceId: input.workspaceId,
              workItemId: card.workItemId,
              payload,
              googleConnectionId: input.connectionId,
            });
            results.push({
              rowIndex,
              episodeNumber: row.episodeNumber,
              documentTitle: payload.title,
              workItemId: card.workItemId,
              ok: true as const,
              created: created.created,
              draftCreated: imported.draftCreated,
              refreshBlocked: imported.refreshBlocked,
            });
          } catch (error) {
            results.push({
              rowIndex,
              episodeNumber: row.episodeNumber,
              ok: false as const,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        return results;
      }),
    bulkImportEpisodeFiles: adminProcedure
      .input(workspaceIdInput.extend({
        workspaceNovelId: z.number().int().positive(),
        price: z.string().trim().regex(/^\d+(?:\.\d{1,2})?$/),
        isFree: z.boolean(),
        assigneeUserId: z.number().int().positive().nullable().optional(),
        files: z.array(z.object({
          episodeNumber: z.string().trim().min(1).max(100),
          episodeTitle: z.string().trim().max(500).optional(),
          fileName: z.string().trim().min(1).max(500),
          mimeType: z.string().trim().min(1).max(160),
          paragraphs: z.array(z.string().max(200000)).min(1).max(10000),
        })).min(1).max(50),
      }))
      .mutation(async ({ ctx, input }) => {
        const results = [];
        for (const file of input.files) {
          try {
            const created = await createEditorialEpisodeWorkItem({
              actorUserId: ctx.user.id,
              workspaceId: input.workspaceId,
              workspaceNovelId: input.workspaceNovelId,
              episodeNumber: file.episodeNumber,
              episodeTitle: file.episodeTitle,
              saleMode: "package",
              price: input.isFree ? "0.00" : input.price,
              isFree: input.isFree,
              assigneeUserId: input.assigneeUserId ?? null,
            });
            const card = (created.board?.columns ?? [])
              .flatMap((column: any) => column.cards ?? [])
              .find((candidate: any) =>
                candidate.workItemType === "NEW_EPISODE" &&
                candidate.workspaceNovelId === input.workspaceNovelId &&
                String(candidate.episodeNumber ?? "").trim() === file.episodeNumber.trim()
              );
            if (!card?.workItemId) throw new Error("Created Episode Pack work item could not be resolved.");
            const imported = await importEditorialSource({
              actorUserId: ctx.user.id,
              workspaceId: input.workspaceId,
              workItemId: card.workItemId,
              payload: {
                sourceKind: "uploaded_file",
                sourceKey: `uploaded-file:work-item-${card.workItemId}`,
                mimeType: file.mimeType,
                title: file.fileName,
                tabs: [{
                  sourceTabId: "file-main",
                  tabOrder: 0,
                  title: file.fileName,
                  paragraphs: file.paragraphs,
                }],
              },
            });
            results.push({
              episodeNumber: file.episodeNumber,
              workItemId: card.workItemId,
              ok: true as const,
              created: created.created,
              draftCreated: imported.draftCreated,
              refreshBlocked: imported.refreshBlocked,
            });
          } catch (error) {
            results.push({
              episodeNumber: file.episodeNumber,
              ok: false as const,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        return results;
      }),
    updateEpisode: adminProcedure
      .input(workspaceIdInput.extend({
        workItemId: z.number().int().positive(),
        episodeNumber: z.string().trim().min(1).max(100),
        episodeTitle: z.string().trim().max(500).optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        try { return await updateEditorialEpisodeWorkItem({ actorUserId: ctx.user.id, ...input }); }
        catch (error) { return mapWorkspaceError(error); }
      }),
    updateEpisodeSale: adminProcedure
      .input(workspaceIdInput.extend({
        workItemId: z.number().int().positive(),
        price: z.string().trim().regex(/^\d+(?:\.\d{1,2})?$/),
        isFree: z.boolean(),
      }))
      .mutation(async ({ ctx, input }) => {
        try { return await updateEditorialEpisodeSaleMetadata({ actorUserId: ctx.user.id, ...input }); }
        catch (error) { return mapWorkspaceError(error); }
      }),
    removeEpisode: adminProcedure
      .input(workspaceIdInput.extend({ workItemId: z.number().int().positive() }))
      .mutation(async ({ ctx, input }) => {
        try { return await removeEditorialEpisodeWorkItem({ actorUserId: ctx.user.id, ...input }); }
        catch (error) { return mapWorkspaceError(error); }
      }),
    assignWorkItem: adminProcedure
      .input(workspaceIdInput.extend({
        workItemId: z.number().int().positive(),
        assigneeUserId: z.number().int().positive().nullable(),
        expectedVersion: z.number().int().positive(),
        idempotencyKey: z.string().trim().min(1).max(255),
      }))
      .mutation(async ({ ctx, input }) => {
        try {
          return await assignEditorialWorkItem({
            actorUserId: ctx.user.id,
            ...input,
          });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
    updateWorkItemNote: adminProcedure
      .input(workspaceIdInput.extend({
        workItemId: z.number().int().positive(),
        note: z.string().max(1000).nullable(),
        expectedVersion: z.number().int().positive(),
      }))
      .mutation(async ({ ctx, input }) => {
        try {
          return await updateEditorialWorkItemNote({
            actorUserId: ctx.user.id,
            ...input,
          });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
    ensureBoard: adminProcedure
      .input(workspaceIdInput)
      .mutation(async ({ ctx, input }) => {
        try {
          return await ensureEditorialBoard({
            actorUserId: ctx.user.id,
            workspaceId: input.workspaceId,
          });
        } catch (error) {
          return mapWorkspaceError(error);
        }
      }),
  }),

  kanban: router({
    createBoard: adminProcedure
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
    createCardFromFingerprint: adminProcedure
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
    transitionCard: adminProcedure
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

  operationalState: adminProcedure
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

  reconcileCopiedLegacy: adminProcedure
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

  dualRunState: adminProcedure
    .input(workspaceIdInput)
    .query(async ({ ctx, input }) => {
      try {
        return await listDualRunState({ actorUserId: ctx.user.id, workspaceId: input.workspaceId });
      } catch (error) {
        return mapWorkspaceError(error);
      }
    }),
});
