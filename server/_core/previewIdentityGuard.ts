import mysqlPromise, { type ConnectionOptions } from "mysql2/promise";
import {
  databaseIdentityFingerprint,
  normalizeDatabaseIdentityFingerprint,
} from "../../scripts/lib/databaseIdentity.mjs";

/**
 * IPE-135-R14/R15 — Preview database identity guard (fail-closed).
 *
 * Preview PR #135 runs against a DEDICATED disposable MySQL database
 * (`ipenovel_preview_pr135` on its own MySQL) that must never be shared with
 * Production, Production-Staging, or the integration-test database.
 * `server/db.ts`'s getDb() connects to whatever DATABASE_URL says with no
 * database-name verification, and startup migrations then run against that
 * same target - so a misconfigured URL would silently migrate the wrong
 * database. This guard closes that hole FOR PREVIEW DEPLOYMENTS ONLY.
 *
 * Activation: only when DEPLOYMENT_ENVIRONMENT is exactly "preview" (a value
 * already in healthReadiness.ts's DEPLOYMENT_ENVIRONMENTS allowlist). Every
 * other environment returns before any check or connection - Production and
 * Production-Staging boots are untouched (pinned by the unit tests).
 *
 * Configuration checks - all fail closed, all before any connection:
 *   - DATABASE_URL present and a parseable MySQL URL.
 *   - Database name EXACTLY `ipenovel_preview_pr135`.
 *   - Host inside the approved topology: the preview MySQL container by its
 *     exact name, or a loopback address. Generic single-label hostnames
 *     (any other container) and every multi-label/public host are rejected.
 *   - PREVIEW_DB_FINGERPRINT: the operator-approved SHA-256 database identity
 *     (protocol//host:port/database - the same scheme
 *     assertProductionStagingDatabaseIsolation uses) must be present, valid,
 *     and equal to the identity derived from DATABASE_URL. It pins the exact
 *     host/port/database that provisioning approved; nothing about the
 *     topology is guessed from the URL's shape.
 *
 * Live checks - one short-lived mysql2/promise connection:
 *   - `SELECT DATABASE()` must be the preview database; VERSION() major >= 8.
 *   - Every phase is bounded by a timeout, a connection that resolves after
 *     its phase timed out is destroyed instead of leaking, and the connection
 *     is torn down on success, failure and timeout alike.
 *
 * Secret hygiene: messages carry only fixed text, the expected database
 * name, and identifier-like values. The connection string, username and
 * password are never included, and a driver error is reported by its
 * whitelisted error CODE only - never by its message, which can quote the
 * account or host that was rejected.
 *
 * Bypass prevention (defense in depth, IPE-135-R13):
 *   1. index.ts awaits this guard before ensureDatabaseMigrated().
 *   2. The preview database user is granted privileges ONLY on
 *      `ipenovel_preview_pr135.*`, so a migration aimed at another database
 *      fails at the SQL privilege layer.
 *   3. Provisioning allows exactly one deploy path for this app.
 */

export const PREVIEW_ENVIRONMENT = "preview";
export const PREVIEW_EXPECTED_DATABASE = "ipenovel_preview_pr135";
/** Env var holding the operator-approved SHA-256 database identity. */
export const PREVIEW_DB_FINGERPRINT_ENV = "PREVIEW_DB_FINGERPRINT";
/**
 * The ONLY non-loopback MySQL host of the approved PR #135 preview topology:
 * the preview app's own MySQL container, reachable on the app's private
 * network. The name comes from the reviewed provisioning design
 * (IPE-135-R13) and is NOT assumed to resolve - container DNS exists only
 * once the app and its MySQL share a network - so a loopback address is an
 * equally approved topology, and an unresolvable name is a fail-closed
 * connection error, never a reason to relax the check.
 */
