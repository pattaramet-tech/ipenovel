import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { getTableName } from "drizzle-orm";
import { getTableConfig, type AnyMySqlTable } from "drizzle-orm/mysql-core";
import { sessionSlots, readingLeases } from "../drizzle/schema";

/**
 * R4/IR-05 — FK metadata parity: drizzle/schema.ts metadata for sessionSlots
 * and readingLeases must declare the SAME foreign keys that
 * drizzle/0066_reader_session_controls.sql created (name, columns, target,
 * ON DELETE). Metadata only — the migration is never executed.
 */

type Row = { name: string; from: string; toTable: string; toColumn: string; onDelete: string };

function fkRows(table: AnyMySqlTable): Row[] {
  const cfg = getTableConfig(table);
  return cfg.foreignKeys.map(fk => {
    const ref = (fk as unknown as {
      reference(): {
        name: string;
        columns: Array<{ name: string }>;
        foreignColumns: Array<{ name: string }>;
      };
    }).reference();
    const onDelete = (fk as unknown as { onDelete?: string }).onDelete ?? "no action";
    const foreignColumn = ref.foreignColumns[0] as unknown as { name: string; table: unknown };
    return {
      name: ref.name,
      from: ref.columns.map(c => c.name).join(","),
      toTable: getTableName(foreignColumn.table as Parameters<typeof getTableName>[0]),
      toColumn: ref.foreignColumns.map(c => c.name).join(","),
      onDelete,
    };
  });
}

function sqlConstraints(sqlText: string): Row[] {
  const rows: Row[] = [];
  const re = /CONSTRAINT `([^`]+)` FOREIGN KEY \(`([^`]+)`\) REFERENCES `([^`]+)` \(`([^`]+)`\)(?: ON DELETE ([A-Z]+))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sqlText))) {
    rows.push({
      name: m[1],
      from: m[2],
      toTable: m[3],
      toColumn: m[4],
      onDelete: (m[5] ?? "NO ACTION").toLowerCase(),
    });
  }
  return rows;
}

describe("R4/IR-05 — FK metadata parity with 0066 SQL", () => {
  const sqlText = readFileSync("drizzle/0066_reader_session_controls.sql", "utf8");
  const sqlFks = sqlConstraints(sqlText);
  const expected = [
    { name: "session_slots_user_fk", from: "userId", toTable: "users", toColumn: "id", onDelete: "cascade" },
    { name: "reading_leases_user_fk", from: "userId", toTable: "users", toColumn: "id", onDelete: "cascade" },
    { name: "reading_leases_session_fk", from: "holderSessionId", toTable: "authSessions", toColumn: "id", onDelete: "cascade" },
  ];

  it("0066 declares exactly the three expected constraints", () => {
    for (const e of expected) {
      expect(sqlFks).toContainEqual(e);
    }
  });

  it("sessionSlots metadata declares session_slots_user_fk → users.id CASCADE", () => {
    const rows = fkRows(sessionSlots);
    expect(rows).toContainEqual(expected[0]);
  });

  it("readingLeases metadata declares user_fk + session_fk exactly as 0066", () => {
    const rows = fkRows(readingLeases);
    expect(rows).toContainEqual(expected[1]);
    expect(rows).toContainEqual(expected[2]);
  });
});
