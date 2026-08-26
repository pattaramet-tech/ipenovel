/**
 * The SINGLE definition of a slip's effective freshness allowance.
 *
 * Lives in shared/ (imported by both server verification and the admin
 * presentation model) specifically so the two cannot drift. They previously
 * did: the server grants a date-only OCR result at least 1440 minutes, while
 * the panel compared every result against the configured window, so a
 * date-only transfer submitted later the same day passed server verification
 * but was rendered as a FAILED freshness check.
 *
 * Rule:
 *   - A result with a real transaction TIME is held to the configured window.
 *   - A DATE-ONLY result has no time of day, so "how long ago" is only known
 *     to within a day. Holding it to a 120-minute window would fail almost
 *     every legitimate same-day slip, so it is granted at least a full day.
 *   - A configured window LARGER than a day always wins - the floor raises a
 *     too-small window, it never caps a deliberately generous one.
 */

/** Floor applied when only a calendar date could be read. */
export const DATE_ONLY_MINIMUM_WINDOW_MINUTES = 24 * 60;

/** Lower bound on any configured window, mirroring the server's clamp. */
export const MIN_CONFIGURED_WINDOW_MINUTES = 5;

/** Default used when configuration is unavailable, mirroring the server. */
export const DEFAULT_WINDOW_MINUTES = 120;

/**
 * Normalizes a configured window exactly as the server does before use:
 * a non-finite value falls back to the default, and anything below the floor
 * is raised to it.
 */
export function normalizeConfiguredWindowMinutes(
  configuredMinutes: number | null | undefined
): number {
  if (typeof configuredMinutes !== "number" || !Number.isFinite(configuredMinutes)) {
    return DEFAULT_WINDOW_MINUTES;
  }
  return Math.max(MIN_CONFIGURED_WINDOW_MINUTES, configuredMinutes);
}

/**
 * The allowance actually applied to THIS result.
 *
 * `hasTransactionTime` must be true only when a real time of day was read
 * (transactionDateTime), not merely a date.
 */
export function effectiveFreshnessWindowMinutes(
  configuredMinutes: number | null | undefined,
  hasTransactionTime: boolean
): number {
  const configured = normalizeConfiguredWindowMinutes(configuredMinutes);
  return hasTransactionTime
    ? configured
    : Math.max(configured, DATE_ONLY_MINIMUM_WINDOW_MINUTES);
}

/**
 * Whether a transaction is inside its allowance.
 *
 * `differenceMinutes` is (submittedAt - transactionAt); a small negative
 * value is tolerated as clock skew, matching the server's 5-minute allowance.
 */
export const CLOCK_SKEW_TOLERANCE_MINUTES = 5;

export function isWithinFreshnessWindow(
  differenceMinutes: number,
  allowanceMinutes: number
): boolean {
  return (
    differenceMinutes >= -CLOCK_SKEW_TOLERANCE_MINUTES &&
    differenceMinutes <= allowanceMinutes
  );
}
