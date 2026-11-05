/**
 * Isolated Engagement schema declarations (P2R3B-R8A), mirroring
 * server/notifications/tables.ts's additive-migration pattern:
 * re-exported by drizzle/schema.ts and registered as the candidate
 * migration drizzle/0068_engagement_foundation.sql in
 * drizzle/meta/_journal.json (see
 * server/engagement/migrationContract.test.ts for the schema<->SQL
 * consistency contract).
 *
 * These declarations do NOT enable any feature: every service consumer is
 * OFF by default behind an engagement runtime gate that does not exist
 * yet, no router is registered, and no migration has been applied to any
 * database - this file plus 0068 are a REVIEWED CANDIDATE only.
 *
 * Integrity policy (matches the 0067 additive pattern): NO FOREIGN KEY
 * constraints and NO CASCADE - cross-table integrity is enforced by the
 * engagement services (P0 policies + transaction port), and the complete
 * absence of CASCADE is a hard requirement of the user-reference
 * lifecycle classification (account recovery / hard delete / merge must
 * never silently destroy audit evidence). Every user-referencing column
 * below is registered in
 * server/services/accountRecoveryDataClassification.ts and
 * server/services/adminUserDeletionClassification.ts.
 */
import {
  bigint,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  tinyint,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

// ---------------------------------------------------------------------------
// 1. Feedback - one-way suggestion channel (PD-05); no discussion, no public
//    listing. Status: new -> acknowledged -> closed (admin-only transitions).
// ---------------------------------------------------------------------------
export const engagementFeedback = mysqlTable("engagementFeedback", {
  id: int("id").autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  category: mysqlEnum("category", ["bug", "suggestion", "usability", "other"]).notNull().default("bug"),
  subject: varchar("subject", { length: 160 }).notNull(),
  message: text("message").notNull(),
  status: mysqlEnum("status", ["new", "acknowledged", "closed"]).notNull().default("new"),
  clientRequestKey: varchar("clientRequestKey", { length: 96 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, table => ({
  feedbackUserRequestKeyUq: uniqueIndex("engagementFeedback_user_clientRequestKey_uq").on(table.userId, table.clientRequestKey),
  byUser: index("engagementFeedback_user_createdAt_idx").on(table.userId, table.createdAt),
}));

// ---------------------------------------------------------------------------
// 2-5. Support tickets: owner-private conversation with staff (P0
//      `nextTicketStatus` lifecycle; append-only status events; redaction
//      is an append-only record - message rows are never modified).
// ---------------------------------------------------------------------------
export const supportTickets = mysqlTable("supportTickets", {
  id: int("id").autoincrement().primaryKey(),
  ownerUserId: int("ownerUserId").notNull(),
  subject: varchar("subject", { length: 160 }).notNull(),
  category: mysqlEnum("category", ["account", "payment", "reading", "technical", "other"]).notNull(),
  status: mysqlEnum("status", ["open", "waiting_user", "waiting_staff", "resolved", "closed"]).notNull().default("open"),
  /** Admin who claimed the ticket (first staff action); null = unassigned. */
  assignedAdminId: int("assignedAdminId"),
  clientRequestKey: varchar("clientRequestKey", { length: 96 }),
  /** Optimistic-concurrency fencing for status transitions. */
  version: int("version").notNull().default(1),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, table => ({
  ticketOwnerRequestKeyUq: uniqueIndex("supportTickets_owner_clientRequestKey_uq").on(table.ownerUserId, table.clientRequestKey),
  byOwnerStatus: index("supportTickets_owner_status_updatedAt_idx").on(table.ownerUserId, table.status, table.updatedAt),
}));

export const supportTicketMessages = mysqlTable("supportTicketMessages", {
  id: int("id").autoincrement().primaryKey(),
  ticketId: int("ticketId").notNull(),
  actorUserId: int("actorUserId").notNull(),
  actorKind: mysqlEnum("actorKind", ["customer", "staff"]).notNull(),
  body: text("body").notNull(),
  clientRequestKey: varchar("clientRequestKey", { length: 96 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => ({
  messageRequestKeyUq: uniqueIndex("supportTicketMessages_ticket_actor_clientRequestKey_uq").on(table.ticketId, table.actorUserId, table.clientRequestKey),
  byTicket: index("supportTicketMessages_ticket_createdAt_idx").on(table.ticketId, table.createdAt),
}));

export const supportTicketStatusEvents = mysqlTable("supportTicketStatusEvents", {
  id: int("id").autoincrement().primaryKey(),
  ticketId: int("ticketId").notNull(),
  fromStatus: mysqlEnum("fromStatus", ["open", "waiting_user", "waiting_staff", "resolved", "closed"]).notNull(),
  toStatus: mysqlEnum("toStatus", ["open", "waiting_user", "waiting_staff", "resolved", "closed"]).notNull(),
  actorUserId: int("actorUserId").notNull(),
  actorKind: mysqlEnum("actorKind", ["customer", "staff"]).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => ({
  byTicket: index("supportTicketStatusEvents_ticket_id_idx").on(table.ticketId, table.id),
}));

export const supportTicketMessageRedactions = mysqlTable("supportTicketMessageRedactions", {
  id: int("id").autoincrement().primaryKey(),
  messageId: int("messageId").notNull(),
  redactedByAdminUserId: int("redactedByAdminUserId").notNull(),
  reasonCode: varchar("reasonCode", { length: 48 }).notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => ({
  byMessage: index("supportTicketMessageRedactions_message_idx").on(table.messageId),
}));

// ---------------------------------------------------------------------------
// 6-7. Content reports: reporter-private until resolution; targets are
//      polymorphic (novel/episode/comment) and validated by the service -
//      no FK by design (P0 doc: "no direct FK implied"). Decisions are
//      append-only audit evidence (retention anchor source).
// ---------------------------------------------------------------------------
export const contentReports = mysqlTable("contentReports", {
  id: int("id").autoincrement().primaryKey(),
  reporterUserId: int("reporterUserId").notNull(),
  targetType: mysqlEnum("targetType", ["novel", "episode", "comment"]).notNull(),
  targetId: int("targetId").notNull(),
  reason: mysqlEnum("reason", ["spam", "abuse", "copyright", "illegal", "other"]).notNull(),
  details: text("details").notNull(),
  status: mysqlEnum("status", ["new", "in_review", "resolved", "dismissed"]).notNull().default("new"),
  clientRequestKey: varchar("clientRequestKey", { length: 96 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, table => ({
  reportReporterRequestKeyUq: uniqueIndex("contentReports_reporter_clientRequestKey_uq").on(table.reporterUserId, table.clientRequestKey),
  byStatus: index("contentReports_status_createdAt_idx").on(table.status, table.createdAt),
  byTarget: index("contentReports_target_idx").on(table.targetType, table.targetId),
}));

export const contentReportDecisions = mysqlTable("contentReportDecisions", {
  id: int("id").autoincrement().primaryKey(),
  reportId: int("reportId").notNull(),
  adminUserId: int("adminUserId").notNull(),
  fromStatus: mysqlEnum("fromStatus", ["new", "in_review", "resolved", "dismissed"]).notNull(),
  toStatus: mysqlEnum("toStatus", ["new", "in_review", "resolved", "dismissed"]).notNull(),
  reasonCode: varchar("reasonCode", { length: 48 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => ({
  byReport: index("contentReportDecisions_report_id_idx").on(table.reportId, table.id),
}));

// ---------------------------------------------------------------------------
// 8-9. Novel comments (post-moderation V1): comments are created `visible`;
//      `pending` exists in the enum for the future but has NO creation path.
//      One reply level (parent must be a visible root on the same novel).
//      Moderation audit is append-only and never restores author-deleted
//      text.
// ---------------------------------------------------------------------------
export const novelComments = mysqlTable("novelComments", {
  id: int("id").autoincrement().primaryKey(),
  novelId: int("novelId").notNull(),
  authorUserId: int("authorUserId").notNull(),
  parentCommentId: int("parentCommentId"),
  message: text("message").notNull(),
  status: mysqlEnum("status", ["pending", "visible", "hidden", "deleted"]).notNull().default("visible"),
  clientRequestKey: varchar("clientRequestKey", { length: 96 }),
  version: int("version").notNull().default(1),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, table => ({
  commentAuthorRequestKeyUq: uniqueIndex("novelComments_author_clientRequestKey_uq").on(table.authorUserId, table.clientRequestKey),
  byNovelThread: index("novelComments_novel_parent_status_id_idx").on(table.novelId, table.parentCommentId, table.status, table.id),
}));

export const novelCommentModerationAudit = mysqlTable("novelCommentModerationAudit", {
  id: int("id").autoincrement().primaryKey(),
  commentId: int("commentId").notNull(),
  actorUserId: int("actorUserId").notNull(),
  fromStatus: mysqlEnum("fromStatus", ["pending", "visible", "hidden", "deleted"]).notNull(),
  toStatus: mysqlEnum("toStatus", ["pending", "visible", "hidden", "deleted"]).notNull(),
  reasonCode: varchar("reasonCode", { length: 48 }),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => ({
  byComment: index("novelCommentModerationAudit_comment_id_idx").on(table.commentId, table.id),
}));

// ---------------------------------------------------------------------------
// 10-11. Star ratings (PD-03/06): integer 1..5, UNIQUE per user+novel -
//        re-rating REPLACES the stars. The aggregate is transactionally
//        maintained by the rating service in the SAME transaction as the
//        row write (Owner decision, P2R3B-R7/A-2): never client-computed.
// ---------------------------------------------------------------------------
export const novelRatings = mysqlTable("novelRatings", {
  id: int("id").autoincrement().primaryKey(),
  novelId: int("novelId").notNull(),
  userId: int("userId").notNull(),
  stars: tinyint("stars").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, table => ({
  ratingUserNovelUq: uniqueIndex("novelRatings_user_novel_uq").on(table.userId, table.novelId),
  byNovel: index("novelRatings_novel_idx").on(table.novelId),
}));

export const novelRatingAggregates = mysqlTable("novelRatingAggregates", {
  novelId: int("novelId").primaryKey(),
  sum: int("sum").notNull().default(0),
  count: int("count").notNull().default(0),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
});

// ---------------------------------------------------------------------------
// 12. Central idempotency ledger (Owner decision, P2R3B-R7/A-1): one row per
//     (entity, user, clientRequestKey). canonicalPayload is the Zod-parsed
//     canonical JSON captured at creation - a reused key with a different
//     payload conflicts; resultJson stores the replayed mutation result.
// ---------------------------------------------------------------------------
export const engagementIdempotencyRecords = mysqlTable("engagementIdempotencyRecords", {
  id: int("id").autoincrement().primaryKey(),
  entity: mysqlEnum("entity", ["feedback", "ticket", "ticketMessage", "report", "comment", "rating"]).notNull(),
  userId: int("userId").notNull(),
  clientRequestKey: varchar("clientRequestKey", { length: 96 }).notNull(),
  canonicalPayload: text("canonicalPayload").notNull(),
  resultJson: json("resultJson"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => ({
  idempotencyEntityUserKeyUq: uniqueIndex("engagementIdempotencyRecords_entity_user_key_uq").on(table.entity, table.userId, table.clientRequestKey),
  byUser: index("engagementIdempotencyRecords_user_createdAt_idx").on(table.userId, table.createdAt),
}));

// ---------------------------------------------------------------------------
// 13. Atomic fixed-window rate limiting (PD-04): the counter increment is a
//     single upsert (`count = count + 1`) inside the mutation transaction -
//     a failed mutation rolls its consumption back. scopeKey examples:
//     `feedback.create:u7`.
// ---------------------------------------------------------------------------
export const rateLimitWindows = mysqlTable("rateLimitWindows", {
  id: int("id").autoincrement().primaryKey(),
  scopeKey: varchar("scopeKey", { length: 191 }).notNull(),
  windowStart: bigint("windowStart", { mode: "number" }).notNull(),
  count: int("count").notNull().default(0),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, table => ({
  rateScopeWindowUq: uniqueIndex("rateLimitWindows_scope_windowStart_uq").on(table.scopeKey, table.windowStart),
}));
