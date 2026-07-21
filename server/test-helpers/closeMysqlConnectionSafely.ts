// A robust close for a mysql2/promise connection - written after
// `pnpm test:db:prepare` was observed to print its final "Done" log and
// then never exit. The prior code was
// `await connection.promise().end().catch(() => {})`: a close failure (or
// a close that simply never settles) was silently swallowed, so a hung or
// failed close could never be diagnosed, and the process would sit alive
// forever waiting on a socket handle nothing ever reported on.
//
// A first fix (treating a resolved `end()` as complete shutdown) was later
// proven insufficient by a real Gate A run: diagnostics showed
// "reset connection close completed" logged, yet the process still stayed
// alive for ~210s with TCPSocketWrap/PipeWrap handles still active. Reading
// the installed mysql2 3.22.5 source directly explains why:
//
// - `mysql2/promise`'s `PromiseConnection.end()` (lib/promise/connection.js)
//   is `new this.Promise((resolve) => { this.connection.end(resolve); })` -
//   it resolves via the plain callback-style `Connection.end(callback)`
//   (lib/base/connection.js). For a normal (non-server) connection, that
//   method enqueues a `Commands.Quit(callback)` command
//   (lib/commands/quit.js); `Quit.start()` calls `this.onResult()` (the
//   `end()` callback) IMMEDIATELY - before even calling
//   `connection.writePacket(quit)` to send the QUIT packet, let alone
//   before the server acknowledges it or the underlying socket actually
//   closes. So `end()` resolving proves only "the QUIT command was
//   dispatched from the internal command queue," never that the transport
//   has stopped.
// - The connection's actual transport-close signal is its public `'end'`
//   event: `BaseConnection`'s constructor does
//   `this.stream.on('end', () => { this.emit('end'); })` - i.e. the
//   connection re-emits its own `'end'` only when the underlying **socket
//   stream's own `'end'` event fires** (the remote side sent a FIN / the
//   socket's readable side has actually ended). `PromiseConnection` forwards
//   this event too, lazily, via `inheritEvents(connection, this, ['error',
//   'drain', 'connect', 'end', 'enqueue'])` (lib/promise/inherit_events.js) -
//   `connection.once('end', ...)` on a `mysql2/promise` connection is a
//   real, public, documented part of its EventEmitter surface (Connection
//   extends EventEmitter), not a private/internal API.
// - The base connection's public `destroy()` (proxied onto
//   `PromiseConnection` from `BaseConnection.prototype.destroy`) is just an
//   alias for `close()`, which does `this._closing = true; this.stream.end()`
//   - a graceful half-close of the writable side, not a raw socket kill.
//   It is still the correct, sanctioned "force" mechanism because it is the
//   only public API mysql2 offers for this - reaching into
//   `connection.stream` (or any other underscore-prefixed/private property)
//   directly would not be a legitimate fix.
//
// This module therefore requires BOTH signals before treating a close as
// genuinely complete: `end()` resolving AND the connection's own `'end'`
// event firing. Either one alone is insufficient - `end()` fires too early
// (proven above) to mean anything about the transport, and relying on the
// event alone would ignore a real `end()` rejection. The `'end'` listener
// is attached BEFORE `end()` is ever called, so the event can never be
// missed by a race between attaching the listener and it firing.
//
// This never silently succeeds after a failed close: a rejected `end()`, a
// terminal `'end'` event that never arrives (leading to a forced
// `destroy()`), or a `destroy()` that itself fails are all surfaced as a
// thrown, sanitized error - never a raw driver error object, never
// connection details (no host/user/password/URL). Never calls
// process.exit() - closing a connection is not this module's business to
// decide the process's fate. The internal bookkeeping timer is cleared on
// every path, and the temporary `'end'` listener is removed on every path
// too, so neither can itself be the reason the process stays alive or the
// connection object is left with a stale listener.
export interface MinimalMysqlConnection {
  end(): Promise<void>;
  destroy(): void;
  /** Real mysql2/promise connections are EventEmitters - `'end'` is their public, documented transport-closed signal (see the module header above). */
  once(event: "end", listener: () => void): unknown;
  removeListener(event: "end", listener: () => void): unknown;
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
 * 1. Attaches a one-time listener for the connection's public `'end'`
 *    event BEFORE calling `end()`, so the event can never be missed by a
 *    race between subscribing and it firing.
 * 2. Calls `end()`. Genuine success requires BOTH `end()` to resolve AND
 *    the `'end'` event to fire - in either order - within
 *    `options.timeoutMs`. Neither one alone is a reliable "the transport
 *    actually closed" signal (see the module header for why).
 * 3. If `end()` rejects, that failure is reported directly - `destroy()`
 *    is not additionally attempted, since the driver has already told us
 *    definitively that the close did not succeed.
 * 4. If the timeout elapses before both signals have arrived (`end()`
 *    hung, the `'end'` event never fired, or both), `destroy()` is called
 *    to forcibly release the connection, and a "forced close was
 *    required" error is reported - unless `destroy()` itself also fails,
 *    in which case that failure is reported instead. Forced destroy is
 *    NEVER reported as success.
 * 5. The internal timeout and the temporary `'end'` listener are both
 *    cleaned up on every path via `finally`.
 * 6. Never calls `process.exit()`.
 */
export async function closeMysqlConnectionSafely(
  connection: MinimalMysqlConnection,
  options: CloseMysqlConnectionSafelyOptions = {}
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timedOut = Symbol("closeMysqlConnectionSafely.timedOut");
  const timeoutPromise = new Promise<typeof timedOut>((resolve) => {
    // Deliberately left REFERENCED (never .unref()'d): if the close never
    // settles and nothing else keeps the event loop alive, an unref()'d
    // timer could let Node exit before this timeout ever fires - meaning
    // destroy() and the forced-close error below would never run at all.
    // This timer must remain able to keep the process alive on its own
    // until it fires or clearTimeout() below removes it - there is no
    // other path to a hung close ever being detected.
    timeoutHandle = setTimeout(() => resolve(timedOut), timeoutMs);
  });

  // Attached BEFORE end() is called (below) - required so the event can
  // never fire in the window before we start listening for it.
  let endEventListener: (() => void) | undefined;
  const endEventPromise = new Promise<"end-event">((resolve) => {
    endEventListener = () => resolve("end-event");
    connection.once("end", endEventListener);
  });

  let closeFailure: unknown;
  try {
    const gracefulComplete = Promise.all([
      connection.end().then(() => "ended" as const),
      endEventPromise,
    ]).then(() => "graceful-complete" as const);

    const outcome = await Promise.race([gracefulComplete, timeoutPromise]);

    if (outcome === timedOut) {
      try {
        connection.destroy();
        closeFailure = new Error(
          `closeMysqlConnectionSafely: graceful close did not complete within ${timeoutMs}ms (end() and/or the connection's terminal "end" event never both completed) - the connection was forcibly destroyed.`
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
