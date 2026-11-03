/**
 * Isolated Notifications schema declarations, re-exported by
 * drizzle/schema.ts and registered as additive migration
 * 0067_notifications_engagement in drizzle/meta/_journal.json
 * (see server/notifications/migrationContract.test.ts).
 *
 * These declarations still do NOT by themselves enable any feature:
 * producers and delivery stay OFF by default behind the runtime gate, and
 * staging-first migration qualification plus the user-reference lifecycle
 * classifications (accountRecoveryDataClassification,
 * adminUserDeletionClassification, accountMergeInventory) are prerequisites
 * recorded in docs/IPE-NOTIFICATIONS-ROLL-OUT-PLAN.md.
 */
import {
  bigint, boolean, index, int, mysqlTable, timestamp, uniqueIndex, varchar,
} from "drizzle-orm/mysql-core";

/** Shared immutable outcome, never payment slip/auth/session/private content. */
export const notificationEvents = mysqlTable("notificationEvents", {
  id: bigint("id", { mode: "bigint", unsigned: true }).autoincrement().primaryKey(),
  eventKey: varchar("eventKey", { length: 384 }).notNull(),
  kind: varchar("kind", { length: 64 }).notNull(),
  sourceType: varchar("sourceType", { length: 96 }).notNull(),
  sourceId: varchar("sourceId", { length: 96 }).notNull(),
  transitionKey: varchar("transitionKey", { length: 96 }).notNull(),
  /** Null means fan-out audience; non-null means this user alone. */
  targetUserId: int("targetUserId"),
  /** Hard watermark excludes historical events on feature activation. */
  eligibleAfter: timestamp("eligibleAfter").notNull(),
  occurredAt: timestamp("occurredAt").notNull(),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => ({
  uniqueEventKey: uniqueIndex("notificationEvents_eventKey_uq").on(table.eventKey),
  byKindAt: index("notificationEvents_kind_occurredAt_idx").on(table.kind, table.occurredAt),
  byTarget: index("notificationEvents_targetUserId_idx").on(table.targetUserId),
}));

/**
 * Outbox is delivered at-least-once. DB-qualified claim must fence leaseToken.
 * A worker only writes inbox recipients, never invokes source transitions.
 */
export const notificationOutbox = mysqlTable("notificationOutbox", {
  id: bigint("id", { mode: "bigint", unsigned: true }).autoincrement().primaryKey(),
  eventId: bigint("eventId", { mode: "bigint", unsigned: true }).notNull(),
  state: varchar("state", { length: 24 }).default("pending").notNull(),
  attempt: int("attempt").default(0).notNull(),
  nextAttemptAt: timestamp("nextAttemptAt").defaultNow().notNull(),
  leaseToken: varchar("leaseToken", { length: 96 }),
  leasedUntil: timestamp("leasedUntil"),
  audienceCursor: varchar("audienceCursor", { length: 255 }),
  lastFailureCode: varchar("lastFailureCode", { length: 48 }),
  completedAt: timestamp("completedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => ({
  eventUnique: uniqueIndex("notificationOutbox_eventId_uq").on(table.eventId),
  readyQueue: index("notificationOutbox_state_nextAttemptAt_idx").on(table.state, table.nextAttemptAt, table.id),
  leaseExpiry: index("notificationOutbox_state_leasedUntil_idx").on(table.state, table.leasedUntil),
}));

/**
 * Rows never revive after dismissedAt is set. The user-bound receivedSequence
 * is issued under a common sequencing lock, including bulk high-water reads.
 */
export const notificationRecipients = mysqlTable("notificationRecipients", {
  id: bigint("id", { mode: "bigint", unsigned: true }).autoincrement().primaryKey(),
  eventId: bigint("eventId", { mode: "bigint", unsigned: true }).notNull(),
  userId: int("userId").notNull(),
  receivedSequence: bigint("receivedSequence", { mode: "bigint", unsigned: true }).notNull(),
  category: varchar("category", { length: 24 }).notNull(),
  readAt: timestamp("readAt"),
  dismissedAt: timestamp("dismissedAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
}, table => ({
  uniqueEventRecipient: uniqueIndex("notificationRecipients_event_user_uq").on(table.eventId, table.userId),
  uniqueDeliverySequence: uniqueIndex("notificationRecipients_receivedSequence_uq").on(table.receivedSequence),
  inboxByCategory: index("notificationRecipients_user_category_id_idx").on(table.userId, table.category, table.id),
  inboxBySequence: index("notificationRecipients_user_sequence_idx").on(table.userId, table.receivedSequence),
  unreadByUser: index("notificationRecipients_user_dismissed_read_idx").on(table.userId, table.dismissedAt, table.readAt),
}));

export const notificationPreferences = mysqlTable("notificationPreferences", {
  id: bigint("id", { mode: "bigint", unsigned: true }).autoincrement().primaryKey(),
  userId: int("userId").notNull(),
  kind: varchar("kind", { length: 64 }).notNull(),
  enabled: boolean("enabled").notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().onUpdateNow().notNull(),
}, table => ({
  uniqueUserKind: uniqueIndex("notificationPreferences_user_kind_uq").on(table.userId, table.kind),
}));

/**
 * Snapshot operation uniqueness is (actorUserId,operationKey), deliberately
 * EXCLUDING kind, so a reused key for another action conflicts and fails.
 */
export const notificationBulkOperations = mysqlTable("notificationBulkOperations", {
  id: bigint("id", { mode: "bigint", unsigned: true }).autoincrement().primaryKey(),
  actorUserId: int("actorUserId").notNull(),
  operationKey: varchar("operationKey", { length: 96 }).notNull(),
  kind: varchar("kind", { length: 24 }).notNull(),
  cutoffSequence: bigint("cutoffSequence", { mode: "bigint", unsigned: true }).notNull(),
  state: varchar("state", { length: 24 }).default("pending").notNull(),
  affected: int("affected"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  completedAt: timestamp("completedAt"),
}, table => ({
  actorOperationUnique: uniqueIndex("notificationBulkOperations_actor_key_uq").on(table.actorUserId, table.operationKey),
  byActorCreated: index("notificationBulkOperations_actor_created_idx").on(table.actorUserId, table.createdAt),
}));

/** Single serializable row (id=1) used by both deliveries and bulk cutoffs. */
export const notificationSequence = mysqlTable("notificationSequence", {
  id: int("id").primaryKey(),
  nextSequence: bigint("nextSequence", { mode: "bigint", unsigned: true }).notNull(),
});

/** Distinct durable first-publication marker: no replay on restore/replacement. */
/**
 * First-publication provenance per entity.
 * - state "witnessed_unpublished": the entity was created/staged unpublished
 *   after the activation watermark (firstPublishedAt stays NULL).
 * - state "published": the entity became publicly visible (firstPublishedAt
 *   is the authoritative publication instant).
 * The default "published" keeps the existing create-published producers
 * unchanged; future witness creation MUST set "witnessed_unpublished"
 * explicitly. A published event must never leave its marker in
 * "witnessed_unpublished".
 */
export const notificationPublicationMarkers = mysqlTable("notificationPublicationMarkers", {
  id: bigint("id", { mode: "bigint", unsigned: true }).autoincrement().primaryKey(),
  entityType: varchar("entityType", { length: 24 }).notNull(),
  entityId: bigint("entityId", { mode: "bigint", unsigned: true }).notNull(),
  state: varchar("state", { length: 24 }).notNull().default("published"),
  firstPublishedAt: timestamp("firstPublishedAt"),
  firstEventId: bigint("firstEventId", { mode: "bigint", unsigned: true }),
}, table => ({
  uniquePublicEntity: uniqueIndex("notificationPublicationMarkers_type_entity_uq").on(table.entityType, table.entityId),
}));

/** Digest references are identifiers only, never full chapter text. */
export const notificationDigestEpisodes = mysqlTable("notificationDigestEpisodes", {
  id: bigint("id", { mode: "bigint", unsigned: true }).autoincrement().primaryKey(),
  eventId: bigint("eventId", { mode: "bigint", unsigned: true }).notNull(),
  episodeId: bigint("episodeId", { mode: "bigint", unsigned: true }).notNull(),
}, table => ({
  eventEpisodeUnique: uniqueIndex("notificationDigestEpisodes_event_episode_uq").on(table.eventId, table.episodeId),
}));

/**
 * Durable digest batch for post-commit aggregation of first publications
 * (ZIP imports and Workspace publish runs).
 * - batchKey: colon-free canonical identity, e.g. "wr<runId>n<novelId>"
 *   (Workspace) or "zi<importId>n<novelId>" (ZIP), unique and stable for
 *   retry correlation.
 * - state lifecycle: "collecting" -> "pending_finalize" -> "finalized". An
 *   abandoned "collecting" batch is NEVER finalized by elapsed time alone;
 *   finalization requires the authoritative completion of its source run.
 * - watermarkAt stays NULL until the first qualified publication in the
 *   batch exists (conservative audience cutoff = earliest publication).
 */
export const notificationDigestBatches = mysqlTable("notificationDigestBatches", {
  id: bigint("id", { mode: "bigint", unsigned: true }).autoincrement().primaryKey(),
  batchKey: varchar("batchKey", { length: 96 }).notNull(),
  novelId: int("novelId").notNull(),
  sourceIdentity: varchar("sourceIdentity", { length: 160 }).notNull(),
  state: varchar("state", { length: 24 }).notNull().default("collecting"),
  watermarkAt: timestamp("watermarkAt"),
  createdAt: timestamp("createdAt").defaultNow().notNull(),
  updatedAt: timestamp("updatedAt").defaultNow().notNull(),
  finalizedAt: timestamp("finalizedAt"),
}, table => ({
  batchKeyUnique: uniqueIndex("notificationDigestBatches_batchKey_uq").on(table.batchKey),
  stateCreatedIdx: index("notificationDigestBatches_state_created_idx").on(table.state, table.createdAt),
  novelIdx: index("notificationDigestBatches_novel_idx").on(table.novelId),
}));

/**
 * One durable membership per first-public episode claim. Written in the
 * SAME transaction as the publication (survives crashes before
 * finalization); finalization flips state to "emitted" and backfills
 * firstEventKey/emittedAt. UNIQUE(episodeId) forbids cross-batch
 * duplicate membership - an episode can only ever join one digest batch.
 */
export const notificationDigestMemberships = mysqlTable("notificationDigestMemberships", {
  id: bigint("id", { mode: "bigint", unsigned: true }).autoincrement().primaryKey(),
  batchId: bigint("batchId", { mode: "bigint", unsigned: true }).notNull(),
  episodeId: bigint("episodeId", { mode: "bigint", unsigned: true }).notNull(),
  state: varchar("state", { length: 24 }).notNull().default("claimed"),
  claimedAt: timestamp("claimedAt").defaultNow().notNull(),
  firstEventKey: varchar("firstEventKey", { length: 384 }),
  emittedAt: timestamp("emittedAt"),
}, table => ({
  episodeUnique: uniqueIndex("notificationDigestMemberships_episode_uq").on(table.episodeId),
  batchStateIdx: index("notificationDigestMemberships_batch_state_idx").on(table.batchId, table.state),
}));

export type NotificationEvent = typeof notificationEvents.$inferSelect;
export type NotificationRecipient = typeof notificationRecipients.$inferSelect;
export type NotificationBulkRecord = typeof notificationBulkOperations.$inferSelect;
