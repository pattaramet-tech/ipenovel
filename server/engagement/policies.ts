/**
 * Pure engagement access and state-transition policy, disconnected from DB.
 * The eventual router MUST derive actor from auth ctx and load the actual
 * owner/novel/parent status with DB authorization in the same write transaction.
 */
import type { CommentStatus, ReportStatus, TicketStatus } from "../../shared/engagement/contracts";

export type EngagementRole = "user" | "author" | "admin";
export interface EngagementActor { userId: number; role: EngagementRole }
export interface OwnedTicket { userId: number; status: TicketStatus }
export interface OwnedComment {
  authorUserId: number;
  novelId: number;
  parentCommentId: number | null;
  status: CommentStatus;
}

export class EngagementPolicyError extends Error {
  constructor(readonly code: "FORBIDDEN" | "CONFLICT" | "NOT_FOUND") {
    super(code);
    this.name = "EngagementPolicyError";
  }
}

function validActor(actor: EngagementActor) {
  if (!Number.isSafeInteger(actor.userId) || actor.userId <= 0) {
    throw new EngagementPolicyError("FORBIDDEN");
  }
}
export function isEngagementModerator(actor: EngagementActor): boolean {
  validActor(actor);
  return actor.role === "admin";
}

/** Avoid exposing private ticket existence to a different account. */
export function canReadTicket(actor: EngagementActor, ticket: OwnedTicket): boolean {
  validActor(actor);
  return isEngagementModerator(actor) || ticket.userId === actor.userId;
}

export type TicketAction = "customer_reply" | "staff_reply" | "resolve" | "reopen" | "close";
export function nextTicketStatus(
  actor: EngagementActor, ticket: OwnedTicket, action: TicketAction
): TicketStatus {
  if (!canReadTicket(actor, ticket)) throw new EngagementPolicyError("NOT_FOUND");
  const admin = isEngagementModerator(actor);
  switch (action) {
    case "customer_reply":
      if (ticket.userId !== actor.userId || ticket.status === "closed" || ticket.status === "resolved")
        throw new EngagementPolicyError("CONFLICT");
      return "waiting_staff";
    case "staff_reply":
      if (!admin) throw new EngagementPolicyError("FORBIDDEN");
      // Closed/resolved tickets require an explicit reopen; a staff message
      // must not silently reopen a case that was already finalized.
      if (ticket.status === "closed" || ticket.status === "resolved")
        throw new EngagementPolicyError("CONFLICT");
      return "waiting_user";
    case "resolve":
      if (!admin) throw new EngagementPolicyError("FORBIDDEN");
      // Re-resolving an already-resolved ticket must conflict: integration
      // derives a resolution event/notification from this transition, and
      // a repeat would mint a duplicate resolution event.
      if (ticket.status === "closed" || ticket.status === "resolved")
        throw new EngagementPolicyError("CONFLICT");
      return "resolved";
    case "reopen":
      if (ticket.status !== "resolved" && ticket.status !== "closed")
        throw new EngagementPolicyError("CONFLICT");
      return "open";
    case "close":
      if (ticket.status !== "resolved") throw new EngagementPolicyError("CONFLICT");
      return "closed";
  }
}

export type ReportAction = "take_review" | "resolve" | "dismiss" | "reopen";
export function nextReportStatus(
  actor: EngagementActor, status: ReportStatus, action: ReportAction
): ReportStatus {
  if (!isEngagementModerator(actor)) throw new EngagementPolicyError("FORBIDDEN");
  switch (action) {
    case "take_review":
      if (status !== "new") throw new EngagementPolicyError("CONFLICT");
      return "in_review";
    case "resolve":
      if (status !== "in_review") throw new EngagementPolicyError("CONFLICT");
      return "resolved";
    case "dismiss":
      if (status !== "in_review") throw new EngagementPolicyError("CONFLICT");
      return "dismissed";
    case "reopen":
      if (status !== "resolved" && status !== "dismissed")
        throw new EngagementPolicyError("CONFLICT");
      return "in_review";
  }
}

/**
 * Only one reply level in P0. Both the parent and the novel must be loaded
 * from DB; never trust parent status or novelId supplied by a public client.
 */
export function canReplyToComment(parent: OwnedComment, targetNovelId: number): boolean {
  return parent.novelId === targetNovelId &&
    parent.parentCommentId === null &&
    parent.status === "visible";
}

/**
 * Reply-creation gate for the future router: the actor must be a valid
 * authenticated identity (always derived from auth ctx, never the client)
 * AND the parent must pass the reply rules above. Combining both leaves no
 * gap for the integration to forget the actor check.
 */
export function canCreateCommentReply(
  actor: EngagementActor, parent: OwnedComment, targetNovelId: number
): boolean {
  validActor(actor);
  return canReplyToComment(parent, targetNovelId);
}

export type CommentAction = "author_delete" | "moderator_hide" | "moderator_restore";
export function nextCommentStatus(
  actor: EngagementActor, comment: OwnedComment, action: CommentAction
): CommentStatus {
  validActor(actor);
  switch (action) {
    case "author_delete":
      if (actor.userId !== comment.authorUserId) throw new EngagementPolicyError("NOT_FOUND");
      if (comment.status === "deleted") throw new EngagementPolicyError("CONFLICT");
      return "deleted";
    case "moderator_hide":
      if (!isEngagementModerator(actor)) throw new EngagementPolicyError("FORBIDDEN");
      // Hide only PUBLISHED comments. Hiding a pending one and later
      // restoring it would publish never-approved content.
      if (comment.status !== "visible") throw new EngagementPolicyError("CONFLICT");
      return "hidden";
    case "moderator_restore":
      if (!isEngagementModerator(actor)) throw new EngagementPolicyError("FORBIDDEN");
      // Restore only what moderation itself hid - a hidden comment. A
      // deleted comment must never come back, and pending content is not
      // restorable to visible.
      if (comment.status !== "hidden") throw new EngagementPolicyError("CONFLICT");
      return "visible";
  }
}

/** A rating can only be submitted for a published, readable novel. */
export function canRateNovel(access: {
  actor: EngagementActor | null;
  isPublished: boolean;
  canRead: boolean;
  isSuspended: boolean;
}): boolean {
  if (!access.actor || !Number.isSafeInteger(access.actor.userId) ||
    access.actor.userId < 1) return false;
  return access.isPublished && access.canRead && !access.isSuspended;
}

/** Average is computed from authoritative aggregate rows, not client values. */
export function ratingSummary(sum: number, count: number): { average: number | null; count: number } {
  if (!Number.isSafeInteger(count) || count < 0 ||
      !Number.isSafeInteger(sum) || sum < 0 ||
      sum < count || sum > count * 5) {
    if (sum === 0 && count === 0) return { average: null, count: 0 };
    throw new EngagementPolicyError("CONFLICT");
  }
  if (count === 0) return { average: null, count: 0 };
  return { average: Math.round((sum / count) * 10) / 10, count };
}
