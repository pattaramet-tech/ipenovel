/**
 * Feedback, Support & Community P0 — transport-agnostic input contracts.
 *
 * These are *input* shapes, not authorization proofs. Authenticated user id,
 * ownership, target publication, moderation permissions and rate limiting
 * MUST be verified by the future server integration against authoritative DB
 * state. P0 intentionally neither registers a tRPC router nor imports DB.
 */
import { z } from "zod";

export const positiveEntityId = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);

/**
 * Invisible/control/bidi characters have no legitimate place in engagement
 * text: they defeat length- and content-based spam heuristics, and bidi
 * overrides can visually reorder rendered text in ways HTML escaping does
 * not prevent. Multi-line bodies keep \n, \r and \t.
 */
const UNSAFE_BODY_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/;
/** Subjects/titles are single clean lines: no control characters at all. */
const UNSAFE_TITLE_CHARS = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/;

const body = (max: number) => z.string().trim().min(1).max(max)
  .refine((value) => /\S/.test(value), "Text is required")
  .refine((value) => !UNSAFE_BODY_CHARS.test(value), "Control or invisible characters are not allowed");
const title = (max: number) => z.string().trim().min(3).max(max)
  .refine((value) => !UNSAFE_TITLE_CHARS.test(value), "Subject must be a single clean line");
const optionalClientKey = z.string().regex(/^[A-Za-z0-9_-]{12,96}$/).optional();

export const feedbackCategory = z.enum(["bug", "suggestion", "usability", "other"]);
export const feedbackCreateInput = z.strictObject({
  category: feedbackCategory,
  subject: title(160),
  message: body(5000),
  /** Client retry token; server must scope uniqueness to authenticated user. */
  clientRequestKey: optionalClientKey,
});

export const ticketPriority = z.enum(["normal", "high"]);
export const ticketCreateInput = z.strictObject({
  subject: title(160),
  message: body(10000),
  category: z.enum(["account", "payment", "reading", "technical", "other"]),
  clientRequestKey: optionalClientKey,
});
export const ticketReplyInput = z.strictObject({
  ticketId: positiveEntityId,
  message: body(10000),
  clientRequestKey: optionalClientKey,
});
export const ticketStatus = z.enum([
  "open", "waiting_user", "waiting_staff", "resolved", "closed",
]);

export const reportTarget = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("novel"), id: positiveEntityId }),
  z.strictObject({ type: z.literal("episode"), id: positiveEntityId }),
  z.strictObject({ type: z.literal("comment"), id: positiveEntityId }),
]);
export const reportCreateInput = z.strictObject({
  target: reportTarget,
  reason: z.enum(["spam", "abuse", "copyright", "illegal", "other"]),
  details: body(3000),
  clientRequestKey: optionalClientKey,
});
export const reportStatus = z.enum(["new", "in_review", "resolved", "dismissed"]);

export const commentCreateInput = z.strictObject({
  novelId: positiveEntityId,
  /** Root comment when absent; reply parent must be a visible root on same novel. */
  parentCommentId: positiveEntityId.optional(),
  message: body(2000),
  clientRequestKey: optionalClientKey,
});
export const commentStatus = z.enum(["pending", "visible", "hidden", "deleted"]);

export const ratingUpsertInput = z.strictObject({
  novelId: positiveEntityId,
  /** Star Rating 1–5, not points/currency and not reward balance. */
  stars: z.number().int().min(1).max(5),
  clientRequestKey: optionalClientKey,
});

export type FeedbackCreateInput = z.infer<typeof feedbackCreateInput>;
export type TicketCreateInput = z.infer<typeof ticketCreateInput>;
export type TicketReplyInput = z.infer<typeof ticketReplyInput>;
export type ReportCreateInput = z.infer<typeof reportCreateInput>;
export type CommentCreateInput = z.infer<typeof commentCreateInput>;
export type RatingUpsertInput = z.infer<typeof ratingUpsertInput>;
export type TicketStatus = z.infer<typeof ticketStatus>;
export type ReportStatus = z.infer<typeof reportStatus>;
export type CommentStatus = z.infer<typeof commentStatus>;
