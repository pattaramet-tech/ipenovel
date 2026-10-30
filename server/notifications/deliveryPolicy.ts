import type { NotificationKind } from "./contract";

/**
 * Persistence adapter contract for an in-app inbox outbox worker. The adapter
 * must claim rows with a DB-backed lease, use an immutable audience/cutover
 * snapshot, and keep dismissed recipients as tombstones.
 *
 * No business approval, wallet debit, entitlement, or publication method may
 * be passed to or invoked from this worker.
 */
export interface ClaimedEvent {
  eventId: string;
  eventKey: string;
  kind: NotificationKind;
  leaseToken: string;
  attempt: number;
  /** Decimal keyset user ID; never an opaque, cyclic page token. */
  audienceCursor: string | null;
}

export interface AudiencePage {
  userIds: number[];
  nextCursor: string | null;
}

export type RecipientInsert = "created" | "already_exists" | "dismissed" | "ineligible";

export interface NotificationDeliveryStore {
  /** Atomic lease; cannot claim the same event with two live workers. */
  claimReadyEvents(now: Date, limit: number): Promise<ClaimedEvent[]>;
  /** Immutable membership/activation snapshot; cursor must progress. */
  readAudience(event: ClaimedEvent, limit: number): Promise<AudiencePage>;
  /** Unique (event,user); never UPDATE a dismissed recipient to restore it. */
  insertRecipientIfAbsent(event: ClaimedEvent, userId: number): Promise<RecipientInsert>;
  /** Atomically commit cursor and release lease (fenced by leaseToken). */
  checkpointAudience(event: ClaimedEvent, nextCursor: string): Promise<void>;
  /** Atomically mark completed (fenced by leaseToken). */
  completeEvent(event: ClaimedEvent): Promise<void>;
  /** Atomically release lease and store scheduled next attempt. */
  scheduleRetry(event: ClaimedEvent, retryAt: Date, failureCode: string): Promise<void>;
  /** Terminal dead letter; operator can inspect without re-running domain action. */
  deadLetter(event: ClaimedEvent, failureCode: string): Promise<void>;
}

export interface DeliveryLimits {
  maxEvents: number;
  maxRecipientsPerEvent: number;
  maxAttempts: number;
  baseRetryMs: number;
  maxRetryMs: number;
}

export const DEFAULT_DELIVERY_LIMITS: Readonly<DeliveryLimits> = Object.freeze({
  maxEvents: 10,
  maxRecipientsPerEvent: 100,
  maxAttempts: 8,
  baseRetryMs: 30_000,
  maxRetryMs: 30 * 60_000,
});

function checkedLimits(limits: DeliveryLimits): void {
  if (![limits.maxEvents, limits.maxRecipientsPerEvent, limits.maxAttempts,
        limits.baseRetryMs, limits.maxRetryMs].every(Number.isSafeInteger) ||
      limits.maxEvents < 1 || limits.maxEvents > 20 ||
      limits.maxRecipientsPerEvent < 1 || limits.maxRecipientsPerEvent > 200 ||
      limits.maxAttempts < 1 || limits.maxAttempts > 20 ||
      limits.baseRetryMs < 1000 || limits.maxRetryMs < limits.baseRetryMs ||
      limits.maxRetryMs > 24 * 60 * 60_000) {
    throw new Error("Invalid notification delivery limits");
  }
}

/** Exponential retry is capped and does not depend on provider/user secrets. */
export function retryDelayMs(attempt: number, limits: DeliveryLimits = DEFAULT_DELIVERY_LIMITS): number {
  checkedLimits(limits);
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error("Invalid retry attempt");
  return Math.min(limits.maxRetryMs, limits.baseRetryMs * 2 ** Math.min(attempt - 1, 30));
}

function safeFailureCode(error: unknown): string {
  // Do not store exception messages; they may contain private paths, SQL or PII.
  if (error instanceof Error && error.name === "NotificationPermanentError") return "PERMANENT_DELIVERY_ERROR";
  return "DELIVERY_ERROR";
}

export class NotificationPermanentError extends Error {
  constructor() {
    super("Permanent notification delivery failure");
    this.name = "NotificationPermanentError";
  }
}

export interface TickResult {
  claimed: number;
  created: number;
  alreadyExists: number;
  dismissed: number;
  ineligible: number;
  completed: number;
  partial: number;
  retried: number;
  deadLettered: number;
}

/**
 * Process at most one bounded audience page per claimed event per tick.
 * A crash after some inserts but before checkpoint replays safely because
 * recipients have unique keys and dismissed recipients cannot be revived.
 */
export async function runInAppDeliveryTick(
  store: NotificationDeliveryStore,
  now: Date,
  limits: DeliveryLimits = DEFAULT_DELIVERY_LIMITS,
): Promise<TickResult> {
  checkedLimits(limits);
  if (Number.isNaN(now.getTime())) throw new Error("Invalid worker time");
  const claimed = await store.claimReadyEvents(now, limits.maxEvents);
  if (claimed.length > limits.maxEvents) throw new Error("Store exceeded notification claim limit");
  const result: TickResult = {
    claimed: claimed.length, created: 0, alreadyExists: 0, dismissed: 0,
    ineligible: 0, completed: 0, partial: 0, retried: 0, deadLettered: 0,
  };
  for (const event of claimed) {
    if (!Number.isSafeInteger(event.attempt) || event.attempt < 1 ||
        !event.leaseToken || !event.eventKey.startsWith("notification:v1:")) {
      throw new Error("Invalid claimed event identity");
    }
    try {
      const page = await store.readAudience(event, limits.maxRecipientsPerEvent);
      if (page.userIds.length > limits.maxRecipientsPerEvent) {
        throw new NotificationPermanentError();
      }
      // The audience adapter uses a monotonic user-ID keyset, not an opaque
      // cursor that can oscillate across retries or duplicate prior pages.
      const parseCursor = (value: string | null): number => {
        if (value === null) return 0;
        if (!/^[1-9][0-9]*$/.test(value)) throw new NotificationPermanentError();
        const parsed = Number(value);
        if (!Number.isSafeInteger(parsed)) throw new NotificationPermanentError();
        return parsed;
      };
      const start = parseCursor(event.audienceCursor);
      let lastUserId = start;
      for (const userId of page.userIds) {
        if (!Number.isSafeInteger(userId) || userId <= lastUserId) {
          throw new NotificationPermanentError();
        }
        lastUserId = userId;
      }
      if (page.nextCursor !== null) {
        const next = parseCursor(page.nextCursor);
        // A cursor may pass filtered-out users, but may not move backwards
        // or precede any user returned by this page.
        if (next <= start || next < lastUserId) throw new NotificationPermanentError();
      }
      for (const userId of page.userIds) {
        const decision = await store.insertRecipientIfAbsent(event, userId);
        switch (decision) {
          case "created": result.created++; break;
          case "already_exists": result.alreadyExists++; break;
          case "dismissed": result.dismissed++; break;
          case "ineligible": result.ineligible++; break;
          default: throw new NotificationPermanentError();
        }
      }
      if (page.nextCursor === null) {
        await store.completeEvent(event);
        result.completed++;
      } else {
        await store.checkpointAudience(event, page.nextCursor);
        result.partial++;
      }
    } catch (error) {
      const code = safeFailureCode(error);
      if (event.attempt >= limits.maxAttempts || error instanceof NotificationPermanentError) {
        await store.deadLetter(event, code);
        result.deadLettered++;
      } else {
        const delay = retryDelayMs(event.attempt, limits);
        await store.scheduleRetry(event, new Date(now.getTime() + delay), code);
        result.retried++;
      }
    }
  }
  return result;
}
