// Pure, dependency-free safety checks for test database connection strings.
// No DB connection is made anywhere in this file - every function here is a
// plain string check, which is exactly why it can be fully unit-tested
// without a live database (see testDatabaseGuard.test.ts).
//
// Used by server/test-helpers/testDb.ts and vitest.integration.globalsetup.ts
// to enforce: integration tests may ONLY ever connect to something that
// looks unmistakably like a disposable test database, never production.
// See docs/TEST_INFRASTRUCTURE.md.

/**
 * The ONE database name this project will ever run test setup, migrations,
 * resets, or seeds against. Tightened from an earlier "contains a test/ci
 * segment" pattern match to this single exact literal after the daily
 * check-in production incident - see docs/INCIDENT_DAILY_CHECKIN_ROLLBACK.md.
 * A pattern match can be satisfied by names nobody actually provisioned
 * ("ipenovel-ci-mirror-of-prod"); an exact match cannot. This same constant
 * is also checked, independently and via a live "SELECT DATABASE()" query
 * (not just this URL-string check), by server/test-helpers/liveTestDatabaseCheck.ts
 * before any migration/reset/seed step touches the connection.
 */
export const EXPECTED_TEST_DATABASE_NAME = "ipenovel_test";

/**
 * Database NAME patterns that must NEVER be treated as a test database.
 * Kept as an independent, cheap pre-check even though an exact match
 * against EXPECTED_TEST_DATABASE_NAME alone already rules these out by
 * construction - defense in depth against this constant ever being
 * loosened back to a pattern in the future without this blocklist being
 * removed at the same time. Matches a bounded segment (not a bare
 * substring), so "prod" flags "ipenovel_prod" but not e.g. a hypothetical
 * "reproduce_test".
 */
const PRODUCTION_NAME_PATTERN = /(^|[^a-z0-9])(prod|production|live|master)([^a-z0-9]|$)/i;

export interface ParsedDatabaseUrl {
  host: string;
  port: string;
  databaseName: string;
}

/**
 * Parse just the host/port/database-name portion of a MySQL connection
 * string - never returns the username or password. Returns null if the
 * string isn't a parseable URL at all (caller should treat that as unsafe).
 */
export function parseDatabaseUrl(url: string): ParsedDatabaseUrl | null {
  try {
    const parsed = new URL(url);
    const databaseName = parsed.pathname.replace(/^\//, "");
    return {
      host: parsed.hostname,
      port: parsed.port || "3306",
      databaseName,
    };
  } catch {
    return null;
  }
}

/**
 * True only if the database name is an EXACT (case-sensitive) match for
 * EXPECTED_TEST_DATABASE_NAME ("ipenovel_test"). No pattern, no prefix/
 * suffix matching, no case-folding - any other name, however test-like it
 * looks, is rejected.
 */
export function isAllowedTestDatabaseName(databaseName: string): boolean {
  if (!databaseName) return false;
  return databaseName === EXPECTED_TEST_DATABASE_NAME;
}

/**
 * True if the database NAME looks production-like. This is a blocklist,
 * checked independently of (and prioritized over) the allowlist - a name
 * can fail this check even if isAllowedTestDatabaseName would otherwise
 * pass, e.g. "ipenovel_test_prod_mirror".
 *
 * Deliberately checks parsed.databaseName ONLY, never parsed.host.
 * Managed database providers routinely bake infrastructure descriptors
 * into their hostnames that have nothing to do with which database was
 * selected - e.g. TiDB Cloud's gateway hosts look like
 * "gateway01.ap-southeast-1.prod.aws.tidbcloud.com", where "prod" means
 * "production AWS region for TiDB Cloud's own infrastructure", not "this
 * connection targets a production application database". Checking the
 * host here previously rejected exactly that kind of legitimate,
 * disposable-test-database connection string. The database NAME is the
 * only part of the connection string that actually says which database
 * will be queried, and it is additionally re-verified (independent of this
 * function entirely) via a live "SELECT DATABASE()" query - see
 * liveTestDatabaseCheck.ts - so dropping the host check does not weaken
 * the overall guarantee.
 */
export function looksLikeProductionDatabase(parsed: ParsedDatabaseUrl): boolean {
  return PRODUCTION_NAME_PATTERN.test(parsed.databaseName);
}

export interface TestDatabaseUrlCheck {
  safe: boolean;
  reason?: string;
  parsed: ParsedDatabaseUrl | null;
}

/**
 * The single source of truth for "is this connection string safe to run
 * destructive integration-test setup (reset/seed/truncate) against."
 * Every caller (getTestDb, the integration globalSetup, admin scripts)
 * must go through this - never re-implement the allow/block logic inline.
 */
export function checkTestDatabaseUrl(url: string | undefined | null): TestDatabaseUrlCheck {
  if (!url || !url.trim()) {
    return { safe: false, reason: "empty or missing connection string", parsed: null };
  }

  const parsed = parseDatabaseUrl(url);
  if (!parsed) {
    return { safe: false, reason: "connection string is not a parseable URL", parsed: null };
  }

  if (!parsed.databaseName) {
    return { safe: false, reason: "connection string has no database name", parsed };
  }

  if (looksLikeProductionDatabase(parsed)) {
    return {
      safe: false,
      reason: `database name looks production-like ("${parsed.databaseName}")`,
      parsed,
    };
  }

  if (!isAllowedTestDatabaseName(parsed.databaseName)) {
    return {
      safe: false,
      reason: `database name "${parsed.databaseName}" is not "${EXPECTED_TEST_DATABASE_NAME}" - this is the only ` +
        `database name this project will run test setup against, checked both here (connection string) and again ` +
        `via a live "SELECT DATABASE()" query before any migration/reset/seed step`,
      parsed,
    };
  }

  return { safe: true, parsed };
}

/**
 * Throws with a clear, actionable message if the URL is not a safe test
 * database. Never includes the username/password in the thrown message.
 */
export function assertSafeTestDatabaseUrl(url: string | undefined | null): ParsedDatabaseUrl {
  const check = checkTestDatabaseUrl(url);
  if (!check.safe) {
    throw new Error(
      `Refusing to run integration tests against this database: ${check.reason}. ` +
        `Set TEST_DATABASE_URL to a connection string whose database name is exactly ` +
        `"${EXPECTED_TEST_DATABASE_NAME}". Integration tests never fall back to DATABASE_URL.`
    );
  }
  return check.parsed!;
}

/**
 * Safe-for-logging summary of a connection string: host, port, and database
 * name only. Never the username or password, regardless of input shape -
 * even if parseDatabaseUrl fails, this never echoes the raw string back.
 */
export function redactDatabaseUrl(url: string | undefined | null): string {
  if (!url) return "(not set)";
  const parsed = parseDatabaseUrl(url);
  if (!parsed) return "(unparseable connection string - redacted)";
  return `${parsed.host}:${parsed.port}/${parsed.databaseName}`;
}
