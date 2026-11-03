/**
 * P2R3B-A injectable repository/transaction port for the engagement
 * services. This is a CONTRACT ONLY: no SQL, no DDL, no database adapter.
 * The future integration implements this interface over the real database
 * (one implementation per storage engine) and passes it into the services,
 * which stay storage-agnostic and rely exclusively on the P0 policies and
 * the P2R3A pure engines.
 *
 * Transaction discipline expected from every implementation:
 *  - `withTransaction` must run `work` atomically: if `work` throws, every
 *    write performed inside - including rate-limit counter increments -
 *    must be rolled back. This is what makes "a failed mutation does not
 *    consume quota" true at the storage layer.
 *  - `rateLimit.increment` must be atomic under concurrency (e.g. a single
 *    upsert statement with `count = count + 1`) and returns the NEW count.
 *
 * Unit tests exercise these contracts against an in-memory implementation;
 * they do NOT prove real-database atomicity/concurrency (that evidence
 * belongs to the future DB integration tests).
 */
import type {
  CommentStatus,
  ReportStatus,
  TicketStatus,
} from "../../shared/engagement/contracts";
import type { EngagementRole } from "./policies";
import type { CommentRecord } from "./commentVisibility";

export interface EngagementActor {
  userId: number;
  role: EngagementRole;
}

// ---------------------------------------------------------------------------
// Storage record shapes (row-level contracts for future implementations)
// ---------------------------------------------------------------------------

export type FeedbackStatus = "new" | "acknowledged" | "closed";

export interface FeedbackRecord {
  id: number;
  userId: number;
  category: string;
  subject: string;
  message: string;
  status: FeedbackStatus;
  clientRequestKey: string | null;
  /** Canonical payload captured at creation (idempotency fingerprint). */
  canonicalPayload?: string | null;
  createdAt: string;
}

export interface TicketRecord {
  id: number;
  ownerUserId: number;
  subject: string;
  category: string;
  status: TicketStatus;
  assignedAdminId: number | null;
  clientRequestKey: string | null;
  canonicalPayload?: string | null;
  createdAt: string;
}

export interface TicketMessageRecord {
  id: number;
  ticketId: number;
  actorUserId: number;
  actorKind: "customer" | "staff";
  body: string;
  clientRequestKey: string | null;
  canonicalPayload?: string | null;
  createdAt: string;
}

export interface TicketStatusEventRecord {
  id: number;
  ticketId: number;
  fromStatus: TicketStatus;
  toStatus: TicketStatus;
  actorUserId: number;
  actorKind: "customer" | "staff";
  createdAt: string;
}

export interface TicketMessageRedactionRecord {
  id: number;
  messageId: number;
  redactedByAdminUserId: number;
  reasonCode: string;
  createdAt: string;
}

export type ReportTargetType = "novel" | "episode" | "comment";

export interface ReportRecord {
  id: number;
  reporterUserId: number;
  targetType: ReportTargetType;
  targetId: number;
  reason: string;
  details: string;
  status: ReportStatus;
  clientRequestKey: string | null;
  canonicalPayload?: string | null;
  createdAt: string;
}

export interface ReportDecisionRecord {
  id: number;
  reportId: number;
  adminUserId: number;
  fromStatus: ReportStatus;
  toStatus: ReportStatus;
  reasonCode: string | null;
  createdAt: string;
}

/** Comment storage row: visibility projection fields + engagement extras. */
export interface EngagementCommentRecord extends CommentRecord {
  novelId: number;
  clientRequestKey: string | null;
  canonicalPayload?: string | null;
}

export interface CommentModerationAuditRecord {
  id: number;
  commentId: number;
  actorUserId: number;
  fromStatus: CommentStatus;
  toStatus: CommentStatus;
  reasonCode: string | null;
  createdAt: string;
}

export interface RatingRecord {
  id: number;
  novelId: number;
  userId: number;
  stars: number;
  updatedAt: string;
}

export interface RatingAggregate {
  sum: number;
  count: number;
}

/** Facts the rating service needs about a novel (server-authoritative). */
export interface NovelRatingFacts {
  isPublished: boolean;
  /** null = ownership unknown -> rating is fail-closed FORBIDDEN. */
  authorUserId: number | null;
}

export type EngagementEntity =
  | "feedback"
  | "ticket"
  | "ticketMessage"
  | "report"
  | "comment"
  | "rating";

export interface StoredIdempotencyRecord<T = unknown> {
  canonicalPayload: string;
  result: T;
}

// ---------------------------------------------------------------------------
// Transaction port
// ---------------------------------------------------------------------------

export interface EngagementTransaction {
  /** Atomic fixed-window counter increment; returns the NEW count. */
  incrementRateLimit(scopeKey: string, windowStart: number): Promise<number>;

  findIdempotencyRecord(
    entity: EngagementEntity,
    userId: number,
    clientRequestKey: string
  ): Promise<StoredIdempotencyRecord | null>;

