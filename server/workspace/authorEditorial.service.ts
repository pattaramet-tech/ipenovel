import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq } from "drizzle-orm";
import {
  workspaceEditorialDraftParagraphs,
  workspaceEditorialDraftTabs,
  workspaceEditorialDrafts,
  workspaceEditorialWorkItems,
} from "../../drizzle/schema";
import { getDb } from "../db";
import { assertAuthorEditorialWrite, type AuthorEditorialScope } from "./authorEditorialGrant";
import {
  getEditorialApprovalReadModel,
  approveEditorialDraft,
  stageEditorialEpisodeDraft,
} from "./editorialApproval.service";
import {
  applyEditorialEditorEdit,
  getEditorialEditorReadModel,
  undoEditorialEditorEdit,
} from "./editorialEditor.service";
import {
  getEditorialForeignCheckerReadModel,
  runEditorialForeignChecker,
  setEditorialFindingDisposition,
  setEditorialStructuralConfirmation,
} from "./editorialForeignChecker.service";

function stageBlockReason(code: string | null, fallback: string) {
  switch (code) {
    case "APPROVAL_REQUIRED":
      return "Approve the current draft before Stage.";
    case "DRAFT_CHANGED":
      return "The draft changed after approval. Approve it again before Stage.";
    case "QC_CHANGED":
      return "QC changed after approval. Run QC and approve again before Stage.";
    case "APPROVAL_CHANGED":
      return "The approval no longer matches this draft. Approve it again before Stage.";
    case "STAGE_PLAN_INVALID":
      return "The Stage plan is not ready. Fix the draft structure before Stage.";
    case "STAGE_BATCH_INCOMPLETE":
      return "The existing Stage does not cover this draft.";
    case "EPISODE_MISSING":
      return "The staged episode is missing. Stage cannot continue.";
    case "EPISODE_DRIFTED":
      return "The staged episode no longer matches this draft.";
    case "EPISODE_PUBLISHED":
      return "The staged episode is already published.";
    default:
      return fallback;
  }
}

/** Permission to run Stage. An existing valid Stage is not required. */
export function authorStageAction(input: {
  approvalValid: boolean;
  approvalReason: string | null;
  planReady: boolean;
  planReason: string | null;
  hasExistingStage: boolean;
  existingStageValid: boolean;
  existingStageReason: string | null;
}) {
  if (!input.approvalValid) {
    return {
      ready: false,
      reason: stageBlockReason(input.approvalReason, "Approve the current draft before Stage."),
    };
  }
  if (!input.planReady) {
    const detail = input.planReason?.trim();
    return {
      ready: false,
      reason: detail
        ? detail
        : stageBlockReason("STAGE_PLAN_INVALID", "The Stage plan is not ready."),
    };
  }
  if (!input.hasExistingStage || input.existingStageValid) {
    return { ready: true, reason: null };
  }
  return {
    ready: false,
    reason: stageBlockReason(
      input.existingStageReason,
      "The existing Stage does not match this draft.",
    ),
  };
}

export function projectAuthorCheckerFinding(finding: {
  id: number;
  token: string | null;
  disposition: string;
  resolutionVersion: number;
  sourceTabId: string | null;
  paragraphKey: string | null;
  startOffset: number | null;
  endOffset: number | null;
}) {
  return {
    id: finding.id,
    token: finding.token,
    disposition: finding.disposition,
    resolutionVersion: finding.resolutionVersion,
    sourceTabId: finding.sourceTabId,
    paragraphKey: finding.paragraphKey,
    startOffset: finding.startOffset,
    endOffset: finding.endOffset,
  };
}

async function database() {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "SERVICE_UNAVAILABLE", message: "Workspace unavailable" });
  return db;
}

async function loadOwnedTabs(scope: AuthorEditorialScope) {
  const db = await database();
  await assertAuthorEditorialWrite(db, scope, { lock: false });
  const [draft] = await db
    .select({
      id: workspaceEditorialDrafts.id,
      version: workspaceEditorialDrafts.version,
      draftSha256: workspaceEditorialDrafts.draftSha256,
    })
    .from(workspaceEditorialDrafts)
    .innerJoin(
      workspaceEditorialWorkItems,
      eq(workspaceEditorialDrafts.workItemId, workspaceEditorialWorkItems.id),
    )
    .where(eq(workspaceEditorialWorkItems.id, scope.workItemId))
    .orderBy(desc(workspaceEditorialDrafts.version), desc(workspaceEditorialDrafts.id))
    .limit(1);
  if (!draft) return { draft: null, tabs: [] };
  const tabs = await db
    .select({
      id: workspaceEditorialDraftTabs.id,
      sourceTabId: workspaceEditorialDraftTabs.sourceTabId,
      title: workspaceEditorialDraftTabs.title,
      tabOrder: workspaceEditorialDraftTabs.tabOrder,
      structuralSha256: workspaceEditorialDraftTabs.structuralSha256,
    })
    .from(workspaceEditorialDraftTabs)
    .where(eq(workspaceEditorialDraftTabs.draftId, draft.id))
    .orderBy(asc(workspaceEditorialDraftTabs.tabOrder));
  const withParagraphs = [];
  for (const tab of tabs) {
    const paragraphs = await db
      .select({
        paragraphKey: workspaceEditorialDraftParagraphs.paragraphKey,
        text: workspaceEditorialDraftParagraphs.text,
      })
      .from(workspaceEditorialDraftParagraphs)
      .where(eq(workspaceEditorialDraftParagraphs.draftTabId, tab.id))
      .orderBy(asc(workspaceEditorialDraftParagraphs.paragraphOrder));
    withParagraphs.push({
      sourceTabId: tab.sourceTabId,
      title: tab.title,
      structuralSha256: tab.structuralSha256,
      paragraphs,
    });
  }
  return { draft, tabs: withParagraphs };
}

