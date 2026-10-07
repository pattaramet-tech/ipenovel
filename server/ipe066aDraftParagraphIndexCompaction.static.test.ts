import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(serverDir, "..");
const schema = readFileSync(path.join(root, "drizzle", "schema.ts"), "utf8");
const migration = readFileSync(
  path.join(root, "drizzle", "0063_workspace_editorial_draft_index_compaction.sql"),
  "utf8"
);
const journal = JSON.parse(
  readFileSync(path.join(root, "drizzle", "meta", "_journal.json"), "utf8")
);

describe("IPE-066A editorial draft paragraph index footprint reduction", () => {
  it("removes only the two global fingerprint indexes from the Drizzle schema", () => {
    expect(schema).not.toContain('index("wedp_fingerprint_idx")');
    expect(schema).not.toContain('index("wedp_source_fingerprint_idx")');
    expect(schema).toContain('uniqueIndex("wedp_draft_order_unique")');
    expect(schema).toContain('uniqueIndex("wedp_draft_paragraph_key_unique")');
    expect(schema).toContain('name: "wedp_draft_tab_fk"');
    expect(schema).toContain('paragraphFingerprint: varchar("paragraphFingerprint", { length: 64 }).notNull()');
    expect(schema).toContain('sourceParagraphFingerprint: varchar("sourceParagraphFingerprint", { length: 64 }).notNull()');
  });

  it("drops both indexes through guarded information_schema checks without deleting or rewriting rows", () => {
    expect(migration).toContain("index_name = 'wedp_fingerprint_idx'");
    expect(migration).toContain("index_name = 'wedp_source_fingerprint_idx'");
    expect(migration).toContain('DROP INDEX `wedp_fingerprint_idx`');
    expect(migration).toContain('DROP INDEX `wedp_source_fingerprint_idx`');
    expect(migration).toMatch(/information_schema\.statistics/g);
    expect(migration).toContain("PREPARE ipe066a_drop_paragraph_fp_idx_stmt");
    expect(migration).toContain("PREPARE ipe066a_drop_source_fp_idx_stmt");
    expect(migration.match(/ALGORITHM=INPLACE, LOCK=NONE/g)).toHaveLength(2);
    expect(migration).not.toMatch(/\bDELETE\b/i);
    expect(migration).not.toMatch(/\bUPDATE\b/i);
    expect(migration).not.toMatch(/OPTIMIZE\s+TABLE/i);
    expect(migration).not.toMatch(/DROP\s+COLUMN/i);
  });

  it("registers migration 0063 as the next journal entry", () => {
    const entry = journal.entries.find(
      (candidate: any) => candidate.tag === "0063_workspace_editorial_draft_index_compaction"
    );
    expect(entry).toBeDefined();
    expect(entry.idx).toBe(63);
    expect(entry.version).toBe("5");
  });
});
