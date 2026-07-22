// The single, shared way this codebase decides "was that a duplicate-key
// (unique constraint) violation?".
//
// Why this exists: every hand-written check in this repo used to test the
// TOP-LEVEL error only, e.g.
//
//   if (error?.errno === 1062 || error?.code === "ER_DUP_ENTRY") { ... }
//
// but drizzle-orm wraps every failed statement in its own error and hangs
// the real mysql2 driver error off `cause`. The observed shape from a real
// concurrent daily check-in claim is:
//
//   error.errno        === undefined
//   error.code         === undefined
//   error.cause.errno  === 1062
//   error.cause.code   === "ER_DUP_ENTRY"
//
// so those guards never fired and the duplicate-recovery branch behind them
// was dead code - a losing racer got an INTERNAL_SERVER_ERROR even though
// its rival's write had succeeded and the user's reward really was issued.
//
// Deliberate non-goals, so this never becomes a general error sniffer:
//   - Never inspects `message`. drizzle embeds the failing SQL and its bound
//     parameters there; matching on it would both leak-by-proximity and
//     false-positive on ordinary English (a validation message like "Email
//     must be unique" is NOT a driver duplicate-key error).
//   - Never inspects SQL text.
//   - Returns a plain boolean and nothing else, so no SQL, parameters,
//     credentials, connection strings, or stack traces can escape through it.

/** mysql2/MariaDB duplicate-entry error number. */
const DUPLICATE_ENTRY_ERRNO = 1062;

/** mysql2/MariaDB duplicate-entry error code. */
const DUPLICATE_ENTRY_CODE = "ER_DUP_ENTRY";

/**
 * How many `cause` links to follow before giving up. drizzle wraps the
 * driver error exactly once today; the extra headroom covers future
 * re-wrapping without ever letting a malformed/adversarial chain spin.
 */
const MAX_CAUSE_DEPTH = 8;

/**
 * True only for an errno that genuinely represents 1062 - as a number, or
 * as a purely numeric string (some driver/serialization layers stringify
 * it). Deliberately NOT parseInt-based: parseInt("1062 rows deleted") is
 * 1062, which would be a false positive.
 */
function isDuplicateEntryErrno(errno: unknown): boolean {
  if (typeof errno === "number") return errno === DUPLICATE_ENTRY_ERRNO;
  if (typeof errno === "string") return /^\s*1062\s*$/.test(errno);
  return false;
}

/**
 * Walks `error` and its nested `cause` chain and reports whether any link is
 * a MySQL/MariaDB duplicate-key violation (errno 1062 / ER_DUP_ENTRY).
 *
 * Safe for any input: `null`, `undefined`, strings, numbers, and plain
 * objects all return false rather than throwing, and a circular `cause`
 * chain terminates instead of looping (each visited object is remembered,
 * and traversal is additionally depth-capped).
 */
export function isDuplicateKeyError(error: unknown): boolean {
  const visited = new Set<object>();
  let current: unknown = error;

  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    // Anything non-object (string, number, null, undefined) carries no
    // errno/code/cause worth reading - stop rather than guess.
    if (current === null || typeof current !== "object") return false;

    // Cycle guard: `a.cause = b; b.cause = a` must terminate.
    if (visited.has(current)) return false;
    visited.add(current);

    const link = current as { errno?: unknown; code?: unknown; cause?: unknown };

    if (isDuplicateEntryErrno(link.errno)) return true;
    if (link.code === DUPLICATE_ENTRY_CODE) return true;

    current = link.cause;
  }

  return false;
}
