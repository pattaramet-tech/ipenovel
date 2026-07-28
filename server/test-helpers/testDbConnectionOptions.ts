// One shared, test-only factory for building mysql2 connection options from
// TEST_DATABASE_URL. Every direct MySQL connection this repo's test
// infrastructure opens must go through this - never construct connection
// options ad hoc, and never pass the raw URL string straight to
// mysql2/drizzle.
//
// Why this exists: drizzle-orm/mysql2's driver parses a URL string itself
// via mysql2's own URL handling and does not set any TLS options by
// default. A real Manus integration run against a TiDB Cloud Starter
// cluster failed with "Connections using insecure transport are
// prohibited" - TiDB Cloud requires TLS and refuses a plaintext connection
// outright, and neither server/test-helpers/testDb.ts's `drizzle(url!)` nor
// scripts/migrate-test-db.ts's `mysql.createConnection(testUrl!)` ever
// requested TLS. This factory is the single place that decides how a test
// connection is made; direct `drizzle(url)` / `mysql.createConnection(url)`
// / `mysql.createPool(url)` calls in test infrastructure are the bug class
// this exists to eliminate.
//
// Deliberately does NOT read process.env itself and does NOT fall back to
// DATABASE_URL - the caller is always responsible for passing
// TEST_DATABASE_URL explicitly, so this function can never silently connect
// to the wrong database. Never logs the URL, username, or password.
import net from "node:net";
import type { ConnectionOptions } from "mysql2";
import { assertSafeTestDatabaseUrl, isAllowedTestDatabaseName } from "./testDatabaseGuard";

export interface TestDbConnectionOptions extends ConnectionOptions {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl?: {
    minVersion: "TLSv1.2";
    rejectUnauthorized: true;
  };
}

/**
 * Integration-test-only loopback exception, NOT an application runtime
 * policy: server/db.ts's production getDb() is untouched by this file and
 * never reads this logic. This exists solely so a genuinely local,
 * developer-machine disposable database (e.g. a throwaway MariaDB instance
 * bound to 127.0.0.1, started and torn down for a single test session) can
 * be used without provisioning a publicly-CA-signed TLS certificate for
 * "localhost" - which is not obtainable - while every other connection
 * (anything not on this machine, including every real CI/Manus/TiDB Cloud
 * run) keeps the exact TLS 1.2 + rejectUnauthorized:true requirement above
 * with zero change.
 *
 * Exact-string allowlist against the WHATWG-parsed `.hostname` only (never
 * the raw input string) - this is deliberately NOT a DNS resolution or a
 * prefix/suffix/substring check:
 *   - `127.0.0.1.example.com` / `localhost.example.com` (lookalike
 *     subdomains) are a different, non-equal string and correctly fall
 *     through to "TLS required".
 *   - Percent-encoded hosts (e.g. the literal characters
 *     "%6c%6f%63%61%6c%68%6f%73%74") are never decoded by the URL spec's
 *     host parser the way path/query components are - `.hostname` returns
 *     the encoded literal unchanged, which also does not equal "localhost"
 *     and correctly falls through to "TLS required".
 *   - Alternate IPv4 notations some resolvers accept (octal "0177.0.0.1",
 *     decimal "2130706433") are likewise left as opaque, non-matching
 *     strings by the URL parser - never renormalized to "127.0.0.1" here.
 *   - Case is folded before comparison ("LOCALHOST" matches) since
 *     hostnames are conventionally case-insensitive, but this can only ever
 *     make the allowlist match its own three literals - it cannot make an
 *     unrelated string match them.
 * IPv6 loopback is normalized by stripping a single pair of enclosing
 * brackets first, since `new URL(...).hostname` for `[::1]` is the bracketed
 * string `"[::1]"`, not `"::1"`.
 *
 * Fails closed on any parse error (returns false, i.e. "not loopback" / "TLS
 * required") rather than throwing or defaulting to true.
 */
