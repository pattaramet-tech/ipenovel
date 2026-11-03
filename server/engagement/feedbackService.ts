/**
 * P2R3B-A feedback service: one-way suggestion channel (PD-05).
 *
 * - Users submit bounded feedback (contract: feedbackCreateInput) with an
 *   optional idempotency key; approved limit 3 / 10 minutes (PD-04).
 * - Users read ONLY their own submissions; another user's id -> NOT_FOUND
 *   (no existence leak).
 * - Admin review transitions: new -> acknowledged -> closed (admin only).
 * No reply/discussion exists here by design - that is Support Ticket's job.
 */
import { EngagementPolicyError, isEngagementModerator, type EngagementActor } from "./policies";
import { runIdempotentMutation } from "./mutationPipeline";
import { APPROVED_RATE_LIMITS, type EngagementRepository, type FeedbackRecord, type FeedbackStatus } from "./engagementRepository";
import { assertServerActor } from "./mutationPipeline";
import { feedbackCreateInput, positiveEntityId } from "../../shared/engagement/contracts";

export interface SubmitFeedbackInput {
  category: "bug" | "suggestion" | "usability" | "other";
  subject: string;
  message: string;
  clientRequestKey?: string;
}

export interface SubmitFeedbackResult {
  feedbackId: number;
  status: FeedbackStatus;
}

const REVIEW_TRANSITIONS: Record<FeedbackStatus, FeedbackStatus> = {
  new: "acknowledged",
  acknowledged: "closed",
  closed: "closed",
};

export async function submitFeedback(deps: {
  repo: EngagementRepository;
  actor: EngagementActor;
  input: SubmitFeedbackInput;
  now: number;
}): Promise<SubmitFeedbackResult> {
  const { repo, actor, input, now } = deps;
  assertServerActor(actor);
  // R1: P0 contract validation before any mutation decision
  const parsed = feedbackCreateInput.parse(input);
  const { result } = await runIdempotentMutation<SubmitFeedbackResult>({
    repo,
    actorUserId: actor.userId,
    entity: "feedback",
    clientRequestKey: parsed.clientRequestKey,
    canonicalSource: parsed,
    approvedRateLimit: {
      scopeKey: `feedback.create:u${actor.userId}`,
      ...APPROVED_RATE_LIMITS.feedback,
    },
    now,
    execute: async (tx) => {
      const feedbackId = await tx.feedback.insert({
        userId: actor.userId,
        category: parsed.category,
        subject: parsed.subject,
        message: parsed.message,
        status: "new",
        clientRequestKey: parsed.clientRequestKey ?? null,
      });
      return { feedbackId, status: "new" as const };
    },
  });
  return result;
}

export async function listMyFeedback(deps: {
  repo: EngagementRepository;
  actor: EngagementActor;
}): Promise<FeedbackRecord[]> {
  const { repo, actor } = deps;
  assertServerActor(actor);
  return repo.withTransaction((tx) => tx.feedback.listByUser(actor.userId));
}

export async function getMyFeedback(deps: {
  repo: EngagementRepository;
  actor: EngagementActor;
  feedbackId: number;
}): Promise<FeedbackRecord> {
  const { repo, actor, feedbackId } = deps;
  assertServerActor(actor);
  positiveEntityId.parse(feedbackId);
  return repo.withTransaction(async (tx) => {
    const record = await tx.feedback.getById(feedbackId);
    // existence never leaks across accounts
    if (!record || record.userId !== actor.userId) {
      throw new EngagementPolicyError("NOT_FOUND");
    }
    return record;
  });
}

export async function reviewFeedback(deps: {
  repo: EngagementRepository;
  actor: EngagementActor;
  feedbackId: number;
  /** Acknowledge a new submission, or close an acknowledged one. */
  action: "acknowledge" | "close";
}): Promise<{ feedbackId: number; status: FeedbackStatus }> {
  const { repo, actor, feedbackId, action } = deps;
  assertServerActor(actor);
  positiveEntityId.parse(feedbackId);
  return repo.withTransaction(async (tx) => {
    if (!isEngagementModerator(actor)) throw new EngagementPolicyError("FORBIDDEN");
    const record = await tx.feedback.getById(feedbackId);
    if (!record) throw new EngagementPolicyError("NOT_FOUND");
    let next: FeedbackStatus;
    if (action === "acknowledge" && record.status === "new") {
      next = "acknowledged";
    } else if (action === "close" && record.status === "acknowledged") {
      next = "closed";
    } else {
      throw new EngagementPolicyError("CONFLICT");
    }
    await tx.feedback.updateStatus(feedbackId, next);
    return { feedbackId, status: next };
  });
}
