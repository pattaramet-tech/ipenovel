/**
 * P2R3B-A shared mutation pipeline: idempotency + approved rate limiting
 * wrapped around one transaction port.
 *
 * Ordering contract (per the approved P2R2R1/R2 design):
 *  1. Validate-before-decision: the incoming payload is canonicalized
 *     FIRST - an unsupported payload throws before any decision and before
 *     any quota consumption (even when no idempotency key is provided).
 *  2. Existing key: REPLAY returns the stored result WITHOUT touching the
 *     rate-limit counter (safe retries are free); CONFLICT throws.
 *  3. Approved limit only: the rate limit increment, the mutation and the
 *     idempotency record insert all happen inside ONE transaction - a
 *     failed mutation rolls the quota consumption back with it.
 *  4. The idempotency record is inserted after a successful mutation; a
 *     storage-level duplicate-key race rolls the transaction back and the
 *     integration retry path re-runs this decision (documented in
 *     idempotency.ts - NOT proven by unit tests against a real database).
 *
 * Only PD-04-approved limits may be passed in; callers must not invent
 * limits here.
 */
import { EngagementPolicyError } from "./policies";
import {
  canonicalizePayload,
  resolveIdempotency,
} from "./idempotency";
import { computeWindowStart, evaluateRateLimit } from "./rateLimit";
import type {
  EngagementEntity,
  EngagementRepository,
  EngagementTransaction,
} from "./engagementRepository";

/**
 * R1 runtime actor validation: the actor always comes from the SERVER auth
 * context (never client input), but a malformed context is a caller bug
 * that must fail closed with FORBIDDEN instead of leaking into storage.
 */
export function assertServerActor(actor: { userId: number; role: string }): void {
  if (
    !actor ||
    typeof actor.userId !== "number" ||
    !Number.isSafeInteger(actor.userId) ||
    actor.userId <= 0 ||
    !["user", "author", "admin"].includes(actor.role)
  ) {
    throw new EngagementPolicyError("FORBIDDEN");
  }
}

export class RateLimitExceededError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super(`Rate limit exceeded; retry after ${retryAfterSeconds}s`);
    this.name = "RateLimitExceededError";
  }
}

export interface MutationPipelineArgs<T> {
  repo: EngagementRepository;
  actorUserId: number;
  entity: EngagementEntity;
  clientRequestKey: string | null | undefined;
  /** The Zod-PARSED input object (canonicalized here). */
  canonicalSource: unknown;
  /** Only PD-04-approved limits; omit entirely when none is approved. */
  approvedRateLimit?: { scopeKey: string; windowMs: number; limit: number };
  /**
   * R2: authorization gate executed INSIDE the transaction BEFORE the
   * idempotency lookup - an unauthorized caller gets NOT_FOUND/FORBIDDEN
   * and never receives a stored replay result, even if a record for the
   * key exists. Because it runs in the same transaction as everything
   * else, there is no read-only-precheck gap (a precheck in a separate
   * transaction is only a fast-fail optimization, never the guarantee).
   */
  authorize?: (tx: EngagementTransaction) => Promise<void>;
  now: number;
  execute: (tx: EngagementTransaction) => Promise<T>;
}

export interface MutationPipelineResult<T> {
  result: T;
  replayed: boolean;
}

export async function runIdempotentMutation<T>(
  args: MutationPipelineArgs<T>
): Promise<MutationPipelineResult<T>> {
  const { repo, actorUserId, entity, clientRequestKey, approvedRateLimit, now, execute } = args;
  // (1) validate-before-decision: throws for unsupported payloads, before
  // any quota is consumed and before any storage access.
  const canonicalPayload = canonicalizePayload(args.canonicalSource);

  return repo.withTransaction(async (tx) => {
    // (1b) R2 same-transaction authorization BEFORE idempotency lookup
    if (args.authorize) await args.authorize(tx);

    // (2) existing key -> replay (quota untouched) or conflict
    if (clientRequestKey) {
      const stored = await tx.findIdempotencyRecord(entity, actorUserId, clientRequestKey);
      if (stored) {
        // resolveIdempotency canonicalizes internally; pass the RAW parsed
        // payload (the early canonicalizePayload above was the validation)
        const decision = resolveIdempotency({ stored, incomingPayload: args.canonicalSource });
        if (decision.decision === "replay") {
          return { result: decision.result as T, replayed: true };
        }
        throw new EngagementPolicyError("CONFLICT");
      }
    }

    // (3) approved rate limit: atomic increment inside the same transaction
    if (approvedRateLimit) {
      const windowStart = computeWindowStart(now, approvedRateLimit.windowMs);
      const newCount = await tx.incrementRateLimit(approvedRateLimit.scopeKey, windowStart);
      const decision = evaluateRateLimit({
        now,
        windowMs: approvedRateLimit.windowMs,
        limit: approvedRateLimit.limit,
        count: newCount - 1,
      });
      if (!decision.allowed) {
        // Throwing rolls the whole transaction (increment included) back:
        // a failed/blocked mutation does not consume quota permanently...
        throw new RateLimitExceededError(decision.retryAfterSeconds);
      }
    }

    // (4) the actual mutation
    const result = await execute(tx);

    if (clientRequestKey) {
      await tx.insertIdempotencyRecord(
        entity,
        actorUserId,
        clientRequestKey,
        canonicalPayload,
        result
      );
    }
    return { result, replayed: false };
  });
}
