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
import type { ConnectionOptions } from "mysql2";
import { assertSafeTestDatabaseUrl } from "./testDatabaseGuard";

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
 */
export function buildTestDbConnectionOptions(testDatabaseUrl: string | undefined | null): TestDbConnectionOptions {
  assertSafeTestDatabaseUrl(testDatabaseUrl);

  const parsed = new URL(testDatabaseUrl!);
  const database = parsed.pathname.replace(/^\//, "");

  // Redundant, local defense-in-depth: assertSafeTestDatabaseUrl above
  // already requires an EXACT match ("ipenovel_test"), which is strictly
  // narrower than this "ends with" check - so this can never itself be the
  // thing that lets an unsafe database name through. It exists so the
  // loopback/TLS decision below never depends on an assumption about what
  // an earlier call already checked.
  const isTestDatabaseName = database.endsWith("ipenovel_test");
  const skipTls = isTestDatabaseName && isLoopbackTestHost(parsed.hostname);

  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 3306,
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
