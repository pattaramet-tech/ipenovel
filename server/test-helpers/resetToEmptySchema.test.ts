import { describe, it, expect, vi } from "vitest";
import { resetToEmptySchema, type QueryableConnection } from "./resetToEmptySchema";

/**
 * DB-independent coverage for resetToEmptySchema() - every query is a
 * fake, so this proves the safety-gate/ordering/verification contract
 * without ever touching a real database. See
 * server/migration-0024-episode-schema-repair.integration.test.ts for the
 * real (TEST_DATABASE_URL-gated) integration usage this helper backs, and
 * this file's own top-of-file docstring for the bug it fixes.
 */

const VALID_URL = "mysql://ipenovel_test_app:secret@db.internal:3306/ipenovel_test";

// The four information_schema queries resetToEmptySchema issues are
// distinguished by their SELECT clause prefix - anchored patterns here so
// a fake response for one can never accidentally satisfy another (the
// "enumerate tables to drop" and "count remaining tables" queries both
// contain "information_schema.tables ... TABLE_TYPE = 'BASE TABLE'", so a
// pattern that only checks for that substring would match both).
const ENUMERATE_VIEWS = /^SELECT TABLE_NAME AS name FROM information_schema\.views/;
const ENUMERATE_TABLES = /^SELECT TABLE_NAME AS name FROM information_schema\.tables/;
const COUNT_TABLES = /^SELECT COUNT\(\*\) AS cnt FROM information_schema\.tables/;
const COUNT_VIEWS = /^SELECT COUNT\(\*\) AS cnt FROM information_schema\.views/;
const SELECT_DATABASE = /^SELECT DATABASE\(\) AS name/;

/**
 * A scriptable fake QueryableConnection - `responses` maps a pattern to
 * the `[rows, fields]`-shaped tuple `.query()` should resolve with
 * (mirroring mysql2's real return shape); any query whose SQL doesn't
 * match a configured pattern resolves to an empty result set ([[]]) rather
 * than throwing, unless `failOn` also matches it, in which case it rejects
 * instead. Every call (in order, verbatim) is recorded in `calls` for
 * ordering/argument assertions.
 */
function fakeConnection(options: {
  responses?: Array<{ match: RegExp; rows: any[] }>;
  failOn?: RegExp;
} = {}): { conn: QueryableConnection; calls: string[] } {
  const calls: string[] = [];
  const query = vi.fn(async (sql: string) => {
    calls.push(sql);
    if (options.failOn?.test(sql)) {
      const err: any = new Error("simulated driver failure");
      err.errno = 1005;
      err.code = "ER_CANT_CREATE_TABLE";
      throw err;
    }
    for (const { match, rows } of options.responses ?? []) {
      if (match.test(sql)) return [rows];
    }
    return [[]];
  });
  return { conn: { query }, calls };
}

/** A connection pre-scripted for a fully successful, empty-after reset with no views/tables found - the common "happy path" baseline every other test tweaks by overriding specific responses. */
function successfulConnection(overrides: {
  tablesToEnumerate?: any[];
  viewsToEnumerate?: any[];
  remainingTables?: number;
  remainingViews?: number;
  failOn?: RegExp;
} = {}) {
  return fakeConnection({
    responses: [
      { match: SELECT_DATABASE, rows: [{ name: "ipenovel_test" }] },
      { match: ENUMERATE_VIEWS, rows: overrides.viewsToEnumerate ?? [] },
      { match: ENUMERATE_TABLES, rows: overrides.tablesToEnumerate ?? [] },
      { match: COUNT_TABLES, rows: [{ cnt: overrides.remainingTables ?? 0 }] },
      { match: COUNT_VIEWS, rows: [{ cnt: overrides.remainingViews ?? 0 }] },
    ],
    failOn: overrides.failOn,
  });
}

