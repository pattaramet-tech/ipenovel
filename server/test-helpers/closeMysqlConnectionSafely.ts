// A robust close for a mysql2/promise connection - written after
// `pnpm test:db:prepare` was observed to print its final "Done" log and
// then never exit. The prior code was
// `await connection.promise().end().catch(() => {})`: a close failure (or
// a close that simply never settles) was silently swallowed, so a hung or
// failed close could never be diagnosed, and the process would sit alive
// forever waiting on a socket handle nothing ever reported on.
//
// This went through TWO iterations before landing on the design below:
//
// 1. Treating a resolved `end()` as complete shutdown - proven insufficient
//    by a real Gate A run: diagnostics showed "reset connection close
//    completed" logged, yet the process stayed alive for ~210s with
//    TCPSocketWrap/PipeWrap handles still active. Reading the installed
//    mysql2 3.22.5 source explained why: `PromiseConnection.end()`
//    (lib/promise/connection.js) resolves via the plain callback-style
//    `Connection.end(callback)` (lib/base/connection.js), which enqueues a
//    `Commands.Quit(callback)` (lib/commands/quit.js); `Quit.start()` calls
//    that callback IMMEDIATELY - before even writing the QUIT packet, let
//    alone before the server acknowledges it or the socket closes. `end()`
//    resolving proves only "the QUIT command was dispatched," never that
//    the transport has stopped.
// 2. Requiring the connection's public `'end'` event (re-emitted only when
//    the underlying stream's own `'end'` fires - i.e. the remote side sent
//    a FIN) IN ADDITION to `end()` resolving - proven insufficient by THREE
//    real Gate A runs against the actual TiDB-backed test database: `end()`
//    resolved, but the `'end'` event never arrived within the 5000ms
//    timeout on any of the three runs, so every run timed out and forced a
//    destroy(), and the reset phase never even started. This proves TiDB's
//    connection-closing behavior does not reliably send (or does not
//    reliably deliver, through whatever gateway/proxy layer sits in front
//    of it) the remote FIN this repo's own client-side code has any
//    control over. Requiring it as a mandatory success condition made every
//    close against TiDB report as a timeout, even though nothing was
//    actually wrong.
//
// The design below never depends on remote server behavior for success.
// Once `end()` resolves (which mysql2 always does quickly - see point 1
// above), this deterministically finalizes the LOCAL transport itself via
// mysql2's own public `destroy()` (confirmed by reading
// lib/base/connection.js: `destroy()` is an alias for `close()`, which sets
// `_closing = true` and calls `this.stream.end()` - a synchronous,
// local-only operation that never depends on any round trip to the
// server). This is the NORMAL, expected way every close completes - it is
// never reported as a forced/timeout failure. The remote `'end'` event is
// still attached (before `end()` is called, so it can never be missed) and
// remains available as a purely informational/diagnostic signal via
// `onDiagnostic`, but its absence is never treated as a failure.
//
// The bounded timeout still exists for the one thing that genuinely can
// hang against a real network: `end()` itself never settling at all. THAT
// case still forces a `destroy()` and reports it honestly as a timeout -
// "forced close"/"forcibly destroyed"/"timed out" language is reserved
// exclusively for that real failure path, never for the normal
// end()-then-destroy() sequence every ordinary close now takes.
//
// Never accesses `connection.stream`, `connection.connection`, `_closing`,
// or any other underscore-prefixed/private property. Never calls
// `process.exit()`. Never uses `process._getActiveHandles()`/
// `process._getActiveRequests()`. The internal timeout and the temporary
// `'end'` listener are both cleaned up on every path.
export interface MinimalMysqlConnection {
  end(): Promise<void>;
  /** mysql2's public destroy() - confirmed to be an alias for close() in the installed 3.22.5, i.e. a synchronous, local-only transport finalization that never depends on the server. */
  destroy(): void;
  /** Real mysql2/promise connections are EventEmitters - `'end'` is their public, documented (but here purely diagnostic, never mandatory) transport-closed signal. See the module header above. */
  once(event: "end", listener: () => void): unknown;
  removeListener(event: "end", listener: () => void): unknown;
}

