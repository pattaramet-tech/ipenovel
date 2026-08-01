import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "node:path";
import { resetToMigrationCutoff } from "./resetToMigrationCutoff";
import { readMigrationJournal } from "./migrateTestDbWithLogging";
import * as resetToEmptySchemaModule from "./resetToEmptySchema";

/**
 * DB-independent coverage for resetToMigrationCutoff() - the empty-reset
 * step is mocked (resetToEmptySchema() already has its own full, dedicated
 * unit coverage in resetToEmptySchema.test.ts; re-verifying its internals
 * here would be redundant), but migration application itself runs for
 * REAL against the REAL drizzle/ journal via a fake connection (the same
 * "understands just enough SQL shape to drive resume/skip" pattern
 * migrateTestDbWithLogging.test.ts uses) - so "doesn't run migrations past
 * the cutoff" and "the post-run high-water mark matches the cutoff" are
 * proven against real journal data, not a synthetic stand-in.
 *
 * See server/migration-0024-episode-schema-repair.integration.test.ts for
 * the real (TEST_DATABASE_URL-gated) integration usage this helper backs,
 * and this file's own top-of-file docstring for the bug it fixes (a
 * migration-journal rewind that left later migrations' PHYSICAL schema
 * objects behind, causing ER_TABLE_EXISTS_ERROR on re-run).
 */

vi.mock("./resetToEmptySchema", async () => {
  const actual = await vi.importActual<typeof resetToEmptySchemaModule>("./resetToEmptySchema");
  return { ...actual, resetToEmptySchema: vi.fn() };
});

const migrationsFolder = path.resolve(__dirname, "..", "..", "drizzle");
const VALID_URL = "mysql://ipenovel_test_app:secret@db.internal:3306/ipenovel_test";

/** Same fake-connection shape as migrateTestDbWithLogging.test.ts, extended with a MAX(created_at) handler for resetToMigrationCutoff's own post-run verification query. */
function fakeConnection() {
  const migrations: Array<{ hash: string; created_at: number }> = [];
  const executedStatements: string[] = [];

  const conn = {
    async query(sql: string, params?: unknown[]) {
      const trimmed = sql.trim();
      if (/^create table if not exists `__drizzle_migrations`/i.test(trimmed)) {
        return [[], []];
      }
      if (/^select id, hash, created_at from `__drizzle_migrations`/i.test(trimmed)) {
        const last = [...migrations].sort((a, b) => b.created_at - a.created_at)[0];
        return [last ? [last] : [], []];
      }
      if (/^select max\(created_at\) as latest from `__drizzle_migrations`/i.test(trimmed)) {
        const latest = migrations.length > 0 ? Math.max(...migrations.map((m) => m.created_at)) : null;
        return [[{ latest }], []];
      }
      if (/^insert into `__drizzle_migrations`/i.test(trimmed)) {
        const [hash, createdAt] = params as [string, number];
        migrations.push({ hash, created_at: createdAt });
        return [{}, []];
      }
      executedStatements.push(sql);
      return [{}, []];
    },
  };

  return { conn, migrations, executedStatements };
}

beforeEach(() => {
  vi.mocked(resetToEmptySchemaModule.resetToEmptySchema).mockReset().mockResolvedValue(undefined);
});

describe("resetToMigrationCutoff - cutoff correctness (real journal, fake connection)", () => {
  it("attempts only migrations up to and including the cutoff tag - nothing after it", async () => {
    const { conn, migrations } = fakeConnection();
    const cutoffTag = "0023_add_episode_sale_mode";

    await resetToMigrationCutoff(conn, VALID_URL, migrationsFolder, cutoffTag);

    const journal = readMigrationJournal(migrationsFolder);
    const cutoffIdx = journal.findIndex((e) => e.tag === cutoffTag);
    const cutoffEntry = journal[cutoffIdx];
    const laterEntries = journal.slice(cutoffIdx + 1);
    expect(laterEntries.length).toBeGreaterThan(0); // sanity: there really is at least one later migration to have skipped

    // Every inserted __drizzle_migrations row's created_at is one of the
    // 0000..cutoff entries' `when` values - never a later one.
    const insertedWhens = migrations.map((m) => m.created_at);
    for (const laterEntry of laterEntries) {
      expect(insertedWhens).not.toContain(laterEntry.when);
    }
    expect(Math.max(...insertedWhens)).toBe(cutoffEntry.when);
  });

  it("the resulting journal high-water mark matches the cutoff's exact `when` timestamp", async () => {
    const { conn } = fakeConnection();
    const journal = readMigrationJournal(migrationsFolder);
    const cutoffTag = "0027_add_daily_checkin_and_coupon_cap";
    const cutoffEntry = journal.find((e) => e.tag === cutoffTag)!;

    await resetToMigrationCutoff(conn, VALID_URL, migrationsFolder, cutoffTag);

    const [[{ latest }]]: any = await conn.query("SELECT MAX(created_at) AS latest FROM `__drizzle_migrations`");
    expect(Number(latest)).toBe(cutoffEntry.when);
  });

  it("rejects a cutoff tag that does not exist in the journal - never silently runs the full chain or a partial one", async () => {
    const { conn, migrations } = fakeConnection();

    await expect(
      resetToMigrationCutoff(conn, VALID_URL, migrationsFolder, "9999_this_tag_does_not_exist")
    ).rejects.toThrow(/9999_this_tag_does_not_exist/);

    expect(migrations).toEqual([]); // nothing was ever inserted
    expect(resetToEmptySchemaModule.resetToEmptySchema).not.toHaveBeenCalled(); // never even reset - checked before any destructive step
  });
});