const LOOPBACK_TEST_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function isLoopbackTestHost(hostname: string | undefined | null): boolean {
  if (!hostname) return false;
  try {
    const stripped = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
    return LOOPBACK_TEST_HOSTS.has(stripped.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Explicit, opt-in test-only transport mode for a Coolify/Docker-internal
 * MariaDB service (see isDockerInternalSingleLabelHost below) whose
 * self-signed certificate would otherwise fail `rejectUnauthorized: true`.
 * The ONLY value with special meaning is the exact literal
 * "internal_plaintext" - anything else (undefined, "", a typo) is the
 * default, TLS-required behavior. This is a distinct path from the
 * loopback exception above: it exists for a same-network-but-not-the-
 * literal-same-machine internal hostname, never for localhost/127.0.0.1/::1
 * (which already have their own, separate exception).
 *
 * Callers must read process.env.TEST_DATABASE_TRANSPORT themselves and
 * pass the result to buildTestDbConnectionOptions explicitly - this module
 * deliberately never reads process.env on its own (see the file header).
 */
export type TestDbTransportMode = "internal_plaintext" | undefined;

/**
 * Narrows a raw environment-variable string into a TestDbTransportMode by
 * exact match. Exists so every caller parses
 * process.env.TEST_DATABASE_TRANSPORT the same way once, rather than each
 * re-implementing the same comparison - and so an unrecognized value can
 * never accidentally enable a security-relevant behavior change.
 */
export function parseTestDbTransportMode(raw: string | undefined | null): TestDbTransportMode {
  return raw === "internal_plaintext" ? "internal_plaintext" : undefined;
}

/**
 * True only for a hostname that looks unmistakably like a Docker/Coolify
 * internal service DNS name - e.g. "x2wf26a5hdp9hivvnqk1g9am" - and none of:
 *   - a dotted domain (a real external/public hostname, or a lookalike such
 *     as "localhost.example.com"),
 *   - an IPv4 or IPv6 address, bracketed or not (checked with Node's own
 *     `net.isIP`, not a hand-rolled regex),
 *   - a loopback/localhost identifier (127.0.0.1 / localhost / ::1, case-
 *     insensitive) - that already has its own, separate exception above
 *     (isLoopbackTestHost) and deliberately does not overlap with this one.
 *
 * This is only the HOSTNAME half of the internal_plaintext eligibility
 * check - see buildTestDbConnectionOptions for the full gate (exact
 * database name, port 3306, and an explicit transport-mode opt-in are all
 * required too). Fails closed (returns false) on empty input, never
 * throws.
 *
 * Deliberately scoped to exactly what this task specifies: alternate IPv4
 * notations (octal/decimal, e.g. "2130706433") are out of scope here, same
 * as they are for isLoopbackTestHost above.
 */
export function isDockerInternalSingleLabelHost(hostname: string | undefined | null): boolean {
  if (!hostname) return false;
  if (isLoopbackTestHost(hostname)) return false;
  const stripped = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (stripped.length === 0) return false;
  if (stripped.includes(".")) return false; // dotted domain, or a dotted-quad IPv4 address
  if (net.isIP(stripped) !== 0) return false; // any other IPv4/IPv6 literal form
  return true;
}

/**
 * Throws when TEST_DATABASE_TRANSPORT=internal_plaintext was requested but
 * this connection does not qualify for it - fails closed to the
 * TLS-required default rather than guessing. Only ever called when the
 * pre-existing loopback exception does NOT already independently permit
 * skipping TLS (see buildTestDbConnectionOptions), so a loopback host is
 * never spuriously rejected just because it also fails the "Docker
 * internal hostname" shape check.
 */
function assertInternalPlaintextEligible(database: string, hostname: string, port: number): true {
  const isExactTestDatabaseName = isAllowedTestDatabaseName(database);
  const isInternalHost = isDockerInternalSingleLabelHost(hostname);
  const isDefaultMysqlPort = port === 3306;

  if (isExactTestDatabaseName && isInternalHost && isDefaultMysqlPort) {
    return true;
  }

  throw new Error(
    "[testDbConnectionOptions] TEST_DATABASE_TRANSPORT=internal_plaintext was requested, but this connection does " +
      'not qualify for it: it requires the database name to be exactly "ipenovel_test", the hostname to be a ' +
      "Docker/Coolify-internal single-label name (no dots, not an IP address, not localhost/127.0.0.1/::1), and " +
      "the port to be 3306. Refusing to skip TLS."
  );
}

/**
 * Builds mysql2 connection options with TLS required (TLSv1.2 minimum,
 * certificate verification never disabled) from an explicit TEST_DATABASE_URL
 * value.
 *
 * Runs the connection-string safety gate (assertSafeTestDatabaseUrl) before
 * building anything - it is not possible to obtain connection options for a
 * URL whose database name isn't exactly "ipenovel_test", and a missing or
 * malformed URL throws immediately (fails closed). This is the FIRST of the
 * two required safety gates; the SECOND (a live "SELECT DATABASE()" query
 * against the actual connection - see liveTestDatabaseCheck.ts) happens
 * after connecting and remains every caller's own responsibility - this
 * function only decides how to connect, it never proves what was actually
 * connected to.
 *
 * Deliberately does not set a `ca` option: TiDB Cloud Starter's default
 * certificate is issued by a publicly trusted CA, which Node's built-in
 * trust store (and therefore rejectUnauthorized: true) already verifies
 * correctly. A custom CA file would only be needed if certificate
 * verification genuinely failed for a specific cluster - it is not added
 * speculatively.
 *
 * Never uses `rejectUnauthorized: false`, never reads or sets
 * NODE_TLS_REJECT_UNAUTHORIZED, and never applies any global TLS override -
 * every option here is scoped to this one connection.
 *
 * `transportMode` must be passed explicitly by the caller (typically
 * `parseTestDbTransportMode(process.env.TEST_DATABASE_TRANSPORT)`) - this
 * function never reads process.env itself, so there is no hidden
 * environment read to audit. Passing `"internal_plaintext"` additionally
 * skips TLS for a Coolify/Docker-internal MariaDB host (see
 * isDockerInternalSingleLabelHost and assertInternalPlaintextEligible
 * above) - but ONLY when every one of that mode's own conditions holds;
 * otherwise this throws rather than silently falling back to either
 * behavior. The default (`undefined`, or any value other than the exact
 * literal `"internal_plaintext"`) reproduces this function's original
 * behavior byte-for-byte: TLS required everywhere except the pre-existing
 * loopback exception.
 */
export function buildTestDbConnectionOptions(
  testDatabaseUrl: string | undefined | null,
  transportMode: TestDbTransportMode
): TestDbConnectionOptions {
  assertSafeTestDatabaseUrl(testDatabaseUrl);

  const parsed = new URL(testDatabaseUrl!);
  const database = parsed.pathname.replace(/^\//, "");
  const port = parsed.port ? Number(parsed.port) : 3306;

  // Redundant, local defense-in-depth: assertSafeTestDatabaseUrl above
  // already requires an EXACT match ("ipenovel_test"), which is strictly
  // narrower than this "ends with" check - so this can never itself be the
  // thing that lets an unsafe database name through. It exists so the
  // loopback/TLS decision below never depends on an assumption about what
  // an earlier call already checked.
  const isTestDatabaseName = database.endsWith("ipenovel_test");
  const skipTlsForLoopback = isTestDatabaseName && isLoopbackTestHost(parsed.hostname);

  // Only evaluated when the loopback exception above doesn't already
  // apply, so a loopback host is never spuriously rejected by
  // assertInternalPlaintextEligible's stricter, non-overlapping hostname
  // shape check just because a caller also happened to pass
  // transportMode: "internal_plaintext".
  const skipTlsForInternalPlaintext =
    !skipTlsForLoopback &&
    transportMode === "internal_plaintext" &&
    assertInternalPlaintextEligible(database, parsed.hostname, port);

  const skipTls = skipTlsForLoopback || skipTlsForInternalPlaintext;

  return {
    host: parsed.hostname,
    port,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database,
    ...(skipTls
      ? {}
      : {
          ssl: {
            minVersion: "TLSv1.2",
            rejectUnauthorized: true,
          },
        }),
  };
}