export const PREVIEW_MYSQL_CONTAINER_HOST = "ipenovel-preview-pr135-mysql8";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/** True only for the approved container hostname or a loopback address. */
export function isApprovedPreviewMysqlHost(hostname: string): boolean {
  // The WHATWG URL parser keeps the brackets on IPv6 literals ("[::1]").
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return host === PREVIEW_MYSQL_CONTAINER_HOST || LOOPBACK_HOSTS.has(host);
}

const SAFE_IDENTIFIER = /^[A-Za-z0-9_.:+~-]{1,64}$/;

/**
 * The only kind of value allowed into an error message besides fixed text:
 * a short identifier-like token. Anything else - a URL path with unexpected
 * characters, a string the database server sent - becomes "<redacted>", so
 * no value taken from configuration or the network can carry a credential
 * into the logs.
 */
function printable(value: unknown): string {
  return typeof value === "string" && SAFE_IDENTIFIER.test(value) ? value : "<redacted>";
}

interface ParsedDatabaseUrl {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

function decode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    // Malformed percent-encoding must not escape as a URIError.
    return null;
  }
}

function parseMysqlUrl(databaseUrl: string): ParsedDatabaseUrl | null {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    return null;
  }
  if (!["mysql:", "mysql2:", "mariadb:"].includes(url.protocol.toLowerCase())) {
    return null;
  }
  const database = decode(url.pathname.replace(/^\/+/, ""));
  const user = decode(url.username);
  const password = decode(url.password);
  const port = Number(url.port || "3306");
  if (!url.hostname || !database || user === null || password === null) return null;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return {
    host: url.hostname.replace(/^\[|\]$/g, ""),
    port,
    database,
    user,
    password,
  };
}

export interface PreviewIdentityEvaluation {
  /** True only for preview deployments; false = guard is a no-op. */
  active: boolean;
  /** Sanitized failure reasons (never the connection string or credentials). */
  problems: string[];
  expectedDatabase: string;
  databaseUrl: string;
}

/**
 * Pure evaluation of the preview identity configuration. Never touches the
 * network; runPreviewIdentityGuard treats any `problems` as fatal BEFORE a
 * connection is attempted.
 */
export function evaluatePreviewIdentityConfig(
  env: Record<string, string | undefined> = process.env
): PreviewIdentityEvaluation {
  const expectedDatabase = PREVIEW_EXPECTED_DATABASE;
  const databaseUrl = env.DATABASE_URL?.trim() ?? "";
  const problems: string[] = [];

  const environment = env.DEPLOYMENT_ENVIRONMENT?.trim().toLowerCase();
  if (environment !== PREVIEW_ENVIRONMENT) {
    return { active: false, problems, expectedDatabase, databaseUrl };
  }

  const parsed = databaseUrl ? parseMysqlUrl(databaseUrl) : null;
  if (!databaseUrl) {
    problems.push("DATABASE_URL is missing for a preview deployment.");
  } else if (!parsed) {
    problems.push(
      "DATABASE_URL is not a parseable MySQL URL with a host, port and database name."
    );
  }

  if (parsed) {
    if (parsed.database !== expectedDatabase) {
      problems.push(
        `DATABASE_URL targets database "${printable(parsed.database)}" but preview deployments require "${expectedDatabase}".`
      );
    }
    if (!isApprovedPreviewMysqlHost(parsed.host)) {
      problems.push(
        "DATABASE_URL host is outside the approved preview topology (the preview MySQL container or a loopback address)."
      );
    }
  }

  const rawFingerprint = env[PREVIEW_DB_FINGERPRINT_ENV]?.trim() ?? "";
  const approvedFingerprint = normalizeDatabaseIdentityFingerprint(rawFingerprint);
  if (!rawFingerprint) {
    problems.push(`${PREVIEW_DB_FINGERPRINT_ENV} is missing for a preview deployment.`);
  } else if (!approvedFingerprint) {
    problems.push(
      `${PREVIEW_DB_FINGERPRINT_ENV} is malformed (expected a 64-character SHA-256 hex digest).`
    );
  } else if (databaseUrl) {
    let actualFingerprint = "";
    try {
      actualFingerprint = databaseIdentityFingerprint(databaseUrl);
    } catch {
      // Unprintable URL: reported below as an identity that cannot be derived.
    }
    if (!actualFingerprint) {
      problems.push("could not derive a database identity fingerprint from DATABASE_URL.");
    } else if (actualFingerprint !== approvedFingerprint) {
      problems.push("DATABASE_URL does not match the approved preview database fingerprint.");
    }
  }

  return { active: true, problems, expectedDatabase, databaseUrl };
}

