import { describe, expect, it } from "vitest";
import { toEngagementNotificationIntent } from "./notificationIntent";

describe("engagement notification intent adapter — disconnected P0", () => {
  it("creates stable recipient-scoped ticket reply identity without message content", () => {
    const event = { kind: "ticket_staff_reply", ticketId: 15, messageId: 28, ownerUserId: 4, actorUserId: 1 } as const;
    const intent = toEngagementNotificationIntent(event);
    expect(intent).toEqual({
      kind: "support_ticket_replied", eventKey: "engagement.ticket_reply.v1:15:28",
      sourceType: "support_ticket", sourceId: "15", recipientUserId: 4,
    });
    expect(toEngagementNotificationIntent(event)).toEqual(intent);
    expect(JSON.stringify(intent)).not.toContain("messageId");
  });
  it("maps moderation decision without raw report text", () => {
    expect(toEngagementNotificationIntent({
      kind: "report_resolved", reportId: 88, decisionId: 22, reporterUserId: 7, actorUserId: 1,
    })).toEqual({
      kind: "content_report_resolved", eventKey: "engagement.report_resolved.v1:88:22",
      sourceType: "content_report", sourceId: "88", recipientUserId: 7,
    });
  });
  it("maps reply recipient to parent author with stable comment id", () => {
    expect(toEngagementNotificationIntent({
      kind: "comment_reply", commentId: 37, parentCommentId: 30, parentAuthorUserId: 7, actorUserId: 9,
    })).toEqual({
      kind: "novel_comment_replied", eventKey: "engagement.comment_reply.v1:30:37",
      sourceType: "novel_comment", sourceId: "37", recipientUserId: 7,
    });
  });
  it("suppresses self notifications", () => {
    expect(toEngagementNotificationIntent({
      kind: "ticket_staff_reply", ticketId: 1, messageId: 2, ownerUserId: 3, actorUserId: 3,
    })).toBeNull();
    expect(toEngagementNotificationIntent({
      kind: "comment_reply", commentId: 1, parentCommentId: 2, parentAuthorUserId: 3, actorUserId: 3,
    })).toBeNull();
    expect(toEngagementNotificationIntent({
      kind: "report_resolved", reportId: 1, decisionId: 2, reporterUserId: 3, actorUserId: 3,
    })).toBeNull();
  });
  it("rejects unsafe or invalid IDs rather than generating colliding dedupe keys", () => {
    expect(() => toEngagementNotificationIntent({
      kind: "comment_reply", commentId: Number.MAX_SAFE_INTEGER + 1,
      parentCommentId: 1, parentAuthorUserId: 2, actorUserId: 3,
    })).toThrow();
    expect(() => toEngagementNotificationIntent({
      kind: "ticket_staff_reply", ticketId: 2, messageId: 0, ownerUserId: 2, actorUserId: 1,
    })).toThrow();
  });
});
