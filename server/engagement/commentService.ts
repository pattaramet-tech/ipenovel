/**
 * P2R3B-A novel comment service (post-moderation V1, PD-02).
 *
 * - New comments are created `visible` immediately (no pre-moderation path
 *   to `pending` exists in V1).
 * - Replies: exactly one level; the parent must be a visible root on the
 *   same novel (P0 `canCreateCommentReply`, which also validates the actor).
 * - The novel must be published (server-verified) for any create.
 * - Author soft-delete of their own comments; admin-only hide (from
 *   visible) / restore (from hidden) via P0 `nextCommentStatus`, each
 *   moderation action writing an append-only audit record.
 * - Public reading goes through the P2R3A pure projection
 *   (`projectVisibleThread`) - placeholders never carry content/author/time.
 * - Approved rate limit: 5 comments / minute (PD-04), shared by roots and
 *   replies.
 */
import {
  canCreateCommentReply,
  isEngagementModerator,
  nextCommentStatus,
  EngagementPolicyError,
  type EngagementActor,
  type CommentAction,
} from "./policies";
import { projectVisibleThread, type ThreadCommentView, type VisibleThreadPage } from "./commentVisibility";
import { runIdempotentMutation } from "./mutationPipeline";
import { APPROVED_RATE_LIMITS } from "./engagementRepository";
import { assertServerActor } from "./mutationPipeline";
import { commentCreateInput, positiveEntityId } from "../../shared/engagement/contracts";
import type { EngagementRepository, EngagementCommentRecord } from "./engagementRepository";

export interface CreateCommentInput {
  novelId: number;
  parentCommentId?: number;
  message: string;
  clientRequestKey?: string;
}

export interface CreateCommentResult {
  commentId: number;
  status: "visible";
}

export async function createComment(deps: {
  repo: EngagementRepository;
  actor: EngagementActor;
  input: CreateCommentInput;
  now: number;
}): Promise<CreateCommentResult> {
  const { repo, actor, input, now } = deps;
  assertServerActor(actor);
  // R1: P0 contract validation before any mutation decision
  const parsed = commentCreateInput.parse(input);
  const { result } = await runIdempotentMutation<CreateCommentResult>({
    repo,
    actorUserId: actor.userId,
    entity: "comment",
    clientRequestKey: parsed.clientRequestKey,
    canonicalSource: parsed,
    approvedRateLimit: {
      scopeKey: `comment.create:u${actor.userId}`,
      ...APPROVED_RATE_LIMITS.comment,
    },
    now,
    execute: async (tx) => {
      const novel = await tx.comments.getNovelPublication(parsed.novelId);
      if (!novel || !novel.isPublished) throw new EngagementPolicyError("NOT_FOUND");

      if (parsed.parentCommentId !== undefined) {
        const parent = await tx.comments.getById(parsed.parentCommentId);
        if (!parent) throw new EngagementPolicyError("NOT_FOUND");
        // policy validates actor + visible root + same novel (one level)
        if (!canCreateCommentReply(actor, parent, parsed.novelId)) {
          throw new EngagementPolicyError("CONFLICT");
        }
      }

      const commentId = await tx.comments.insert({
        novelId: parsed.novelId,
        parentCommentId: parsed.parentCommentId ?? null,
        authorUserId: actor.userId,
        message: parsed.message,
        status: "visible", // post-moderation V1: no pending creation path
        clientRequestKey: parsed.clientRequestKey ?? null,
      });
      return { commentId, status: "visible" as const };
    },
  });
  return result;
}

export async function actOnComment(deps: {
  repo: EngagementRepository;
  actor: EngagementActor;
  commentId: number;
  action: CommentAction;
  reasonCode?: string;
  now: number;
}): Promise<{ commentId: number; status: EngagementCommentRecord["status"] }> {
  const { repo, actor, commentId, action, reasonCode, now } = deps;
  assertServerActor(actor);
  positiveEntityId.parse(commentId);
  // R2: strict runtime action validation before any state mutation/audit
  const COMMENT_ACTIONS: ReadonlySet<string> = new Set([
    "author_delete",
    "moderator_hide",
    "moderator_restore",
  ]);
  if (!COMMENT_ACTIONS.has(action)) throw new EngagementPolicyError("FORBIDDEN");
  const { result } = await runIdempotentMutation({
    repo,
    actorUserId: actor.userId,
    entity: "comment",
    clientRequestKey: undefined,
    canonicalSource: { action, commentId },
    // moderation rate limiting is PENDING CONFIGURATION - not enforced.
    now,
    execute: async (tx) => {
      const comment = await tx.comments.getById(commentId);
      if (!comment) throw new EngagementPolicyError("NOT_FOUND");
      const fromStatus = comment.status;
      const toStatus = nextCommentStatus(actor, comment, action);
      await tx.comments.updateStatus(commentId, toStatus);
      if (action !== "author_delete") {
        // moderation actions are audited; author deletes are covered by the
        // status row itself per the P0 architecture doc
        await tx.comments.insertModerationAudit({
          commentId,
          actorUserId: actor.userId,
          fromStatus,
          toStatus,
          reasonCode: reasonCode ?? null,
        });
      }
      return { commentId, status: toStatus };
    },
  });
  return result;
}

/**
 * Public visible-thread page for a published novel. The caller must have
 * already verified the novel is publicly readable; this function projects
 * whatever rows exist through the pure engine.
 */
export async function listVisibleComments(deps: {
  repo: EngagementRepository;
  novelId: number;
  cursor?: number | null;
  limit: number;
}): Promise<VisibleThreadPage> {
  const { repo, novelId, cursor, limit } = deps;
  positiveEntityId.parse(novelId);
  return repo.withTransaction(async (tx) => {
    // R1: public reads only for a PUBLISHED novel - missing/unpublished
    // novels return NOT_FOUND instead of leaking any comment content.
    const novel = await tx.comments.getNovelPublication(novelId);
    if (!novel || !novel.isPublished) throw new EngagementPolicyError("NOT_FOUND");
    const rows = await tx.comments.listByNovel(novelId);
    const records = rows.map((row: EngagementCommentRecord) => ({
      id: row.id,
      parentCommentId: row.parentCommentId,
      authorUserId: row.authorUserId,
      message: row.message,
      status: row.status,
      createdAt: row.createdAt,
    }));
    return projectVisibleThread(records, { cursor: cursor ?? null, limit });
  });
}

export type { ThreadCommentView };