export class PreviewIdentityGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreviewIdentityGuardError";
  }
}

export interface PreviewLiveConnection {
  /** mysql2/promise resolves `query()` to `[rows, fields]`. */
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
  destroy?(): void;
}

export type PreviewConnectionFactory = (
  options: ConnectionOptions
) => Promise<PreviewLiveConnection>;

/**
 * The real driver: `mysql2/promise`, whose query()/end() return promises.
 * (The callback API under "mysql2" returns nothing awaitable from query().)
 * The assignment is type-checked against the real Connection type.
 */
const createMySqlPromiseConnection: PreviewConnectionFactory = (options) =>
  mysqlPromise.createConnection(options);

const SAFE_DRIVER_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * Describes a driver error WITHOUT its message. MySQL driver messages can
 * quote the account, host or address that was rejected ("Access denied for
 * user 'x'@'y' (using password: YES)"), so only an error CODE made of plain
 * uppercase identifier characters is ever forwarded; sqlMessage, host,
 * address and config are never read.
 */
function describeDriverError(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && SAFE_DRIVER_ERROR_CODE.test(code)
    ? `driver error code ${code}`
    : "unknown driver error";
}

function timeoutError(phase: string, timeoutMs: number): PreviewIdentityGuardError {
  return new PreviewIdentityGuardError(
    `[preview-identity] ${phase} timed out after ${timeoutMs}ms.`
  );
}

/** Resolves with `promise`, or rejects with a guard timeout - whichever first. */
async function settleWithin<T>(promise: Promise<T>, timeoutMs: number, phase: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Promise.race attaches handlers to BOTH inputs, so a rejection that
    // arrives after the timeout can never surface as unhandled.
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(timeoutError(phase, timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Guarantees the socket is closed and never throws. destroy() is synchronous
 * and forceful - exactly right when the server is unresponsive, which is
 * when the guard times out; end() is only used for a connection that has no
 * destroy(). The result is swallowed on purpose: teardown must not mask the
 * verification outcome or leave a rejection behind.
 */
function disposeConnection(
  connection: PreviewLiveConnection,
  timeoutMs: number
): Promise<void> {
  return Promise.resolve()
    .then(async () => {
      if (typeof connection.destroy === "function") {
        connection.destroy();
        return;
      }
      await settleWithin(Promise.resolve(connection.end()), timeoutMs, "connection cleanup");
    })
    .catch(() => undefined);
}

function firstRow(raw: unknown): Record<string, unknown> {
  const rows = Array.isArray(raw) ? raw[0] : raw;
  const row = Array.isArray(rows) ? rows[0] : rows;
  return row && typeof row === "object" ? (row as Record<string, unknown>) : {};
}

function buildConnectionOptions(
  databaseUrl: string,
  connectTimeoutMs: number
): ConnectionOptions | null {
  const parsed = parseMysqlUrl(databaseUrl);
  if (!parsed) return null;
  return {
    host: parsed.host,
    port: parsed.port,
    user: parsed.user,
    password: parsed.password,
    database: parsed.database,
    connectTimeout: connectTimeoutMs,
  };
}

/**
 * Live identity verification over ONE short-lived connection: the server-side
 * session database must be the preview database and the server must be
 * MySQL 8 or newer. Bounded by `timeoutMs` per phase; the connection is torn
 * down whichever way verification ends.
 */
export async function verifyLivePreviewDatabaseIdentity(deps: {
  databaseUrl: string;
  expectedDatabase: string;
  createConnection: PreviewConnectionFactory;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = deps.timeoutMs ?? 10_000;
  const options = buildConnectionOptions(deps.databaseUrl, timeoutMs);
  if (!options) {
    throw new PreviewIdentityGuardError(
      "[preview-identity] DATABASE_URL is not a parseable MySQL URL with a host, port and database name."
    );
  }

  let settled = false;
  // Promise.resolve().then(...) turns a factory that throws synchronously
  // into a rejection handled like any other connection failure.
  const pending: Promise<PreviewLiveConnection> = Promise.resolve().then(() =>
    deps.createConnection(options)
  );
  const guarded = pending.then((connection) => {
    // Late resolution: this phase already timed out, so the connection
    // nobody is waiting for any more is closed right here.
    if (settled) disposeConnection(connection, timeoutMs);
    return connection;
  });

  let connection: PreviewLiveConnection;
  try {
    connection = await settleWithin(guarded, timeoutMs, "connection");
    settled = true;
  } catch (error) {
    settled = true;
    if (error instanceof PreviewIdentityGuardError) throw error;
    throw new PreviewIdentityGuardError(
      `[preview-identity] live connection failed (${describeDriverError(error)}).`
    );
  }

  try {
    const raw = await settleWithin(
      connection.query(
        "SELECT DATABASE() AS current_database, VERSION() AS server_version"
      ),
      timeoutMs,
      "identity query"
    );
    const row = firstRow(raw);
    const actualDatabase = typeof row.current_database === "string" ? row.current_database : "";
    const version = typeof row.server_version === "string" ? row.server_version : "";
    if (actualDatabase !== deps.expectedDatabase) {
      throw new PreviewIdentityGuardError(
        `[preview-identity] live session database "${printable(actualDatabase)}" does not match the expected preview database "${deps.expectedDatabase}".`
      );
    }
    const major = Number(version.split(".")[0]);
    if (!(Number.isInteger(major) && major >= 8)) {
      throw new PreviewIdentityGuardError(
        `[preview-identity] MySQL server version "${version ? printable(version) : "unknown"}" is below the required major version 8.`
      );
    }
  } catch (error) {
    if (error instanceof PreviewIdentityGuardError) throw error;
    throw new PreviewIdentityGuardError(
      `[preview-identity] live identity query failed (${describeDriverError(error)}).`
    );
  } finally {
    await disposeConnection(connection, timeoutMs);
  }
}

export interface PreviewIdentityGuardDeps {
  /** Injectable so unit tests can force connection failures/timeouts. */
  createConnection?: PreviewConnectionFactory;
  /** Budget per live phase: connect, identity query (default 10s each). */
  timeoutMs?: number;
}

/**
 * Boot-time orchestration used by server/_core/index.ts BEFORE
 * ensureDatabaseMigrated():
 *   - Non-preview environments return immediately (no behavior change).
 *   - Preview deployments run every configuration check first and throw on
 *     any problem before a connection is attempted, then verify the live
 *     identity. Either failure aborts startup before a migration runs.
 */
export async function runPreviewIdentityGuard(
  env: Record<string, string | undefined> = process.env,
  deps: PreviewIdentityGuardDeps = {}
): Promise<void> {
  const evaluation = evaluatePreviewIdentityConfig(env);
  if (!evaluation.active) return;
  if (evaluation.problems.length > 0) {
    throw new PreviewIdentityGuardError(
      `[preview-identity] preview configuration failed closed: ${evaluation.problems.join(" ")}`
    );
  }

  await verifyLivePreviewDatabaseIdentity({
    databaseUrl: evaluation.databaseUrl,
    expectedDatabase: evaluation.expectedDatabase,
    createConnection: deps.createConnection ?? createMySqlPromiseConnection,
    timeoutMs: deps.timeoutMs,
  });

  console.log(
    `[preview-identity] verified live database identity "${evaluation.expectedDatabase}" before startup migrations.`
  );
}
