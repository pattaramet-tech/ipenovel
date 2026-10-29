/**
 * P0 ONLY: create immutable, payload-free notification intents.
 *
 * This does NOT enqueue, store, dispatch, import or register Notifications
 * events. The existing notifications kind catalog must be independently
 * extended and reconciled AFTER that branch is integrated. The consumer
 * must revalidate recipient eligibility, opt-in, state and source ownership
 * at delivery time. Never notify about private text/content.
 */
export type EngagementEvent =
  | { kind: "ticket_staff_reply"; ticketId: number; messageId: number; ownerUserId: number; actorUserId: number }
  | { kind: "report_resolved"; reportId: number; decisionId: number; reporterUserId: number; actorUserId: number }
  | { kind: "comment_reply"; commentId: number; parentCommentId: number; parentAuthorUserId: number; actorUserId: number };

export type EngagementNotificationKind =
  | "support_ticket_replied"
  | "content_report_resolved"
  | "novel_comment_replied";

export interface EngagementNotificationIntent {
  kind: EngagementNotificationKind;
  eventKey: string;
  sourceType: "support_ticket" | "content_report" | "novel_comment";
  sourceId: string;
  recipientUserId: number;
}

function id(n: number): string {
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error("Invalid engagement event identity");
  return String(n);
}

/** Null deliberately means no notification, e.g. replying to your own comment. */
export function toEngagementNotificationIntent(
  event: EngagementEvent
): EngagementNotificationIntent | null {
  switch (event.kind) {
    case "ticket_staff_reply": {
      const ticketId = id(event.ticketId), messageId = id(event.messageId);
      id(event.ownerUserId); id(event.actorUserId);
      if (event.ownerUserId === event.actorUserId) return null;
      return {
        kind: "support_ticket_replied",
        eventKey: `engagement.ticket_reply.v1:${ticketId}:${messageId}`,
        sourceType: "support_ticket", sourceId: ticketId,
        recipientUserId: event.ownerUserId,
      };
    }
    case "report_resolved": {
      const reportId = id(event.reportId), decisionId = id(event.decisionId);
      id(event.reporterUserId); id(event.actorUserId);
      if (event.reporterUserId === event.actorUserId) return null;
      return {
        kind: "content_report_resolved",
        eventKey: `engagement.report_resolved.v1:${reportId}:${decisionId}`,
        sourceType: "content_report", sourceId: reportId,
        recipientUserId: event.reporterUserId,
      };
    }
    case "comment_reply": {
      const commentId = id(event.commentId), parentId = id(event.parentCommentId);
      id(event.parentAuthorUserId); id(event.actorUserId);
      if (event.parentAuthorUserId === event.actorUserId) return null;
      return {
        kind: "novel_comment_replied",
        eventKey: `engagement.comment_reply.v1:${parentId}:${commentId}`,
        sourceType: "novel_comment", sourceId: commentId,
        recipientUserId: event.parentAuthorUserId,
      };
    }
  }
}
