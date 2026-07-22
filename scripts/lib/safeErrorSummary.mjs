// The single error-sanitization implementation shared by the production
// migration runner (scripts/migrate.mjs) and the server's global tRPC
// error formatter (server/_core/trpc.ts). Written as plain ESM JavaScript
// so `node scripts/migrate.mjs` can import it directly with no build step,
// while TypeScript consumers get types from safeErrorSummary.d.mts.
//
// Why this exists: drizzle-orm wraps every failed statement in an error
// whose `message` embeds the full SQL and bound parameters, e.g.
//
//   Failed query: select `id` from `dailyCheckins` where `userId` = ?
//   params: 2160001,1
//
// Logging that verbatim leaks schema shape and real user data into logs
// (and, before the tRPC formatter existed, into the browser). The useful
// diagnostic - the driver's own code/errno/sqlState and its short message
// ("Table '...' doesn't exist") - lives on the wrapped `cause`, so this
// module walks the cause chain and keeps only those fields.
//
// Over-redaction is the intended failure mode: a false positive merely
// blanks something harmless, a false negative leaks a secret.

const MAX_CAUSE_DEPTH = 5;
const MAX_MESSAGE_LENGTH = 200;

/** Anything that looks like the start of a real SQL statement - everything from here on is dropped. */
const SQL_STATEMENT_START =
  /\b(select|insert\s+into|update\s+\S|delete\s+from|create\s+(table|index|unique)|alter\s+table|drop\s+(table|index)|truncate)\b/i;

const SENSITIVE_PATTERNS = [
  // Full connection strings / URLs, with or without embedded credentials.
  { pattern: /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s'"]+/g, replacement: "[redacted-connection-string]" },
  // MySQL-style quoted user/host pairs, e.g. 'root'@'10.0.0.5'.
  { pattern: /'[^'\s]+'@'[^'\s]+'/g, replacement: "[redacted-user-host]" },
  // Bare user@host / email-shaped fragments.
  { pattern: /\b[\w.+-]+@[\w.-]+\b/g, replacement: "[redacted-user-host]" },
  // IPv4 addresses (optionally with a port).
  { pattern: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(:\d+)?\b/g, replacement: "[redacted-ip]" },
  // Domain-like hostnames (two or more dot-separated labels).
  { pattern: /\b(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}\b/g, replacement: "[redacted-host]" },
  // key=value / key: value credential-shaped fragments.
  { pattern: /\b(password|pwd|passwd|token|apikey|api[_-]?key|secret)\s*[=:]\s*\S+/gi, replacement: "[redacted-credential]" },
];

/** Redacts connection strings, credentials, hosts and IPs from free text. */
export function redactSensitiveText(text) {
  let result = String(text);
  for (const { pattern, replacement } of SENSITIVE_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

/**
 * Reduces one error message to a short, safe fragment, or null if nothing
 * safe survives. Drops - in order - bound parameters, drizzle's "Failed
 * query" preamble, any residual SQL statement, then redacts credentials.
 */
export function sanitizeErrorMessage(raw) {
  if (typeof raw !== "string" || raw.length === 0) return null;
  let text = raw;

  // 1. Bound parameter values: never log anything from "params:" onward.
  const paramsIndex = text.search(/\bparams\s*:/i);
  if (paramsIndex !== -1) text = text.slice(0, paramsIndex);

  // 2. drizzle's "Failed query: <sql>" preamble - drop it and all that follows.
  const failedQueryIndex = text.search(/failed\s+query/i);
  if (failedQueryIndex !== -1) text = text.slice(0, failedQueryIndex);

  // 3. Any other embedded SQL statement text.
  const sqlIndex = text.search(SQL_STATEMENT_START);
  if (sqlIndex !== -1) text = text.slice(0, sqlIndex);

  text = redactSensitiveText(text).replace(/\s+/g, " ").trim();
  // Strip a dangling separator left behind by the cuts above ("Error: ").
  text = text.replace(/[:\-\s]+$/, "").trim();

  if (!text) return null;
  return text.slice(0, MAX_MESSAGE_LENGTH);
}

/** Walks `error.cause` up to MAX_CAUSE_DEPTH, cycle-safe, returning the chain in order. */
function collectCauseChain(error) {
  const chain = [];
  const seen = new Set();
  let current = error;
  let depth = 0;
  while (current && depth < MAX_CAUSE_DEPTH) {
    if (typeof current === "object") {
      if (seen.has(current)) break;
      seen.add(current);
    }
    chain.push(current);
    current = typeof current === "object" ? current.cause : undefined;
    depth += 1;
  }
  return chain;
}

/**
 * A short, log-safe one-line summary of an error.
 *
 * Keeps only the driver diagnostic fields that make an incident
 * actionable - code, errno, sqlState - plus the first message in the cause
 * chain that survives sanitization (typically the underlying database
 * error such as "Table '...' doesn't exist", never drizzle's SQL-bearing
 * wrapper). Preserves recognisable failures like ER_NO_SUCH_TABLE,
 * ER_BAD_FIELD_ERROR, access-denied, ECONNREFUSED and timeouts without
 * ever emitting SQL text, bound parameters or credentials.
 */
export function safeErrorSummary(error) {
  if (error === null || error === undefined) return "unknown error";

  const chain = collectCauseChain(error);
  const parts = [];

  const firstDefined = (key) => {
    for (const link of chain) {
      if (link && typeof link === "object" && link[key] !== undefined && link[key] !== null && link[key] !== "") {
        return link[key];
      }
    }
    return undefined;
  };

  // Prefer the fields of a genuine driver error (identified by errno or
  // sqlState) over an outer wrapper's own code. A TRPCError, for example,
  // carries code="INTERNAL_SERVER_ERROR", which would otherwise mask the
  // far more useful ER_NO_SUCH_TABLE on its cause.
  const driverLink = chain.find(
    (link) => link && typeof link === "object" && (link.errno !== undefined || link.sqlState !== undefined)
  );
  const preferred = (key) => (driverLink && driverLink[key] !== undefined ? driverLink[key] : firstDefined(key));

  const code = preferred("code");
  const errno = preferred("errno");
  const sqlState = preferred("sqlState");
  if (code !== undefined) parts.push(`code=${redactSensitiveText(String(code)).slice(0, 100)}`);
  if (errno !== undefined) parts.push(`errno=${String(errno).slice(0, 20)}`);
  if (sqlState !== undefined) parts.push(`sqlState=${String(sqlState).slice(0, 20)}`);

  // First message in the chain that still says something safe. Drizzle's
  // wrapper sanitizes away to nothing, so this naturally lands on the
  // underlying driver error.
  let message = null;
  for (const link of chain) {
    const raw = link && typeof link === "object" ? link.message : String(link);
    message = sanitizeErrorMessage(raw);
    if (message) break;
  }
  if (message) parts.push(`message=${message}`);

  return parts.length > 0 ? parts.join(" ") : "unknown error";
}
