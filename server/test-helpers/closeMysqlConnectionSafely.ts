// A robust close for a mysql2/promise connection - written after
// `pnpm test:db:prepare` was observed to print its final "Done" log and
// then never exit. The prior code was
// `await connection.promise().end().catch(() => {})`: a close failure (or
// a close that simply never settles) was silently swallowed, so a hung or
// failed close could never be diagnosed, and the process would sit alive
// forever waiting on a socket handle nothing ever reported on.
//
// This never silently succeeds after a failed close: a rejected `end()`, a
// forced `destroy()` (used when `end()` never settles within the bounded
// timeout), or a `destroy()` that itself fails are all surfaced as a
// thrown, sanitized error - never a raw driver error object, never
// connection details (no host/user/password/URL). Never calls
// process.exit() - closing a connection is not this module's business to
// decide the process's fate. The internal bookkeeping timer is cleared on
// every path (success, end() rejection, and timeout), so it can never
// itself be the reason the process stays alive.
export interface MinimalMysqlConnection {
  end(): Promise<void>;
  destroy(): void;
}

export interface CloseMysqlConnectionSafelyOptions {
  /** Bounded wait for a graceful end() before forcibly destroying the connection. Defaults to 5000ms. */
  timeoutMs?: number;
  /**
   * An already-known failure from the operation this connection was
   * performing, if the caller is closing the connection from a `finally`
   * block after that operation itself failed. If the close ALSO fails,
   * both are preserved together in a thrown AggregateError - a close
   * failure must never silently replace/hide the error that caused
   * cleanup to run in the first place.
   */
  primaryError?: unknown;
}

const DEFAULT_CLOSE_TIMEOUT_MS = 5000;

/**
 * Same shape as this repo's other sanitized error summaries (see
 * sanitizeMigrationError in migrateTestDbWithLogging.ts): only the small
 * set of fields a driver error commonly carries for diagnosing a close
 * failure (code/errno/message, message capped), never the full raw error
 * object - which could carry connection config (host/user/password) as
 * extra fields on some driver error shapes.
 */
function sanitizeCloseError(error: unknown): string {
  if (!error) return "unknown error";
  const err: any = error;
  const parts: string[] = [];
  if (err.code) parts.push(`code=${err.code}`);
  if (err.errno) parts.push(`errno=${err.errno}`);
  if (err.message) parts.push(`message=${String(err.message).slice(0, 300)}`);
  if (parts.length > 0) return parts.join(" ");
  return String(error).slice(0, 300);
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * Closes `connection` safely:
 * 1. Attempts a graceful `end()`, bounded by `options.timeoutMs`.
 * 2. If `end()` rejects (settles with an error), that failure is reported
 *    directly - `destroy()` is not additionally attempted, since the
 *    driver has already told us definitively that the close did not
 *    succeed.
 * 3. If `end()` never settles at all within the timeout, `destroy()` is
 *    called to forcibly release the underlying socket, and a "forced
 *    close was required" error is reported - unless `destroy()` itself
 *    also fails, in which case that failure is reported instead.
 * 4. The internal timeout is cleared in every path via `finally`.
 * 5. Never calls `process.exit()`.
 */
export async function closeMysqlConnectionSafely(
  connection: MinimalMysqlConnection,
  options: CloseMysqlConnectionSafelyOptions = {}
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timedOut = Symbol("closeMysqlConnectionSafely.timedOut");
  const timeoutPromise = new Promise<typeof timedOut>((resolve) => {
    timeoutHandle = setTimeout(() => resolve(timedOut), timeoutMs);
    // Defensive only: clearTimeout() below already guarantees this timer
    // never outlives this function, on every path - unref() just ensures
    // this bookkeeping timer alone could never be the thing keeping the
    // event loop alive if something upstream ever changes.
    timeoutHandle.unref?.();
  });

  let closeFailure: unknown;
  try {
    const outcome = await Promise.race([connection.end().then(() => "ended" as const), timeoutPromise]);

    if (outcome === timedOut) {
      try {
        connection.destroy();
        closeFailure = new Error(
          `closeMysqlConnectionSafely: graceful close did not complete within ${timeoutMs}ms - the connection was forcibly destroyed.`
        );
      } catch (destroyError) {
        closeFailure = new Error(
          `closeMysqlConnectionSafely: graceful close timed out after ${timeoutMs}ms AND the forced destroy() also failed: ${sanitizeCloseError(destroyError)}`
        );
      }
    }
  } catch (endError) {
    closeFailure = new Error(`closeMysqlConnectionSafely: connection.end() failed: ${sanitizeCloseError(endError)}`);
  } finally {
    clearTimeout(timeoutHandle);
  }

  if (closeFailure) {
    if (options.primaryError !== undefined) {
      throw new AggregateError(
        [toError(options.primaryError), toError(closeFailure)],
        "closeMysqlConnectionSafely: both the primary operation and the connection close failed."
      );
    }
    throw closeFailure;
  }
}
