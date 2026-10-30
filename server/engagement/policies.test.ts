import { describe, expect, it } from "vitest";
import {
  canReadTicket, nextTicketStatus, nextReportStatus,
  canReplyToComment, canCreateCommentReply, nextCommentStatus, canRateNovel, ratingSummary,
  EngagementPolicyError,
  type EngagementActor, type OwnedComment, type OwnedTicket,
} from "./policies";

const reader: EngagementActor = { userId: 7, role: "user" };
const other: EngagementActor = { userId: 8, role: "user" };
const author: EngagementActor = { userId: 9, role: "author" };
const admin: EngagementActor = { userId: 1, role: "admin" };
const ticket: OwnedTicket = { userId: 7, status: "open" };
const comment: OwnedComment = { authorUserId: 7, novelId: 30, parentCommentId: null, status: "visible" };

describe("engagement authorization policies", () => {
  it("tickets are private to the owner and admin", () => {
    expect(canReadTicket(reader, ticket)).toBe(true);
    expect(canReadTicket(admin, ticket)).toBe(true);
    expect(canReadTicket(other, ticket)).toBe(false);
    expect(canReadTicket(author, ticket)).toBe(false);
    expect(() => nextTicketStatus(other, ticket, "customer_reply")).toThrowError(new EngagementPolicyError("NOT_FOUND"));
  });
  it("staff reply requires admin (author cannot impersonate staff)", () => {
    expect(() => nextTicketStatus(reader, ticket, "staff_reply")).toThrowError(new EngagementPolicyError("FORBIDDEN"));
    expect(() => nextTicketStatus(author, ticket, "staff_reply")).toThrowError(new EngagementPolicyError("NOT_FOUND"));
    expect(nextTicketStatus(admin, ticket, "staff_reply")).toBe("waiting_user");
  });
  it("ticket lifecycle is deterministic and blocks replies to resolved or closed cases", () => {
    expect(nextTicketStatus(reader, ticket, "customer_reply")).toBe("waiting_staff");
    expect(nextTicketStatus(admin, { ...ticket, status: "waiting_staff" }, "staff_reply")).toBe("waiting_user");
    expect(nextTicketStatus(admin, { ...ticket, status: "waiting_user" }, "resolve")).toBe("resolved");
    expect(nextTicketStatus(reader, { ...ticket, status: "resolved" }, "close")).toBe("closed");
    expect(nextTicketStatus(reader, { ...ticket, status: "closed" }, "reopen")).toBe("open");
    expect(() => nextTicketStatus(reader, { ...ticket, status: "closed" }, "customer_reply")).toThrow();
    expect(() => nextTicketStatus(reader, { ...ticket, status: "resolved" }, "customer_reply")).toThrow();
    expect(() => nextTicketStatus(admin, { ...ticket, status: "closed" }, "resolve")).toThrow();
    expect(() => nextTicketStatus(admin, { ...ticket, status: "resolved" }, "resolve")).toThrowError(new EngagementPolicyError("CONFLICT"));
    expect(() => nextTicketStatus(admin, { ...ticket, status: "resolved" }, "staff_reply")).toThrow();
    expect(() => nextTicketStatus(reader, ticket, "reopen")).toThrow();
  });
  it("report triage/review decisions are admin only", () => {
    expect(() => nextReportStatus(reader, "new", "take_review")).toThrowError(new EngagementPolicyError("FORBIDDEN"));
    expect(() => nextReportStatus(author, "new", "dismiss")).toThrow();
    expect(nextReportStatus(admin, "new", "take_review")).toBe("in_review");
    expect(nextReportStatus(admin, "in_review", "resolve")).toBe("resolved");
    expect(nextReportStatus(admin, "in_review", "dismiss")).toBe("dismissed");
    expect(nextReportStatus(admin, "dismissed", "reopen")).toBe("in_review");
    expect(() => nextReportStatus(admin, "new", "resolve")).toThrow();
    expect(() => nextReportStatus(admin, "resolved", "dismiss")).toThrow();
  });
  it("only visible top-level comments on same novel may be replied to", () => {
    expect(canReplyToComment(comment, 30)).toBe(true);
    expect(canReplyToComment({ ...comment, parentCommentId: 2 }, 30)).toBe(false);
    expect(canReplyToComment({ ...comment, status: "hidden" }, 30)).toBe(false);
    expect(canReplyToComment(comment, 31)).toBe(false);
  });
  it("reply creation requires a valid authenticated actor plus a visible same-novel root", () => {
    // any authenticated identity may reply (subject to DB-side publish/
    // entitlement checks); invalid identities are rejected outright:
    expect(canCreateCommentReply(reader, comment, 30)).toBe(true);
    expect(canCreateCommentReply(author, comment, 30)).toBe(true);
    expect(canCreateCommentReply(admin, comment, 30)).toBe(true);
    expect(canCreateCommentReply(reader, { ...comment, status: "hidden" }, 30)).toBe(false);
    expect(canCreateCommentReply(reader, comment, 31)).toBe(false);
    expect(() => canCreateCommentReply({ userId: 0, role: "user" }, comment, 30))
      .toThrowError(new EngagementPolicyError("FORBIDDEN"));
    expect(() => canCreateCommentReply({ userId: 1.5, role: "admin" }, comment, 30))
      .toThrowError(new EngagementPolicyError("FORBIDDEN"));
  });
  it("comment owner can soft-delete only their own; only admin can hide/restore", () => {
    expect(nextCommentStatus(reader, comment, "author_delete")).toBe("deleted");
    expect(() => nextCommentStatus(other, comment, "author_delete")).toThrowError(new EngagementPolicyError("NOT_FOUND"));
    expect(() => nextCommentStatus(author, comment, "moderator_hide")).toThrowError(new EngagementPolicyError("FORBIDDEN"));
    expect(nextCommentStatus(admin, comment, "moderator_hide")).toBe("hidden");
    expect(nextCommentStatus(admin, { ...comment, status: "hidden" }, "moderator_restore")).toBe("visible");
    expect(() => nextCommentStatus(admin, { ...comment, status: "deleted" }, "moderator_restore")).toThrow();
    expect(() => nextCommentStatus(admin, { ...comment, status: "hidden" }, "moderator_hide")).toThrow();
  });
  it("moderation can never publish unapproved content: hide only from visible, restore only from hidden", () => {
    // pending -> hidden -> visible must be impossible at EVERY step:
    expect(() => nextCommentStatus(admin, { ...comment, status: "pending" }, "moderator_hide"))
      .toThrowError(new EngagementPolicyError("CONFLICT"));
    expect(() => nextCommentStatus(admin, { ...comment, status: "pending" }, "moderator_restore"))
      .toThrowError(new EngagementPolicyError("CONFLICT"));
    // deleted stays deleted for moderation too:
    expect(() => nextCommentStatus(admin, { ...comment, status: "deleted" }, "moderator_hide"))
      .toThrowError(new EngagementPolicyError("CONFLICT"));
  });
  it("invalid actor ID is forbidden", () => {
    expect(() => canReadTicket({ userId: 0, role: "user" }, ticket)).toThrowError(new EngagementPolicyError("FORBIDDEN"));
  });
  it("novel rating requires auth, published state, read eligibility and no suspension", () => {
    const access = { actor: reader, isPublished: true, canRead: true, isSuspended: false };
    expect(canRateNovel(access)).toBe(true);
    expect(canRateNovel({ ...access, actor: null })).toBe(false);
    expect(canRateNovel({ ...access, isPublished: false })).toBe(false);
    expect(canRateNovel({ ...access, canRead: false })).toBe(false);
    expect(canRateNovel({ ...access, isSuspended: true })).toBe(false);
  });
  it("rating averages are bounded and derived from sum/count, not client", () => {
    expect(ratingSummary(17, 4)).toEqual({ average: 4.3, count: 4 });
    expect(ratingSummary(0, 0)).toEqual({ average: null, count: 0 });
    for (const [sum, count] of [[9, 1], [0, 1], [-1, 2], [5, -1], [1.5, 1], [NaN, 2]]) {
      expect(() => ratingSummary(sum, count)).toThrowError(new EngagementPolicyError("CONFLICT"));
    }
  });
});