describe("resetToEmptySchema - database-name guards", () => {
  it("refuses when testDatabaseUrl is undefined - never queries anything", async () => {
    const { conn, calls } = successfulConnection();
    await expect(resetToEmptySchema(conn, undefined)).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("refuses when the parsed database name is not exactly 'ipenovel_test'", async () => {
    const { conn, calls } = successfulConnection();
    await expect(
      resetToEmptySchema(conn, "mysql://user:pass@host:3306/some_other_db")
    ).rejects.toThrow(/ipenovel_test/);
    expect(calls).toHaveLength(0); // the URL check runs before any query at all
  });

  it("refuses a production-shaped database name even if it happens to contain 'test'", async () => {
    const { conn, calls } = successfulConnection();
    await expect(
      resetToEmptySchema(conn, "mysql://user:pass@host:3306/ipenovel_test_prod_mirror")
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("never falls back to any other environment variable - only the exact string passed in is ever consulted", async () => {
    const originalDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "mysql://user:pass@prod-host:3306/ipenovel_test"; // a real-looking, even name-matching value
    try {
      const { conn, calls } = successfulConnection();
      // Passing undefined must still fail even though DATABASE_URL "looks fine" -
      // proves this function never reads process.env itself.
      await expect(resetToEmptySchema(conn, undefined)).rejects.toThrow();
      expect(calls).toHaveLength(0);
    } finally {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
  });

  it("URL check passes, but the LIVE SELECT DATABASE() disagrees - refuses, never issues a single DROP", async () => {
    const { conn, calls } = fakeConnection({
      responses: [{ match: SELECT_DATABASE, rows: [{ name: "some_other_live_db" }] }],
    });
    await expect(resetToEmptySchema(conn, VALID_URL)).rejects.toThrow(/some_other_live_db/);
    expect(calls.some((c) => /DROP/i.test(c))).toBe(false);
    expect(calls.some((c) => /FOREIGN_KEY_CHECKS/i.test(c))).toBe(false);
  });

  it("the live check returning nothing at all (no rows) is refused, never treated as a pass", async () => {
    const { conn, calls } = fakeConnection({ responses: [{ match: SELECT_DATABASE, rows: [] }] });
    await expect(resetToEmptySchema(conn, VALID_URL)).rejects.toThrow();
    expect(calls.some((c) => /DROP/i.test(c))).toBe(false);
  });
});

describe("resetToEmptySchema - foreign-key-safe removal", () => {
  it("sets FOREIGN_KEY_CHECKS = 0 before any DROP, and restores it to 1 afterward", async () => {
    const { conn, calls } = successfulConnection({
      tablesToEnumerate: [{ name: "users" }, { name: "authIdentities" }],
    });

    await resetToEmptySchema(conn, VALID_URL);

    const offIndex = calls.findIndex((c) => /FOREIGN_KEY_CHECKS = 0/.test(c));
    const onIndex = calls.findIndex((c) => /FOREIGN_KEY_CHECKS = 1/.test(c));
    const dropIndexes = calls.map((c, i) => (/^DROP /.test(c) ? i : -1)).filter((i) => i >= 0);

    expect(offIndex).toBeGreaterThanOrEqual(0);
    expect(onIndex).toBeGreaterThan(offIndex);
    expect(dropIndexes.length).toBeGreaterThan(0);
    expect(Math.min(...dropIndexes)).toBeGreaterThan(offIndex);
    expect(Math.max(...dropIndexes)).toBeLessThan(onIndex);
  });

  it("drops BOTH tables regardless of a foreign key between them (users referenced by authIdentities) - order among tables must not matter once FK checks are off", async () => {
    // Deliberately PARENT-before-child order (users before authIdentities,
    // the exact order that would fail under a naive FK-checks-on drop of a
    // referenced parent table first).
    const { conn, calls } = successfulConnection({
      tablesToEnumerate: [{ name: "users" }, { name: "authIdentities" }],
    });

    await resetToEmptySchema(conn, VALID_URL);

    expect(calls).toContain("DROP TABLE IF EXISTS `users`");
    expect(calls).toContain("DROP TABLE IF EXISTS `authIdentities`");
  });

  it("restores FOREIGN_KEY_CHECKS = 1 even when a DROP fails partway through", async () => {
    const { conn, calls } = successfulConnection({
      tablesToEnumerate: [{ name: "users" }],
      failOn: /^DROP TABLE/,
    });

    await expect(resetToEmptySchema(conn, VALID_URL)).rejects.toThrow();

    expect(calls.some((c) => /FOREIGN_KEY_CHECKS = 1/.test(c))).toBe(true);
  });
});

describe("resetToEmptySchema - views dropped before tables", () => {
  it("issues every DROP VIEW before any DROP TABLE", async () => {
    const { conn, calls } = successfulConnection({
      viewsToEnumerate: [{ name: "some_view" }],
      tablesToEnumerate: [{ name: "users" }],
    });

    await resetToEmptySchema(conn, VALID_URL);

    const dropViewIndex = calls.findIndex((c) => /^DROP VIEW/.test(c));
    const dropTableIndex = calls.findIndex((c) => /^DROP TABLE/.test(c));
    expect(dropViewIndex).toBeGreaterThanOrEqual(0);
    expect(dropTableIndex).toBeGreaterThan(dropViewIndex);
    expect(calls).toContain("DROP VIEW IF EXISTS `some_view`");
  });

  it("uses DROP VIEW, never DROP TABLE, for an object reported by information_schema.views - DROP TABLE cannot remove a view even with IF EXISTS", async () => {
    const { conn, calls } = successfulConnection({ viewsToEnumerate: [{ name: "legacy_view" }] });

    await resetToEmptySchema(conn, VALID_URL);

    expect(calls).toContain("DROP VIEW IF EXISTS `legacy_view`");
    expect(calls.some((c) => /DROP TABLE.*legacy_view/.test(c))).toBe(false);
  });
});

describe("resetToEmptySchema - post-reset zero-object verification", () => {
  it("throws if base tables remain after the drop pass, even though every individual DROP appeared to succeed", async () => {
    // Post-verification still reports a leftover table - simulates
    // exactly the original bug's silent-partial-reset failure mode.
    const { conn } = successfulConnection({ tablesToEnumerate: [{ name: "users" }], remainingTables: 1 });

    await expect(resetToEmptySchema(conn, VALID_URL)).rejects.toThrow(/1 base table/);
  });

  it("throws if views remain after the drop pass", async () => {
    const { conn } = successfulConnection({ viewsToEnumerate: [{ name: "some_view" }], remainingViews: 1 });

    await expect(resetToEmptySchema(conn, VALID_URL)).rejects.toThrow(/1 view/);
  });

  it("succeeds only when both post-reset counts are genuinely zero", async () => {
    const { conn, calls } = successfulConnection();
    await expect(resetToEmptySchema(conn, VALID_URL)).resolves.toBeUndefined();
    expect(calls.some((c) => COUNT_TABLES.test(c))).toBe(true);
    expect(calls.some((c) => COUNT_VIEWS.test(c))).toBe(true);
  });
});

describe("resetToEmptySchema - failures remain visible, never swallowed", () => {
  it("a failing DROP TABLE propagates as a real rejection, not a silently-resolved promise", async () => {
    const { conn } = successfulConnection({ tablesToEnumerate: [{ name: "users" }], failOn: /^DROP TABLE/ });

    await expect(resetToEmptySchema(conn, VALID_URL)).rejects.toThrow(/simulated driver failure/);
  });

  it("a failing DROP VIEW propagates too, and never lets the reset proceed to the tables phase silently", async () => {
    const { conn, calls } = successfulConnection({
      viewsToEnumerate: [{ name: "broken_view" }],
      failOn: /^DROP VIEW/,
    });

    await expect(resetToEmptySchema(conn, VALID_URL)).rejects.toThrow();
    expect(calls.some((c) => /^DROP TABLE/.test(c))).toBe(false); // never reached the tables phase
  });
});

describe("resetToEmptySchema - identifier safety", () => {
  it("refuses to drop an object whose name doesn't look like a plain, expected identifier - never interpolates it into DDL regardless", async () => {
    const { conn, calls } = successfulConnection({
      tablesToEnumerate: [{ name: "users`; DROP DATABASE ipenovel_test; --" }],
    });

    await expect(resetToEmptySchema(conn, VALID_URL)).rejects.toThrow(/unsafe\/unexpected identifier/);
    expect(calls.some((c) => /DROP DATABASE/i.test(c))).toBe(false);
  });

  it("never issues DROP DATABASE anywhere, even implicitly via a crafted identifier", async () => {
    const { conn, calls } = successfulConnection();
    await resetToEmptySchema(conn, VALID_URL);
    expect(calls.some((c) => /DROP DATABASE/i.test(c))).toBe(false);
  });

  it("never interpolates the schema name itself into any query - every query uses DATABASE() instead", async () => {
    const { conn, calls } = successfulConnection();
    await resetToEmptySchema(conn, VALID_URL);
    for (const call of calls) {
      expect(call).not.toMatch(/ipenovel_test/); // the literal db name never appears in issued SQL
    }
  });
});