export interface CloseMysqlConnectionSafelyOptions {
  /** Bounded wait for end() to settle before forcibly destroying the connection. Defaults to 5000ms. */
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
  /**
   * Optional diagnostic hook invoked with FIXED marker strings at each
   * sub-step of the close sequence - "connection end started"/"connection
   * end completed"/"local transport finalization started"/"local
   * transport finalization completed". Never invoked with error text,
   * connection details, or any raw object - callers are expected to gate
   * this behind their own diagnostics flag (see
   * server/test-helpers/testDbDiagnostics.ts's createDiagnosticLogger(),
   * which already no-ops unless IPENOVEL_TEST_DB_DIAGNOSTICS=1).
   */
  onDiagnostic?: (marker: string) => void;
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
 * 1. Attaches a one-time, diagnostic-only listener for the connection's
 *    public `'end'` event BEFORE calling `end()`, so it can never be
 *    missed if it does fire - but its firing (or not) never determines
 *    success or failure (see the module header for why: TiDB does not
 *    reliably deliver it).
 * 2. Calls `end()`, bounded by `options.timeoutMs`.
 *    - If `end()` resolves in time, the LOCAL transport is then
 *      deterministically finalized via the public `destroy()` - this is
 *      the normal, expected, successful close path.
 *    - If `end()` rejects, that failure is reported directly - `destroy()`
 *      is not additionally attempted, since the driver has already told
 *      us definitively that the close did not succeed.
 *    - If `end()` never settles at all within the timeout, `destroy()` is
 *      called as a recovery action and the timeout is reported honestly
 *      as a failure - this is the only path that ever uses
 *      "timed out"/"forcibly destroyed" language.
 * 3. If the local `destroy()` finalization itself throws (on the normal
 *    path, after `end()` already resolved), that is reported as a close
 *    failure too - never silently treated as success.
 * 4. The internal timeout and the temporary `'end'` listener are both
 *    cleaned up on every path via `finally`.
 * 5. Never calls `process.exit()`.
 */
export async function closeMysqlConnectionSafely(
  connection: MinimalMysqlConnection,
  options: CloseMysqlConnectionSafelyOptions = {}
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
  const onDiagnostic = options.onDiagnostic;

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timedOut = Symbol("closeMysqlConnectionSafely.timedOut");
  const timeoutPromise = new Promise<typeof timedOut>((resolve) => {
    // Deliberately left REFERENCED (never .unref()'d): if end() never
    // settles and nothing else keeps the event loop alive, an unref()'d
    // timer could let Node exit before this timeout ever fires - meaning
    // destroy() and the timeout error below would never run at all. This
    // timer must remain able to keep the process alive on its own until it
    // fires or clearTimeout() below removes it.
    timeoutHandle = setTimeout(() => resolve(timedOut), timeoutMs);
  });

  // Diagnostic-only - never gates success. Attached before end() is called
  // so it can never be missed if the remote side does happen to send it.
  let endEventListener: (() => void) | undefined = () => {};
  connection.once("end", endEventListener);

  let closeFailure: unknown;
  try {
    onDiagnostic?.("connection end started");
    const outcome = await Promise.race([connection.end().then(() => "ended" as const), timeoutPromise]);

    if (outcome === timedOut) {
      // end() itself never settled - the one genuine hang/failure case.
      // Force a local destroy() as recovery, but report the timeout
      // honestly; a successful recovery destroy() does not change that
      // end() itself failed to complete in time.
      try {
        connection.destroy();
        closeFailure = new Error(
          `closeMysqlConnectionSafely: connection.end() did not settle within ${timeoutMs}ms - the connection was forcibly destroyed after timing out.`
        );
      } catch (destroyError) {
        closeFailure = new Error(
          `closeMysqlConnectionSafely: connection.end() timed out after ${timeoutMs}ms AND the forced destroy() also failed: ${sanitizeCloseError(destroyError)}`
        );
      }
    } else {
      onDiagnostic?.("connection end completed");
      // Normal path: end() resolved. Deterministically finalize the local
      // transport ourselves via the public destroy()/close() API instead
      // of waiting for a remote FIN that TiDB does not reliably send. This
      // always completes synchronously (see the module header) and is the
      // expected way every close succeeds - never reported as forced/timeout.
      onDiagnostic?.("local transport finalization started");
      try {
        connection.destroy();
        onDiagnostic?.("local transport finalization completed");
      } catch (finalizeError) {
        closeFailure = new Error(
          `closeMysqlConnectionSafely: local transport finalization failed: ${sanitizeCloseError(finalizeError)}`
        );
      }
    }
  } catch (endError) {
    closeFailure = new Error(`closeMysqlConnectionSafely: connection.end() failed: ${sanitizeCloseError(endError)}`);
  } finally {
    clearTimeout(timeoutHandle);
    if (endEventListener) {
      connection.removeListener("end", endEventListener);
    }
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
