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
 * Database names that unambiguously mark a connection as a test database.
 * The check is case-insensitive and matches a "test" or "ci" segment
 * bounded by non-alphanumeric characters (or string start/end) - so
 * "ipenovel_test", "test_ipenovel", "ipenovel-ci" all match, but
 * "attestation" or "circuit" do not (avoids accidental substring matches on
 * unrelated words).
 */
const TEST_NAME_PATTERN = /(^|[^a-z0-9])(test|ci)([^a-z0-9]|$)/i;

/**
 * Database/host names that must NEVER be treated as a test database, even
 * if they happen to also contain "test" somewhere (defense in depth - an
 * allowlist match alone is not trusted if a blocklist term is also
 * present). Matches as a bounded segment, same rule as TEST_NAME_PATTERN.
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
 * True only if the database name (not the host) unambiguously identifies
 * this as a disposable test database, and does not also match a
 * production-sounding name.
 */
export function isAllowedTestDatabaseName(databaseName: string): boolean {
  if (!databaseName) return false;
  if (PRODUCTION_NAME_PATTERN.test(databaseName)) return false;
  return TEST_NAME_PATTERN.test(databaseName);
}

/**
 * True if the database name OR host looks production-like. This is a
 * blocklist, checked independently of (and prioritized over) the allowlist
 * - a name can fail this check even if isAllowedTestDatabaseName would
 * otherwise pass, e.g. "ipenovel_test_prod_mirror".
 */
export function looksLikeProductionDatabase(parsed: ParsedDatabaseUrl): boolean {
  return PRODUCTION_NAME_PATTERN.test(parsed.databaseName) || PRODUCTION_NAME_PATTERN.test(parsed.host);
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
      reason: `database name or host looks production-like ("${parsed.databaseName}" @ "${parsed.host}")`,
      parsed,
    };
  }

  if (!isAllowedTestDatabaseName(parsed.databaseName)) {
    return {
      safe: false,
      reason: `database name "${parsed.databaseName}" does not look like a test database (expected a "test" or "ci" segment, e.g. "ipenovel_test")`,
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
        `Set TEST_DATABASE_URL to a connection string whose database name clearly identifies it as ` +
        `disposable/test (e.g. "ipenovel_test"). Integration tests never fall back to DATABASE_URL.`
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
