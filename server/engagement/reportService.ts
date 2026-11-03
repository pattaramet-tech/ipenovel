/**
 * P2R3B-A content report service.
 *
 * - Reporters target novel/episode/comment by id; target existence is
 *   verified server-side inside the mutation transaction (missing target ->
 *   NOT_FOUND, no existence oracle for private data).
 * - Approved rate limit: 3 reports / hour (PD-04) per reporter.
 * - Moderation (take_review / resolve / dismiss / reopen) is admin-only and
 *   delegated to the P0 `nextReportStatus`; every decision writes an
 *   append-only decision record in the same transaction.
 */
import {
  isEngagementModerator,
  nextReportStatus,
  EngagementPolicyError,
  type EngagementActor,
  type ReportAction,
} from "./policies";
import { runIdempotentMutation } from "./mutationPipeline";
import { APPROVED_RATE_LIMITS } from "./engagementRepository";
import { assertServerActor } from "./mutationPipeline";
import { reportCreateInput, positiveEntityId } from "../../shared/engagement/contracts";
import type {
  EngagementRepository,
  ReportRecord,
  ReportTargetType,
} from "./engagementRepository";

export interface CreateReportInput {
  target: { type: ReportTargetType; id: number };
  reason: "spam" | "abuse" | "copyright" | "illegal" | "other";
  details: string;
  clientRequestKey?: string;
}

export interface CreateReportResult {
  reportId: number;
  status: ReportRecord["status"];
}

export async function createReport(deps: {
  repo: EngagementRepository;
  actor: EngagementActor;
  input: CreateReportInput;
  now: number;
}): Promise<CreateReportResult> {
  const { repo, actor, input, now } = deps;
  assertServerActor(actor);
  // R1: P0 contract validation before any mutation decision
  const parsed = reportCreateInput.parse(input);
  const { result } = await runIdempotentMutation<CreateReportResult>({
    repo,
    actorUserId: actor.userId,
    entity: "report",
    clientRequestKey: parsed.clientRequestKey,
    canonicalSource: parsed,
    approvedRateLimit: {
      scopeKey: `report.create:u${actor.userId}`,
      ...APPROVED_RATE_LIMITS.report,
    },
    now,
    execute: async (tx) => {
      // R1 fail-closed visibility gate: only content the reporter can
      // legitimately see is reportable - existence of private/unpublished
      // targets is never revealed (unknown and invisible both -> NOT_FOUND).
      const visible = await tx.reports.targetVisibleToReporter(
        parsed.target.type,
        parsed.target.id,
        actor.userId
      );
      if (!visible) throw new EngagementPolicyError("NOT_FOUND");
      const reportId = await tx.reports.insert({
        reporterUserId: actor.userId,
        targetType: parsed.target.type,
        targetId: parsed.target.id,
        reason: parsed.reason,
        details: parsed.details,
        status: "new",
        clientRequestKey: parsed.clientRequestKey ?? null,
      });
      return { reportId, status: "new" as const };
    },
  });
  return result;
}

export async function getMyReport(deps: {
  repo: EngagementRepository;
  actor: EngagementActor;
  reportId: number;
}): Promise<ReportRecord> {
  const { repo, actor, reportId } = deps;
  assertServerActor(actor);
  positiveEntityId.parse(reportId);
  return repo.withTransaction(async (tx) => {
    const record = await tx.reports.getById(reportId);
    if (!record || record.reporterUserId !== actor.userId) {
      throw new EngagementPolicyError("NOT_FOUND");
    }
    return record;
  });
}

export async function listMyReports(deps: {
  repo: EngagementRepository;
  actor: EngagementActor;
}): Promise<ReportRecord[]> {
  const { repo, actor } = deps;
  assertServerActor(actor);
  return repo.withTransaction((tx) => tx.reports.listByReporter(actor.userId));
}

export async function reviewReport(deps: {
  repo: EngagementRepository;
  actor: EngagementActor;
  reportId: number;
  action: ReportAction;
  reasonCode?: string;
  now: number;
}): Promise<{ reportId: number; status: ReportRecord["status"] }> {
  const { repo, actor, reportId, action, reasonCode, now } = deps;
  assertServerActor(actor);
  positiveEntityId.parse(reportId);
  // R2: strict runtime action validation before any state mutation
  const REPORT_ACTIONS: ReadonlySet<string> = new Set(["take_review", "resolve", "dismiss", "reopen"]);
  if (!REPORT_ACTIONS.has(action)) throw new EngagementPolicyError("FORBIDDEN");
  const { result } = await runIdempotentMutation({
    repo,
    actorUserId: actor.userId,
    entity: "report",
    clientRequestKey: undefined,
    canonicalSource: { action, reportId },
    // moderation rate limiting is PENDING CONFIGURATION - not enforced.
    now,
    execute: async (tx) => {
      if (!isEngagementModerator(actor)) throw new EngagementPolicyError("FORBIDDEN");
      const record = await tx.reports.getById(reportId);
      if (!record) throw new EngagementPolicyError("NOT_FOUND");
      const toStatus = nextReportStatus(actor, record.status, action);
      await tx.reports.updateStatus(reportId, toStatus);
      await tx.reports.insertDecision({
        reportId,
        adminUserId: actor.userId,
        fromStatus: record.status,
        toStatus,
        reasonCode: reasonCode ?? null,
      });
      return { reportId, status: toStatus };
    },
  });
  return result;
}
