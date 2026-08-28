/**
 * IPE-004-C08 P2 (acceptance C/D): the Drizzle metadata chain must be
 * COMPLETE, not just the SQL.
 *
 * Migration 0039 shipped as `drizzle/0039_*.sql` plus a `_journal.json` entry,
 * but without `drizzle/meta/0039_snapshot.json`. drizzle-kit does not diff
 * `schema.ts` against the SQL - it diffs it against the LAST snapshot it can
 * find. With 0039's snapshot absent, the newest state it knew was 0038's, so
 * a clean `drizzle-kit generate` concluded that paymentSlipLegacyCollisions
 * and paymentSlipLegacyUnknown did not exist yet and emitted a duplicate
 * 0040 re-creating both tables and both indexes. Applying that against a
 * database where 0039 already ran fails with "table already exists" and stops
 * the deploy; applying it to a fresh database silently creates a divergent
 * 40th migration nothing else knows about.
 *
 * These checks are file-level and need neither a database nor the drizzle-kit
 * CLI, so they run in the normal unit suite and fail the moment a migration is
 * committed without its snapshot again.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const drizzleDir = path.resolve(process.cwd(), "drizzle");
const metaDir = path.join(drizzleDir, "meta");

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

interface Snapshot {
  id: string;
  prevId: string;
  version: string;
  dialect: string;
  tables: Record<
    string,
    {
      name: string;
      columns: Record<string, unknown>;
      indexes: Record<string, { name: string; columns: string[]; isUnique: boolean }>;
      compositePrimaryKeys?: Record<string, { name: string; columns: string[] }>;
    }
  >;
}

const journal = JSON.parse(fs.readFileSync(path.join(metaDir, "_journal.json"), "utf-8")) as {
  version: string;
  dialect: string;
  entries: JournalEntry[];
};

const snapshotName = (idx: number) => `${String(idx).padStart(4, "0")}_snapshot.json`;
const readSnapshot = (idx: number) =>
  JSON.parse(fs.readFileSync(path.join(metaDir, snapshotName(idx)), "utf-8")) as Snapshot;

const LEGACY_REGISTRY_TABLES = ["paymentSlipLegacyCollisions", "paymentSlipLegacyUnknown"];

describe("drizzle metadata chain is complete", () => {
  it("C. every journalled migration has both its .sql file and its snapshot", () => {
    const missing: string[] = [];
    for (const entry of journal.entries) {
      if (!fs.existsSync(path.join(drizzleDir, `${entry.tag}.sql`))) {
        missing.push(`${entry.tag}.sql`);
      }
      if (!fs.existsSync(path.join(metaDir, snapshotName(entry.idx)))) {
        missing.push(snapshotName(entry.idx));
      }
    }
    expect(missing).toEqual([]);
  });

  it("C. 0039's snapshot exists and is chained to 0038's (this is the regression)", () => {
    const s38 = readSnapshot(38);
    const s39 = readSnapshot(39);
    expect(s39.prevId).toBe(s38.id);
    expect(s39.id).not.toBe(s38.id);
    expect(s39.dialect).toBe("mysql");
  });

  it("C. the snapshot chain links prevId -> previous id, with only the one documented historical break", () => {
    // 0023 shipped as two SQL files (0023_add_episode_sale_mode.sql, which
    // the journal uses, and the orphan 0023_gifted_juggernaut.sql) and its
    // snapshot's prevId points at neither 0022's id nor anything else still
    // in this folder. That break predates IPE-004 - it is present unchanged
    // at this branch's base - and repairing it would mean rewriting committed
    // migration history, which this hotfix deliberately does not do. It is
    // pinned by index so it stays the ONLY tolerated break: any new one,
    // anywhere, fails this test.
    const KNOWN_HISTORICAL_BREAK_AT_IDX = 23;
    const breaks: number[] = [];
    for (let i = 1; i < journal.entries.length; i += 1) {
      const previous = readSnapshot(journal.entries[i - 1].idx);
      const current = readSnapshot(journal.entries[i].idx);
      if (current.prevId !== previous.id) breaks.push(journal.entries[i].idx);
    }
    expect(breaks).toEqual([KNOWN_HISTORICAL_BREAK_AT_IDX]);
  });

  it("D. the newest snapshot is the newest journal entry - nothing is committed past the chain", () => {
    const newest = journal.entries[journal.entries.length - 1];
    const snapshots = fs
      .readdirSync(metaDir)
      .filter((f) => f.endsWith("_snapshot.json"))
      .map((f) => Number.parseInt(f.slice(0, 4), 10))
      .sort((a, b) => a - b);
    expect(snapshots[snapshots.length - 1]).toBe(newest.idx);
    expect(snapshots.length).toBe(journal.entries.length);
  });
});

describe("migration 0039's snapshot describes exactly what 0039's SQL creates", () => {
  const snapshot = readSnapshot(39);
  const sql = fs.readFileSync(
    path.join(drizzleDir, "0039_add_legacy_collision_and_unknown_registry.sql"),
    "utf-8"
  );

  it("C. both legacy-registry tables are in the snapshot", () => {
    for (const table of LEGACY_REGISTRY_TABLES) {
      expect(snapshot.tables[table]?.name).toBe(table);
    }
  });

  it("C. the snapshot carries the collision registry's primary key, uniqueness and lookup index", () => {
    const table = snapshot.tables.paymentSlipLegacyCollisions;
    expect(table.compositePrimaryKeys?.paymentSlipLegacyCollisions_id?.columns).toEqual(["id"]);
    const unique = table.indexes.paymentSlipLegacyCollisions_member_unique;
    expect(unique?.columns).toEqual(["kind", "identifierHash", "sourceType", "sourceId"]);
    expect(unique?.isUnique).toBe(true);
    const lookup = table.indexes.paymentSlipLegacyCollisions_identifierHash_idx;
    expect(lookup?.columns).toEqual(["kind", "identifierHash"]);
    expect(lookup?.isUnique).toBe(false);
  });

  it("C. the snapshot carries the unknown registry's primary key, one-row-per-source uniqueness and lookup index", () => {
    const table = snapshot.tables.paymentSlipLegacyUnknown;
    expect(table.compositePrimaryKeys?.paymentSlipLegacyUnknown_id?.columns).toEqual(["id"]);
    const unique = table.indexes.paymentSlipLegacyUnknown_source_unique;
    expect(unique?.columns).toEqual(["sourceType", "sourceId"]);
    expect(unique?.isUnique).toBe(true);
    const lookup = table.indexes.paymentSlipLegacyUnknown_sourceType_idx;
    expect(lookup?.columns).toEqual(["sourceType"]);
    expect(lookup?.isUnique).toBe(false);
  });

  it("C. every object the snapshot claims is actually created by 0039's SQL", () => {
    for (const table of LEGACY_REGISTRY_TABLES) {
      expect(sql).toContain(`CREATE TABLE \`${table}\``);
    }
    expect(sql).toContain("`paymentSlipLegacyCollisions_member_unique` UNIQUE");
    expect(sql).toContain("`paymentSlipLegacyUnknown_source_unique` UNIQUE");
    expect(sql).toContain("CREATE INDEX `paymentSlipLegacyCollisions_identifierHash_idx`");
    expect(sql).toContain("CREATE INDEX `paymentSlipLegacyUnknown_sourceType_idx`");
  });
});

describe("no migration re-creates the 0039 legacy registry", () => {
  const sqlFiles = fs.readdirSync(drizzleDir).filter((f) => f.endsWith(".sql"));

  it("D. exactly one migration file CREATEs each 0039 table - no duplicate 0040", () => {
    for (const table of LEGACY_REGISTRY_TABLES) {
      const creators = sqlFiles.filter((file) =>
        fs.readFileSync(path.join(drizzleDir, file), "utf-8").includes(`CREATE TABLE \`${table}\``)
      );
      expect(creators).toEqual(["0039_add_legacy_collision_and_unknown_registry.sql"]);
    }
  });

  it("D. exactly one migration file CREATEs each 0039 index", () => {
    for (const index of [
      "paymentSlipLegacyCollisions_identifierHash_idx",
      "paymentSlipLegacyUnknown_sourceType_idx",
    ]) {
      const creators = sqlFiles.filter((file) =>
        fs
          .readFileSync(path.join(drizzleDir, file), "utf-8")
          .includes(`CREATE INDEX \`${index}\``)
      );
      expect(creators).toEqual(["0039_add_legacy_collision_and_unknown_registry.sql"]);
    }
  });
});

/**
 * IPE-003. Migration 0040 added the Advanced Account Merge foundation
 * tables (accountMergeCases, accountMergeAuditLogs) - same phantom-
 * duplicate-migration risk 0039 had (see the describe block above), and
 * the same generic journal/snapshot-completeness checks above already
 * cover its metadata. This block additionally proves 0040 itself creates
 * exactly what it should and nothing was left duplicated by a later
 * migration - the same two-sided proof as the 0039 block, so this file
 * keeps catching a phantom-duplicate regression for whichever migration
 * is newest, not just the one it was first written against.
 */
describe("no migration re-creates the 0040 account-merge foundation", () => {
  const sqlFiles = fs.readdirSync(drizzleDir).filter((f) => f.endsWith(".sql"));
  const ACCOUNT_MERGE_TABLES = ["accountMergeCases", "accountMergeAuditLogs"];

  it("exactly one migration file CREATEs each account-merge table", () => {
    for (const table of ACCOUNT_MERGE_TABLES) {
      const creators = sqlFiles.filter((file) =>
        fs.readFileSync(path.join(drizzleDir, file), "utf-8").includes(`CREATE TABLE \`${table}\``)
      );
      expect(creators).toEqual(["0040_add_account_merge_foundation.sql"]);
    }
  });

  it("0040's snapshot carries both new tables, chained from 0039", () => {
    const s39 = readSnapshot(39);
    const s40 = readSnapshot(40);
    expect(s40.prevId).toBe(s39.id);
    for (const table of ACCOUNT_MERGE_TABLES) {
      expect(s40.tables[table]?.name).toBe(table);
    }
  });
});
