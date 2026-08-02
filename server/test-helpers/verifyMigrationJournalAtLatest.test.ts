import { describe, it, expect } from "vitest";
import path from "node:path";
import { verifyMigrationJournalAtLatest } from "./verifyMigrationJournalAtLatest";
import { readMigrationJournal } from "./migrateTestDbWithLogging";

const migrationsFolder = path.resolve(__dirname, "..", "..", "drizzle");

function fakeConnection(latest: number | null) {
  return {
    async query(sql: string) {
      if (/^SELECT MAX\(created_at\) AS latest FROM `__drizzle_migrations`/.test(sql)) {
        return [[{ latest }]];
      }
      throw new Error(`unexpected query in fake connection: ${sql}`);
    },
  };
}

describe("verifyMigrationJournalAtLatest", () => {
  it("resolves when the live high-water mark exactly equals the newest journal entry", async () => {
    const journal = readMigrationJournal(migrationsFolder);
    const newestWhen = journal[journal.length - 1].when;
    const conn = fakeConnection(newestWhen);

    await expect(verifyMigrationJournalAtLatest(conn, migrationsFolder)).resolves.toBeUndefined();
  });

  it("throws when the live high-water mark is behind the newest journal entry", async () => {
    const journal = readMigrationJournal(migrationsFolder);
    const staleWhen = journal[journal.length - 2].when; // one migration short
    const conn = fakeConnection(staleWhen);

    await expect(verifyMigrationJournalAtLatest(conn, migrationsFolder)).rejects.toThrow(/fully-migrated baseline/);
  });

  it("throws when __drizzle_migrations is empty (no rows at all)", async () => {
    const conn = fakeConnection(null);
    await expect(verifyMigrationJournalAtLatest(conn, migrationsFolder)).rejects.toThrow();
  });

  it("throws when the live high-water mark is somehow AHEAD of the newest journal entry (never silently accepted as 'good enough')", async () => {
    const journal = readMigrationJournal(migrationsFolder);
    const newestWhen = journal[journal.length - 1].when;
    const conn = fakeConnection(newestWhen + 999999);

    await expect(verifyMigrationJournalAtLatest(conn, migrationsFolder)).rejects.toThrow();
  });

  it("the thrown error names both the expected and actual high-water marks, for real debuggability - never a raw/opaque failure", async () => {
    const journal = readMigrationJournal(migrationsFolder);
    const newestWhen = journal[journal.length - 1].when;
    const conn = fakeConnection(1);

    await expect(verifyMigrationJournalAtLatest(conn, migrationsFolder)).rejects.toThrow(
      new RegExp(`${newestWhen}.*found 1`)
    );
  });
});
