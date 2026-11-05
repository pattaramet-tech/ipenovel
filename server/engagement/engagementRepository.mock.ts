/**
 * P2R3B-A in-memory EngagementRepository implementation for CONTRACT TESTS.
 *
 * - `withTransaction` snapshots all state before `work` and restores it on
 *   ANY throw - demonstrating (at mock level) that a failed mutation rolls
 *   its rate-limit consumption and partial writes back.
 * - `incrementRateLimit` is a plain counter here; it does NOT prove
 *   multi-instance atomicity of a real database upsert. That evidence
 *   belongs to the future DB integration tests.
 */
import type {
  CommentModerationAuditRecord,
  EngagementCommentRecord,
  EngagementRepository,
  EngagementTransaction,
  FeedbackRecord,
  RatingAggregate,
  RatingRecord,
  ReportDecisionRecord,
  ReportRecord,
  StoredIdempotencyRecord,
  TicketMessageRecord,
  TicketMessageRedactionRecord,
  TicketRecord,
  TicketStatusEventRecord,
} from "./engagementRepository";
import type { CommentRecord } from "./commentVisibility";

interface NovelRegistryEntry {
  isPublished: boolean;
  authorUserId: number | null;
  episodeIds: number[];
}

export class InMemoryEngagementRepository implements EngagementRepository {
  private _feedback: FeedbackRecord[] = [];
  private _tickets: TicketRecord[] = [];
  private _ticketMessages: TicketMessageRecord[] = [];
  private _ticketStatusEvents: TicketStatusEventRecord[] = [];
  private _ticketRedactions: TicketMessageRedactionRecord[] = [];
  private _reports: ReportRecord[] = [];
  private _reportDecisions: ReportDecisionRecord[] = [];
  private _comments: EngagementCommentRecord[] = [];
  private _commentAudits: CommentModerationAuditRecord[] = [];
  private _ratings: RatingRecord[] = [];
  private _ratingAggregates = new Map<number, RatingAggregate>();
  private _idempotency = new Map<string, StoredIdempotencyRecord>();
  private _rateWindows = new Map<string, number>();
  private _purchases = new Set<string>();

  private _ids = {
    feedback: 0,
    ticket: 0,
    message: 0,
    event: 0,
    redaction: 0,
    report: 0,
    decision: 0,
    comment: 0,
    audit: 0,
    rating: 0,
  };

  /** Test fixture registry: novel publication/ownership + episodes. */
  novels = new Map<number, NovelRegistryEntry>();
  /** episodeId -> isFree */
  episodes = new Map<number, boolean>();

  private snapshotState() {
    return {
      _feedback: this._feedback,
      _tickets: this._tickets,
      _ticketMessages: this._ticketMessages,
      _ticketStatusEvents: this._ticketStatusEvents,
      _ticketRedactions: this._ticketRedactions,
      _reports: this._reports,
      _reportDecisions: this._reportDecisions,
      _comments: this._comments,
      _commentAudits: this._commentAudits,
      _ratings: this._ratings,
      _ratingAggregates: Array.from(this._ratingAggregates.entries()),
      _idempotency: Array.from(this._idempotency.entries()),
      _rateWindows: Array.from(this._rateWindows.entries()),
      _purchases: Array.from(this._purchases),
      _ids: this._ids,
    };
  }

  async withTransaction<T>(work: (tx: EngagementTransaction) => Promise<T>): Promise<T> {
    const snapshot = JSON.stringify(this.snapshotState());
    try {
      return await work(this as unknown as EngagementTransaction);
    } catch (error) {
      const s = JSON.parse(snapshot) as ReturnType<InMemoryEngagementRepository["snapshotState"]>;
      this._feedback = s._feedback;
      this._tickets = s._tickets;
      this._ticketMessages = s._ticketMessages;
      this._ticketStatusEvents = s._ticketStatusEvents;
      this._ticketRedactions = s._ticketRedactions;
      this._reports = s._reports;
      this._reportDecisions = s._reportDecisions;
      this._comments = s._comments;
      this._commentAudits = s._commentAudits;
      this._ratings = s._ratings;
      this._ratingAggregates = new Map(s._ratingAggregates);
      this._idempotency = new Map(s._idempotency);
      this._rateWindows = new Map(s._rateWindows);
      this._purchases = new Set(s._purchases);
      this._ids = s._ids;
      throw error;
    }
  }

  async incrementRateLimit(scopeKey: string, windowStart: number): Promise<number> {
    const key = `${scopeKey}:${windowStart}`;
    const next = (this._rateWindows.get(key) ?? 0) + 1;
    this._rateWindows.set(key, next);
    return next;
  }

  async findIdempotencyRecord(
    entity: string,
    userId: number,
    clientRequestKey: string
  ): Promise<StoredIdempotencyRecord | null> {
    return this._idempotency.get(`${entity}:u${userId}:${clientRequestKey}`) ?? null;
  }

