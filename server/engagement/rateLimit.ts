/**
 * P2R3A pure rate-limit engine (no DB, no SQL counter, no middleware).
 *
 * Approved policy (PD-04) semantics implemented here:
 *  - Fixed window: a window is identified by windowStart = floor(now /
 *    windowMs) * windowMs. Crossing the boundary starts a fresh budget.
 *  - `count` is the number of accepted attempts ALREADY consumed in the
 *    current window. An incoming attempt is allowed while count < limit.
 *  - retryAfterSeconds = seconds until the current window ends, clamped to
 *    >= 1 when blocked (a zero/negative answer would invite hot-looping).
 *
 * The atomic multi-instance counter itself lives in the future database
 * integration (INSERT ... ON DUPLICATE KEY UPDATE inside the mutation
 * transaction, per the P2R2R2 design). These pure functions neither
 * implement nor prove that transactional behavior.
 */

export interface RateLimitDecision {
  allowed: boolean;
  /** Remaining accepted attempts in the window AFTER this decision. */
  remaining: number;
  /** Only meaningful when blocked: whole seconds until the window resets. */
  retryAfterSeconds: number;
}

/** Epoch-ms validation: non-negative SAFE integer (rejects NaN/Infinity/fractional/unsafe). */
function assertEpochMs(name: string, now: number): void {
  if (typeof now !== "number" || !Number.isSafeInteger(now) || now < 0) {
    throw new Error(`${name} must be a non-negative safe integer of epoch-ms`);
  }
}

/** Window size validation: positive safe integer. */
function assertWindowMs(windowMs: number): void {
  if (typeof windowMs !== "number" || !Number.isSafeInteger(windowMs) || windowMs <= 0) {
    throw new Error("windowMs must be a positive safe integer");
  }
}

/** Fixed-window bucket start containing `now`. */
export function computeWindowStart(now: number, windowMs: number): number {
  assertEpochMs("now", now);
  assertWindowMs(windowMs);
  return Math.floor(now / windowMs) * windowMs;
}

/**
 * Decide one attempt against a window's consumed count. Pure: callers pass
 * in `now`, the window parameters and the count read from storage.
 *
 * Input validation runs on EVERY path (including allowed decisions where
 * the window math is never reached): an invalid clock or window size is a
 * caller/configuration bug and must fail closed even when quota remains.
 */
export function evaluateRateLimit(input: {
  now: number;
  windowMs: number;
  limit: number;
  count: number;
}): RateLimitDecision {
  const { now, windowMs, limit, count } = input;
  assertEpochMs("now", now);
  assertWindowMs(windowMs);
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error("limit must be a positive safe integer");
  }
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
    throw new Error("count must be a non-negative safe integer");
  }

  if (count < limit) {
    return { allowed: true, remaining: limit - count - 1, retryAfterSeconds: 0 };
  }

  const windowStart = computeWindowStart(now, windowMs);
  const windowEnd = windowStart + windowMs;
  const remainingMs = windowEnd - now;
  // Clamp to at least 1s so a boundary-edge block never yields 0 (which
  // would invite immediate hot retries).
  const retryAfterSeconds = Math.max(1, Math.ceil(remainingMs / 1000));
  return { allowed: false, remaining: 0, retryAfterSeconds };
}