describe("resetToMigrationCutoff - TEST_DATABASE_URL only, never DATABASE_URL", () => {
  it("passes the given testDatabaseUrl straight through to resetToEmptySchema, verbatim", async () => {
    const { conn } = fakeConnection();
    await resetToMigrationCutoff(conn, VALID_URL, migrationsFolder, "0023_add_episode_sale_mode");

    expect(resetToEmptySchemaModule.resetToEmptySchema).toHaveBeenCalledWith(conn, VALID_URL);
  });

  it("never reads process.env.DATABASE_URL itself - passing undefined propagates undefined to resetToEmptySchema even if DATABASE_URL is set", async () => {
    const originalDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "mysql://user:pass@prod-host:3306/ipenovel_test"; // a real-looking, name-matching value
    try {
      const { conn } = fakeConnection();
      await resetToMigrationCutoff(conn, undefined, migrationsFolder, "0023_add_episode_sale_mode");
      expect(resetToEmptySchemaModule.resetToEmptySchema).toHaveBeenCalledWith(conn, undefined);
    } finally {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
  });
});

describe("resetToMigrationCutoff - errors are never swallowed", () => {
  it("propagates a failure from resetToEmptySchema itself - never proceeds to run any migration", async () => {
    vi.mocked(resetToEmptySchemaModule.resetToEmptySchema).mockRejectedValue(new Error("reset refused"));
    const { conn, migrations } = fakeConnection();

    await expect(
      resetToMigrationCutoff(conn, VALID_URL, migrationsFolder, "0023_add_episode_sale_mode")
    ).rejects.toThrow(/reset refused/);

    expect(migrations).toEqual([]);
  });

  it("propagates a migration failure (real journal + a connection that fails on a specific statement) rather than resolving", async () => {
    const conn = {
      async query(sql: string, params?: unknown[]) {
        const trimmed = sql.trim();
        if (/^create table if not exists `__drizzle_migrations`/i.test(trimmed)) return [[], []];
        if (/^select id, hash, created_at from `__drizzle_migrations`/i.test(trimmed)) return [[], []];
        if (/CREATE TABLE/i.test(trimmed)) {
          const err: any = new Error("simulated failure on first CREATE TABLE");
          err.code = "ER_CANT_CREATE_TABLE";
          throw err;
        }
        void params;
        return [{}, []];
      },
    };

    await expect(
      resetToMigrationCutoff(conn, VALID_URL, migrationsFolder, "0000_needy_anthem")
    ).rejects.toThrow(/simulated failure/);
  });

  it("throws if the post-run live high-water mark does not match the cutoff (never trusts 'runMigrationsWithLogging resolved' alone)", async () => {
    // A connection that always reports a stale/wrong MAX(created_at),
    // simulating an environment where the verification itself would
    // otherwise be the only thing catching a silently-incomplete run.
    const conn = {
      async query(sql: string, params?: unknown[]) {
        const trimmed = sql.trim();
        if (/^create table if not exists `__drizzle_migrations`/i.test(trimmed)) return [[], []];
        if (/^select id, hash, created_at from `__drizzle_migrations`/i.test(trimmed)) return [[], []];
        if (/^select max\(created_at\) as latest from `__drizzle_migrations`/i.test(trimmed)) {
          return [[{ latest: -999 }], []]; // deliberately wrong
        }
        void params;
        return [{}, []];
      },
    };

    await expect(
      resetToMigrationCutoff(conn, VALID_URL, migrationsFolder, "0023_add_episode_sale_mode")
    ).rejects.toThrow(/high-water mark/);
  });
});