  async insertIdempotencyRecord(
    entity: string,
    userId: number,
    clientRequestKey: string,
    canonicalPayload: string,
    result: unknown
  ): Promise<void> {
    const key = `${entity}:u${userId}:${clientRequestKey}`;
    if (this._idempotency.has(key)) {
      // emulate a storage unique-constraint failure
      throw new Error(`duplicate idempotency key: ${key}`);
    }
    this._idempotency.set(key, { canonicalPayload, result });
  }

  /** Test helper: grant a purchase entitlement (userId, episodeId). */
  grantPurchase(userId: number, episodeId: number): void {
    this._purchases.add(`${userId}:${episodeId}`);
  }

  /** Test helper: consumed attempts for a scope in a given window. */
  rateWindowCount(scopeKey: string, windowStart: number): number {
    return this._rateWindows.get(`${scopeKey}:${windowStart}`) ?? 0;
  }

  readonly feedback = {
    insert: async (
      record: Omit<FeedbackRecord, "id" | "createdAt"> & { createdAt?: string }
    ): Promise<number> => {
      const id = ++this._ids.feedback;
      this._feedback.push({ ...record, id, createdAt: record.createdAt ?? "2026-01-01T00:00:00.000Z" });
      return id;
    },
    getById: async (id: number) => { const row = this._feedback.find((r) => r.id === id); return row ? { ...row } : null; },
    listByUser: async (userId: number) => this._feedback.filter((r) => r.userId === userId).map((r) => ({ ...r })),
    updateStatus: async (id: number, status: FeedbackRecord["status"]) => {
      const row = this._feedback.find((r) => r.id === id);
      if (row) row.status = status;
    },
  };

  readonly tickets = {
    insert: async (
      record: Omit<TicketRecord, "id" | "createdAt"> & { createdAt?: string }
    ): Promise<number> => {
      const id = ++this._ids.ticket;
      this._tickets.push({ ...record, id, createdAt: record.createdAt ?? "2026-01-01T00:00:00.000Z" });
      return id;
    },
    getById: async (id: number) => { const row = this._tickets.find((r) => r.id === id); return row ? { ...row } : null; },
    listByOwner: async (userId: number) => this._tickets.filter((r) => r.ownerUserId === userId).map((r) => ({ ...r })),
    updateStatus: async (id: number, status: TicketRecord["status"]) => {
      const row = this._tickets.find((r) => r.id === id);
      if (row) row.status = status;
    },
    assignAdmin: async (id: number, adminUserId: number) => {
      const row = this._tickets.find((r) => r.id === id);
      if (row && row.assignedAdminId === null) row.assignedAdminId = adminUserId;
    },
    insertMessage: async (
      record: Omit<TicketMessageRecord, "id" | "createdAt"> & { createdAt?: string }
    ): Promise<number> => {
      const id = ++this._ids.message;
      this._ticketMessages.push({ ...record, id, createdAt: record.createdAt ?? "2026-01-01T00:00:00.000Z" });
      return id;
    },
    listMessages: async (ticketId: number) => this._ticketMessages.filter((r) => r.ticketId === ticketId).map((r) => ({ ...r })),
    getMessage: async (messageId: number) => { const row = this._ticketMessages.find((r) => r.id === messageId); return row ? { ...row } : null; },
    insertStatusEvent: async (
      record: Omit<TicketStatusEventRecord, "id" | "createdAt"> & { createdAt?: string }
    ): Promise<void> => {
      this._ticketStatusEvents.push({
        ...record,
        id: ++this._ids.event,
        createdAt: record.createdAt ?? "2026-01-01T00:00:00.000Z",
      });
    },
    listStatusEvents: async (ticketId: number) =>
      this._ticketStatusEvents.filter((r) => r.ticketId === ticketId),
    insertMessageRedaction: async (
      record: Omit<TicketMessageRedactionRecord, "id" | "createdAt"> & { createdAt?: string }
    ): Promise<void> => {
      this._ticketRedactions.push({
        ...record,
        id: ++this._ids.redaction,
        createdAt: record.createdAt ?? "2026-01-01T00:00:00.000Z",
      });
    },
    listMessageRedactions: async (messageId: number) =>
      this._ticketRedactions.filter((r) => r.messageId === messageId),
  };