export async function getAuthorEditorialSurface(scope: AuthorEditorialScope) {
  const owned = await loadOwnedTabs(scope);
  const editor = await getEditorialEditorReadModel({ ...scope, authorGrant: true });
  const checker = await getEditorialForeignCheckerReadModel({ ...scope, authorGrant: true });
  const approval = await getEditorialApprovalReadModel({ ...scope, authorGrant: true });
  const stageAction = authorStageAction({
    approvalValid: Boolean(approval.approvalStatus?.valid),
    approvalReason: approval.approvalStatus?.reason ?? null,
    planReady: Boolean(approval.stagePlan?.ready),
    planReason: approval.stagePlanError ?? null,
    hasExistingStage: approval.stage != null,
    existingStageValid: Boolean(approval.stageStatus?.valid),
    existingStageReason: approval.stageStatus?.reason ?? null,
  });
  return {
    canUndo: editor.canUndo,
    draft: owned.draft,
    tabs: owned.tabs,
    checker: {
      state: checker.state,
      unresolvedCount: checker.unresolvedCount,
      findings: (checker.findings ?? []).map((finding: any) => projectAuthorCheckerFinding({
        id: finding.id,
        token: finding.token ?? null,
        disposition: finding.disposition,
        resolutionVersion: finding.resolutionVersion,
        sourceTabId: finding.sourceTabId ?? null,
        paragraphKey: finding.paragraphKey ?? null,
        startOffset: finding.startOffset ?? null,
        endOffset: finding.endOffset ?? null,
      })),
      anomalies: (checker.anomalies ?? []).map((anomaly: any) => ({
        id: anomaly.id,
        anomalyType: anomaly.anomalyType,
        disposition: anomaly.disposition,
        confirmationVersion: anomaly.confirmationVersion,
      })),
    },
    approval: {
      qcReady: Boolean(approval.qc?.ready),
      qcReason: approval.qc?.reason ?? null,
      checkerRunId: approval.qc?.checkerRunId ?? null,
      qcEvidenceSha256: approval.qc?.qcEvidenceSha256 ?? null,
      approvalId: approval.approval?.id ?? null,
      stageReady: Boolean(approval.stageStatus?.valid),
      stageReason: approval.stageStatus?.reason ?? null,
      stageActionReady: stageAction.ready,
      stageActionReason: stageAction.reason,
    },
    publishAvailable: false as const,
  };
}

export function editAuthorEditorialDraft(
  input: Omit<Parameters<typeof applyEditorialEditorEdit>[0], "authorGrant" | "accessPolicy">,
) {
  return applyEditorialEditorEdit({ ...input, authorGrant: true });
}

export function undoAuthorEditorialDraft(
  input: Omit<Parameters<typeof undoEditorialEditorEdit>[0], "authorGrant">,
) {
  return undoEditorialEditorEdit({ ...input, authorGrant: true });
}

export function runAuthorEditorialChecker(
  input: Omit<Parameters<typeof runEditorialForeignChecker>[0], "authorGrant" | "accessPolicy">,
) {
  return runEditorialForeignChecker({ ...input, authorGrant: true });
}

export function resolveAuthorEditorialFinding(
  input: Omit<Parameters<typeof setEditorialFindingDisposition>[0], "authorGrant">,
) {
  return setEditorialFindingDisposition({ ...input, authorGrant: true });
}

export function confirmAuthorEditorialAnomaly(
  input: Omit<Parameters<typeof setEditorialStructuralConfirmation>[0], "authorGrant">,
) {
  return setEditorialStructuralConfirmation({ ...input, authorGrant: true });
}

export function approveAuthorEditorialDraft(
  input: Omit<Parameters<typeof approveEditorialDraft>[0], "authorGrant">,
) {
  return approveEditorialDraft({ ...input, authorGrant: true });
}

export function stageAuthorEditorialDraft(
  input: Omit<Parameters<typeof stageEditorialEpisodeDraft>[0], "authorGrant">,
) {
  return stageEditorialEpisodeDraft({ ...input, authorGrant: true });
}
