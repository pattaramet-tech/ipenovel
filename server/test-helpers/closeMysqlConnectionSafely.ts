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
 * Redaction passes applied to any free-text this module reports (an
 * error's `.message`, or a non-Error thrown value's `String()`/`toString()`
 * result) - a driver close/end/destroy failure is the only kind of text
 * this module ever processes, but that text is not trustworthy: some
 * drivers embed the connection string, host, or credentials directly
 * inside a plain error message (e.g. "getaddrinfo ENOTFOUND db.internal",
 * "Access denied for user 'root'@'10.0.0.5'", or a connection URI verbatim
 * in a network error). Each pattern below targets one category; order
 * matters only in that the full-URL pattern runs first so it can redact an
 * entire connection string in one match rather than leaving fragments for
 * the later, narrower patterns to also (harmlessly, redundantly) match.
 * Deliberately broad: a false positive here just redacts something
 * harmless (e.g. a version string that happens to look like a hostname); a
 * false negative could leak a real secret, so over-redaction is the
 * correct failure mode for this function.
 */
const SENSITIVE_TEXT_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // Full connection strings / URLs, with or without embedded credentials,
  // e.g. "mysql://user:pass@host:3306/db" or "https://host/path".
  { pattern: /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s'"]+/g, replacement: "[redacted-connection-string]" },
  // MySQL-style quoted user/host pairs, e.g. "'root'@'10.0.0.5'".
  { pattern: /'[^'\s]+'@'[^'\s]+'/g, replacement: "[redacted-user-host]" },
  // Bare user@host / email-shaped fragments.
  { pattern: /\b[\w.+-]+@[\w.-]+\b/g, replacement: "[redacted-user-host]" },
  // IPv4 addresses.
  { pattern: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, replacement: "[redacted-ip]" },
  // Domain-like hostnames (two or more dot-separated labels, final label
  // alphabetic) - e.g. "db.internal", "prod-cluster.example.com".
  { pattern: /\b(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}\b/g, replacement: "[redacted-host]" },
  // key=value / key: value credential-shaped fragments.
  { pattern: /\b(password|pwd|passwd|token|apikey|api[_-]?key|secret)\s*[=:]\s*\S+/gi, replacement: "[redacted-credential]" },
];

function redactSensitiveText(text: string): string {
  let result = text;
  for (const { pattern, replacement } of SENSITIVE_TEXT_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

/**
 * Same shape as this repo's other sanitized error summaries (see
 * sanitizeMigrationError in migrateTestDbWithLogging.ts): only the small
 * set of fields a driver error commonly carries for diagnosing a close
 * failure (code/errno/message), never the full raw error object - which
 * could carry connection config (host/user/password) as extra fields on
 * some driver error shapes (those extra fields are never read here at
 * all). `code`/`errno` are short, fixed driver-defined identifiers (e.g.
 * "ECONNRESET", 1045) and are passed through as-is; `message` - and the
 * fallback for a non-Error thrown value, which is never an unrestricted
 * `String(error)` - are both redacted via redactSensitiveText() before
 * being capped and included, since a message string is free text that can
 * legitimately contain a URL, host, IP, username, or credential fragment.
 */
function sanitizeCloseError(error: unknown): string {
  if (!error) return "unknown error";
  const err: any = error;
  const parts: string[] = [];
  if (err.code) parts.push(`code=${String(err.code).slice(0, 100)}`);
  if (err.errno !== undefined && err.errno !== null) parts.push(`errno=${String(err.errno).slice(0, 20)}`);
  if (err.message) parts.push(`message=${redactSensitiveText(String(err.message)).slice(0, 300)}`);
  if (parts.length > 0) return parts.join(" ");
  // No recognizable error shape (e.g. a thrown non-Error value) - still
  // redact and cap rather than echoing an unrestricted String(error),
  // which could reveal anything a custom toString() implementation chooses
  // to return.
  return redactSensitiveText(String(error)).slice(0, 300);
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
    // Deliberately left REFERENCED (never .unref()'d): if end() never
    // settles and nothing else keeps the event loop alive, an unref()'d
    // timer could let Node exit before this timeout ever fires - meaning
    // destroy() and the forced-close error below would never run at all.
    // This timer must remain able to keep the process alive on its own
    // until it fires or clearTimeout() below removes it - there is no
    // other path to a hung end() ever being detected.
    timeoutHandle = setTimeout(() => resolve(timedOut), timeoutMs);
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