  readonly reports = {
    targetVisibleToReporter: async (
      targetType: string,
      targetId: number,
      reporterUserId: number
    ) => {
      // fail-closed: only publicly visible content is reportable
      if (targetType === "novel") {
        const novel = this.novels.get(targetId);
        return !!novel && novel.isPublished;
      }
      if (targetType === "episode") {
        if (!this.episodes.has(targetId)) return false;
        for (const [, novel] of Array.from(this.novels.entries())) {
          if ((novel.episodeIds ?? []).includes(targetId)) return novel.isPublished;
        }
        return false;
      }
      if (targetType === "comment") {
        const comment = this._comments.find((c) => c.id === targetId);
        if (!comment || comment.status !== "visible") return false;
        const novel = this.novels.get(comment.novelId);
        return !!novel && novel.isPublished;
      }
      return false;
    },
    insert: async (
      record: Omit<ReportRecord, "id" | "createdAt"> & { createdAt?: string }
    ): Promise<number> => {
      const id = ++this._ids.report;
      this._reports.push({ ...record, id, createdAt: record.createdAt ?? "2026-01-01T00:00:00.000Z" });
      return id;
    },
    getById: async (id: number) => { const row = this._reports.find((r) => r.id === id); return row ? { ...row } : null; },
    listByReporter: async (userId: number) => this._reports.filter((r) => r.reporterUserId === userId).map((r) => ({ ...r })),
    updateStatus: async (id: number, status: ReportRecord["status"]) => {
      const row = this._reports.find((r) => r.id === id);
      if (row) row.status = status;
    },
    insertDecision: async (
      record: Omit<ReportDecisionRecord, "id" | "createdAt"> & { createdAt?: string }
    ): Promise<void> => {
      this._reportDecisions.push({
        ...record,
        id: ++this._ids.decision,
        createdAt: record.createdAt ?? "2026-01-01T00:00:00.000Z",
      });
    },
    listDecisions: async (reportId: number) =>
      this._reportDecisions.filter((r) => r.reportId === reportId),
  };

  readonly comments = {
    getNovelPublication: async (novelId: number) => {
      const novel = this.novels.get(novelId);
      return novel ? { isPublished: novel.isPublished } : null;
    },
    listByNovel: async (novelId: number) => this._comments.filter((r) => r.novelId === novelId).map((r) => ({ ...r })),
    getById: async (id: number) => { const row = this._comments.find((r) => r.id === id); return row ? { ...row } : null; },
    insert: async (
      record: Omit<EngagementCommentRecord, "id" | "createdAt"> & { createdAt?: string }
    ): Promise<number> => {
      const id = ++this._ids.comment;
      this._comments.push({ ...record, id, createdAt: record.createdAt ?? "2026-01-01T00:00:00.000Z" });
      return id;
    },
    updateStatus: async (id: number, status: EngagementCommentRecord["status"]) => {
      const row = this._comments.find((r) => r.id === id);
      if (row) row.status = status;
    },
    insertModerationAudit: async (
      record: Omit<CommentModerationAuditRecord, "id" | "createdAt"> & { createdAt?: string }
    ): Promise<void> => {
      this._commentAudits.push({
        ...record,
        id: ++this._ids.audit,
        createdAt: record.createdAt ?? "2026-01-01T00:00:00.000Z",
      });
    },
    listModerationAudit: async (commentId: number) =>
      this._commentAudits.filter((r) => r.commentId === commentId),
  };

  readonly ratings = {
    getNovelFacts: async (novelId: number) => {
      const novel = this.novels.get(novelId);
      return novel ? { isPublished: novel.isPublished, authorUserId: novel.authorUserId } : null;
    },
    userCanReadAnyEpisode: async (userId: number, novelId: number) => {
      const novel = this.novels.get(novelId);
      if (!novel) return false;
      for (const episodeId of novel.episodeIds ?? []) {
        if (this.episodes.get(episodeId)) return true;
        if (this._purchases.has(`${userId}:${episodeId}`)) return true;
      }
      return false;
    },
    getByUserAndNovel: async (userId: number, novelId: number) => { const row = this._ratings.find((r) => r.userId === userId && r.novelId === novelId); return row ? { ...row } : null; },
    insert: async (
      record: Omit<RatingRecord, "id" | "updatedAt"> & { updatedAt?: string }
    ): Promise<number> => {
      const id = ++this._ids.rating;
      this._ratings.push({ ...record, id, updatedAt: record.updatedAt ?? "2026-01-01T00:00:00.000Z" });
      return id;
    },
    updateStars: async (ratingId: number, stars: number) => {
      const row = this._ratings.find((r) => r.id === ratingId);
      if (row) row.stars = stars;
    },
    getAggregate: async (novelId: number): Promise<RatingAggregate> =>
      this._ratingAggregates.get(novelId) ?? { sum: 0, count: 0 },
    adjustAggregate: async (novelId: number, sumDelta: number, countDelta: number) => {
      const current = this._ratingAggregates.get(novelId) ?? { sum: 0, count: 0 };
      this._ratingAggregates.set(novelId, {
        sum: current.sum + sumDelta,
        count: current.count + countDelta,
      });
    },
  };

  /** Test helper: expose raw stored comment rows (e.g. to seed pending). */
  addRawComment(
    record: Omit<EngagementCommentRecord, "id" | "createdAt"> & { createdAt?: string }
  ): number {
    const id = ++this._ids.comment;
    this._comments.push({ ...record, id, createdAt: record.createdAt ?? "2026-01-01T00:00:00.000Z" });
    return id;
  }

  /** Test helper: stored records (for projection assertions). */
  storedCommentRecords(): CommentRecord[] {
    return this._comments.map((c) => ({
      id: c.id,
      parentCommentId: c.parentCommentId,
      authorUserId: c.authorUserId,
      message: c.message,
      status: c.status,
      createdAt: c.createdAt,
    }));
  }
}
