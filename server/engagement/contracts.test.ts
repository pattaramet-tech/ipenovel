import { describe, expect, it } from "vitest";
import {
  feedbackCreateInput, ticketCreateInput, ticketReplyInput,
  reportCreateInput, commentCreateInput, ratingUpsertInput,
  positiveEntityId,
} from "../../shared/engagement/contracts";

describe("engagement P0 validated input contracts", () => {
  it("accepts a normal feedback form and normalizes whitespace", () => {
    expect(feedbackCreateInput.parse({
      category: "bug", subject: "  Reader screen issue  ", message: "  App froze  ",
    })).toEqual({ category: "bug", subject: "Reader screen issue", message: "App froze" });
  });
  it("rejects empty, oversized, invalid categories and spoofed actor identities", () => {
    const input = { category: "bug", subject: "Reader broken", message: "Details" };
    for (const change of [
      { message: "   " }, { subject: "x" }, { message: "a".repeat(5001) },
      { category: "payments" }, { userId: 9 }, { status: "resolved" },
    ]) {
      expect(feedbackCreateInput.safeParse({ ...input, ...change }).success).toBe(false);
    }
  });
  it("requires a strictly bounded retry token if provided", () => {
    const base = { category: "suggestion", subject: "Add bookmark", message: "Please add one" };
    expect(feedbackCreateInput.safeParse({ ...base, clientRequestKey: "unique_key_0123456789" }).success).toBe(true);
    for (const key of ["abc", "in valid token!", "x".repeat(97)]) {
      expect(feedbackCreateInput.safeParse({ ...base, clientRequestKey: key }).success).toBe(false);
    }
  });
  it("ticket subject, category and body must be valid; staff priority cannot be injected", () => {
    const base = { subject: "Payment could not complete", category: "payment", message: "Transaction failed" };
    expect(ticketCreateInput.safeParse(base).success).toBe(true);
    expect(ticketCreateInput.safeParse({ ...base, priority: "high" }).success).toBe(false);
    expect(ticketCreateInput.safeParse({ ...base, message: "a".repeat(10001) }).success).toBe(false);
    expect(ticketCreateInput.safeParse({ ...base, category: "moderator" }).success).toBe(false);
  });
  it("ticket reply accepts a valid ticket ID, rejects cross-user actor injection and coercion", () => {
    expect(ticketReplyInput.parse({ ticketId: 23, message: "Thanks" })).toEqual({ ticketId: 23, message: "Thanks" });
    expect(ticketReplyInput.safeParse({ ticketId: "23", message: "Thanks" }).success).toBe(false);
    expect(ticketReplyInput.safeParse({ ticketId: 23, message: "Thanks", userId: 8 }).success).toBe(false);
  });
  it("report targets support novel, episode and comment without accepting arbitrary targets", () => {
    for (const type of ["novel", "episode", "comment"] as const) {
      expect(reportCreateInput.safeParse({
        target: { type, id: 12 }, reason: "spam", details: "Repeated advertisements",
      }).success).toBe(true);
    }
    const base = { reason: "abuse", details: "Inappropriate material" };
    expect(reportCreateInput.safeParse({ ...base, target: { type: "user", id: 1 } }).success).toBe(false);
    expect(reportCreateInput.safeParse({ ...base, target: { type: "novel", id: 1, userId: 2 } }).success).toBe(false);
    expect(reportCreateInput.safeParse({ ...base, target: { type: "comment", id: -3 } }).success).toBe(false);
    expect(reportCreateInput.safeParse({ ...base, target: { type: "novel", id: 1 }, reason: "not_interested" }).success).toBe(false);
  });
  it("comment accepts a root or a reply and restricts content and cross-user fields", () => {
    expect(commentCreateInput.safeParse({ novelId: 1, message: "Great story" }).success).toBe(true);
    expect(commentCreateInput.safeParse({ novelId: 1, parentCommentId: 5, message: "Thanks!" }).success).toBe(true);
    expect(commentCreateInput.safeParse({ novelId: 1, parentCommentId: 0, message: "X" }).success).toBe(false);
    expect(commentCreateInput.safeParse({ novelId: 1, message: "<script>", authorUserId: 3 }).success).toBe(false);
    expect(commentCreateInput.safeParse({ novelId: 1, message: "a".repeat(2001) }).success).toBe(false);
  });
  it("ratings accept only integer stars 1–5, never a client-provided user or arbitrary points", () => {
    for (let star = 1; star <= 5; star++) {
      expect(ratingUpsertInput.safeParse({ novelId: 11, stars: star }).success).toBe(true);
    }
    for (const stars of [0, 6, 1.5, "5", NaN, Infinity]) {
      expect(ratingUpsertInput.safeParse({ novelId: 11, stars }).success).toBe(false);
    }
    expect(ratingUpsertInput.safeParse({ novelId: 11, stars: 5, userId: 9 }).success).toBe(false);
    expect(ratingUpsertInput.safeParse({ novelId: 11, stars: 5, pointsAwarded: 100 }).success).toBe(false);
  });
  it("rejects unsafe or non-positive domain IDs", () => {
    for (const id of [-1, 0, 1.5, 2 ** 53, "1", null]) {
      expect(positiveEntityId.safeParse(id).success).toBe(false);
    }
  });
  it("rejects control, bidi and invisible characters in every text field (spam/spoof hardening)", () => {
    const base = { category: "bug" as const, subject: "Reader issue", message: "App froze" };
    for (const unsafe of [
      "\u0000", "\u0008", "\u000B", "\u000C", "\u001F", "\u007F", "\u009F",
      "\u200B", "\u200F", "\u202A", "\u202E", "\u2066", "\u2069", "\uFEFF",
    ]) {
      expect(feedbackCreateInput.safeParse({ ...base, message: `bad ${unsafe} text` }).success).toBe(false);
      expect(feedbackCreateInput.safeParse({ ...base, subject: `bad ${unsafe} subject` }).success).toBe(false);
    }
    // the shared validators cover the other systems' text fields too:
    expect(commentCreateInput.safeParse({ novelId: 1, message: "spoof\u202Eevif" }).success).toBe(false);
    expect(reportCreateInput.safeParse({ target: { type: "novel", id: 1 }, reason: "spam", details: "x\u200By" }).success).toBe(false);
    expect(ticketCreateInput.safeParse({ subject: "Payment stuck", category: "payment", message: "a\u0000b" }).success).toBe(false);
    expect(ticketReplyInput.safeParse({ ticketId: 5, message: "reply\u2068flow" }).success).toBe(false);
  });
  it("multi-line bodies keep newlines/tabs/carriage returns; titles stay single-line", () => {
    const base = { category: "bug" as const, subject: "Reader issue", message: "First line" };
    expect(feedbackCreateInput.safeParse({
      ...base, message: "line one\nline two\tindented\r\nend",
    }).success).toBe(true);
    expect(feedbackCreateInput.safeParse({ ...base, subject: "two\nlines" }).success).toBe(false);
    expect(feedbackCreateInput.safeParse({ ...base, subject: "tab\tinside" }).success).toBe(false);
  });
});