  /** Must let a storage-level duplicate-key error surface to the caller. */
  insertIdempotencyRecord(
    entity: EngagementEntity,
    userId: number,
    clientRequestKey: string,
    canonicalPayload: string,
    result: unknown
  ): Promise<void>;

  feedback: {
    insert(record: Omit<FeedbackRecord, "id" | "createdAt"> & { createdAt?: string }): Promise<number>;
    getById(id: number): Promise<FeedbackRecord | null>;
    listByUser(userId: number): Promise<FeedbackRecord[]>;
    updateStatus(id: number, status: FeedbackStatus): Promise<void>;
  };

  tickets: {
    insert(record: Omit<TicketRecord, "id" | "createdAt"> & { createdAt?: string }): Promise<number>;
    getById(id: number): Promise<TicketRecord | null>;
    listByOwner(userId: number): Promise<TicketRecord[]>;
    updateStatus(id: number, status: TicketStatus): Promise<void>;
    assignAdmin(id: number, adminUserId: number): Promise<void>;
    insertMessage(
      record: Omit<TicketMessageRecord, "id" | "createdAt"> & { createdAt?: string }
    ): Promise<number>;
    listMessages(ticketId: number): Promise<TicketMessageRecord[]>;
    getMessage(messageId: number): Promise<TicketMessageRecord | null>;
    insertStatusEvent(
      record: Omit<TicketStatusEventRecord, "id" | "createdAt"> & { createdAt?: string }
    ): Promise<void>;
    listStatusEvents(ticketId: number): Promise<TicketStatusEventRecord[]>;
    insertMessageRedaction(
      record: Omit<TicketMessageRedactionRecord, "id" | "createdAt"> & { createdAt?: string }
    ): Promise<void>;
    listMessageRedactions(messageId: number): Promise<TicketMessageRedactionRecord[]>;
  };

  reports: {
    /**
     * Fail-closed target gate: true only when the target EXISTS and is
     * legitimately visible to the reporter (published novel / episode of a
     * published novel / visible comment on a published novel). Unknown,
     * private or unpublished targets return false - the service maps that
     * to NOT_FOUND so existence is never revealed.
     */
    targetVisibleToReporter(
      targetType: ReportTargetType,
      targetId: number,
      reporterUserId: number
    ): Promise<boolean>;
    insert(record: Omit<ReportRecord, "id" | "createdAt"> & { createdAt?: string }): Promise<number>;
    getById(id: number): Promise<ReportRecord | null>;
    listByReporter(userId: number): Promise<ReportRecord[]>;
    updateStatus(id: number, status: ReportStatus): Promise<void>;
    insertDecision(
      record: Omit<ReportDecisionRecord, "id" | "createdAt"> & { createdAt?: string }
    ): Promise<void>;
    listDecisions(reportId: number): Promise<ReportDecisionRecord[]>;
  };

  comments: {
    getNovelPublication(novelId: number): Promise<{ isPublished: boolean } | null>;
    /** All comment rows for a novel regardless of status (projection is pure). */
    listByNovel(novelId: number): Promise<EngagementCommentRecord[]>;
    getById(id: number): Promise<EngagementCommentRecord | null>;
    insert(
      record: Omit<EngagementCommentRecord, "id" | "createdAt"> & { createdAt?: string }
    ): Promise<number>;
    updateStatus(id: number, status: CommentStatus): Promise<void>;
    insertModerationAudit(
      record: Omit<CommentModerationAuditRecord, "id" | "createdAt"> & { createdAt?: string }
    ): Promise<void>;
    listModerationAudit(commentId: number): Promise<CommentModerationAuditRecord[]>;
  };

  ratings: {
    getNovelFacts(novelId: number): Promise<NovelRatingFacts | null>;
    /** Server-verified reading entitlement for ANY episode of the novel. */
    userCanReadAnyEpisode(userId: number, novelId: number): Promise<boolean>;
    getByUserAndNovel(userId: number, novelId: number): Promise<RatingRecord | null>;
    insert(record: Omit<RatingRecord, "id" | "updatedAt"> & { updatedAt?: string }): Promise<number>;
    updateStars(ratingId: number, stars: number): Promise<void>;
    getAggregate(novelId: number): Promise<RatingAggregate>;
    /** Aggregate adjustment MUST happen in the same transaction as the row write. */
    adjustAggregate(novelId: number, sumDelta: number, countDelta: number): Promise<void>;
  };
}

export interface EngagementRepository {
  withTransaction<T>(work: (tx: EngagementTransaction) => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------
// Approved rate limits (PD-04) - the ONLY limits services may enforce.
// Everything else (ticket create/reply, rating update, admin, per-IP) is
// PENDING CONFIGURATION and intentionally absent here.
// ---------------------------------------------------------------------------

export const APPROVED_RATE_LIMITS = {
  feedback: { windowMs: 10 * 60_000, limit: 3 }, // 3 / 10 minutes
  report: { windowMs: 60 * 60_000, limit: 3 }, // 3 / hour
  comment: { windowMs: 60_000, limit: 5 }, // 5 / minute
} as const;
