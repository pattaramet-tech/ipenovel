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
  ssl: {
    minVersion: "TLSv1.2";
    rejectUnauthorized: true;
  };
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

  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 3306,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database,
    ssl: {
      minVersion: "TLSv1.2",
      rejectUnauthorized: true,
    },
  };
}
