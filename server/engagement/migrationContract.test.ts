/**
 * P2R3B-R8A(+R2) migration contract: proves the engagement schema
 * declarations (server/engagement/tables.ts) and the candidate SQL
 * (drizzle/0068_engagement_foundation.sql) stay consistent, and that the
 * journal registration is exactly one 0068 entry.
 *
 * R2 hardening: the SQL->drizzle column direction is now REAL (the R1
 * regex required unindented column lines, which silently matched nothing),
 * parity/NOT-NULL logic is extracted into pure helpers so negative tests
 * can prove the contract FAILS on genuine drift (ghost SQL column, flipped
 * nullability), and the rating stars CHECK plus its database-version
 * limitation are pinned.
 *
 * This test NEVER touches a database - it is a pure artifact-consistency
 * contract (the engagement counterpart of the notifications
 * migrationContract test pattern).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getTableConfig, MySqlDialect, MySqlTable } from "drizzle-orm/mysql-core";
import { is } from "drizzle-orm";
import * as engagementTables from "./tables";

const REPO_ROOT = join(__dirname, "..", "..");
const SQL_PATH = join(REPO_ROOT, "drizzle", "0068_engagement_foundation.sql");
const JOURNAL_PATH = join(REPO_ROOT, "drizzle", "meta", "_journal.json");

const sql = readFileSync(SQL_PATH, "utf8");
const mysqlDialect = new MySqlDialect();
const journal = JSON.parse(readFileSync(JOURNAL_PATH, "utf8")) as {
  entries: Array<{ idx: number; tag: string }>;
};

interface EngagementTableSpec {
  tableName: string;
  columns: Array<{
    name: string;
    notNull: boolean;
    hasDefault: boolean;
    isEnum: boolean;
    enumValues: string[];
    sqlType: string;
    primary: boolean;
    defaultRaw: unknown;
  }>;
  primaryColumns: string[];
  indexes: Array<{ name: string; unique: boolean; columns: string[] }>;
}

/** Public drizzle API: per-table name, column facts, PK columns and declared indexes. */
function describeEngagementTables(): EngagementTableSpec[] {
  const out: EngagementTableSpec[] = [];
  for (const value of Object.values(engagementTables)) {
    if (!is(value, MySqlTable)) continue;
    const config = getTableConfig(value);
    const columns = Object.values(config.columns).map((c) => {
      const enumColumn = c as unknown as { enumValues?: string[] };
      const sqlTypeRaw = typeof (c as unknown as { getSQLType?: () => string }).getSQLType === "function"
        ? (c as unknown as { getSQLType: () => string }).getSQLType()
        : "";
      return {
        name: c.name,
        notNull: c.notNull,
        hasDefault: c.hasDefault,
        isEnum: Array.isArray(enumColumn.enumValues),
        enumValues: Array.isArray(enumColumn.enumValues) ? enumColumn.enumValues : [],
        sqlType: sqlTypeRaw.toLowerCase().replace(/auto_increment|unsigned/g, "").replace(/\s+/g, "").trim(),
        primary: (c as unknown as { primary?: boolean }).primary === true,
        defaultRaw: (c as unknown as { default?: unknown }).default,
      };
    });
    out.push({
      tableName: config.name,
      columns,
      primaryColumns: columns.filter((c) => c.primary).map((c) => c.name),
      indexes: config.indexes.map((idx) => ({
        name: idx.config.name,
        unique: Boolean(idx.config.unique),
        columns: idx.config.columns.map((c) => c.name),
      })),
    });
  }
  return out;
}

/** tableName -> SQL CREATE TABLE body (statement minus the header line). */
function sqlCreateBlocks(): Map<string, string> {
  const blocks = new Map<string, string>();
  const re = /CREATE TABLE `([a-zA-Z]+)` \(([\s\S]*?)\n\);/g;
  for (const match of sql.matchAll(re)) {
    blocks.set(match[1], match[2]);
  }
  return blocks;
}

/** SQL body -> backticked column definition lines (R2: indentation-tolerant). */
function sqlColumnLines(block: string): Array<{ column: string; line: string }> {
  const out: Array<{ column: string; line: string }> = [];
  for (const line of block.split("\n")) {
    const match = /^[ \t]*`([a-zA-Z]+)`(.*)$/.exec(line);
    if (match && !/KEY/.test(match[2])) {
      out.push({ column: match[1], line: match[0].trim() });
    }
  }
  return out;
}

/** SQL body -> declared KEY/UNIQUE KEY lines (name + column list). */
function sqlIndexLines(block: string): Array<{ name: string; unique: boolean; columns: string[] }> {
  const out: Array<{ name: string; unique: boolean; columns: string[] }> = [];
  for (const line of block.split("\n")) {
    const match = /^[ \t]*(UNIQUE KEY|KEY) `([a-zA-Z0-9_]+)` \(([^)]+)\)/.exec(line);
    if (match) {
      out.push({
        name: match[2],
        unique: match[1] === "UNIQUE KEY",
        columns: match[3].split(",").map((c) => c.trim().replace(/`/g, "")),
      });
    }
  }
  return out;
}

export interface ContractIssue {
  table: string;
  kind:
    | "sql_only_column"
    | "drizzle_only_column"
    | "nullability_mismatch"
    | "default_mismatch"
    | "default_value_mismatch"
    | "type_mismatch"
    | "pk_mismatch"
    | "enum_mismatch"
    | "index_mismatch";
  detail: string;
}

/**
 * Two-way column parity + nullability/default/enum alignment for one
 * table. Pure: returns issues instead of asserting, so negative tests can
 * feed synthetic drifted artifacts.
 */
export function columnContractIssues(
  tableName: string,
  block: string,
  spec: EngagementTableSpec
): ContractIssue[] {
  const issues: ContractIssue[] = [];
  const sqlColumns = sqlColumnLines(block);

  // drizzle -> SQL
  for (const column of spec.columns) {
    const found = sqlColumns.find((c) => c.column === column.name);
    if (!found) {
      issues.push({ table: tableName, kind: "drizzle_only_column", detail: `${column.name} missing from SQL` });
      continue;
    }
    const notNullInSql = /NOT NULL/.test(found.line);
    if (notNullInSql !== column.notNull) {
      issues.push({ table: tableName, kind: "nullability_mismatch", detail: `${column.name}: SQL NOT NULL=${notNullInSql} drizzle notNull=${column.notNull}` });
    }
    const isAutoIncrementId = /AUTO_INCREMENT/.test(found.line);
    const hasDefaultInSql = /DEFAULT /.test(found.line);
    if (!isAutoIncrementId && hasDefaultInSql !== column.hasDefault) {
      issues.push({ table: tableName, kind: "default_mismatch", detail: `${column.name}: SQL DEFAULT=${hasDefaultInSql} drizzle hasDefault=${column.hasDefault}` });
    }
    // R3: DEFAULT VALUE equality (not just presence) + SQL TYPE equality
    if (!isAutoIncrementId && hasDefaultInSql) {
      const sqlDefault = /DEFAULT (CURRENT_TIMESTAMP|'(?:[^']|'')*'|[-0-9.]+)/.exec(found.line)?.[1];
      const drizzleDefault = column.defaultRaw;
      let drizzleDefaultNorm: string;
      if (drizzleDefault !== null && typeof drizzleDefault === "object") {
        // SQL-wrapped default (defaultNow() renders as now() in MySQL):
        // normalize now() to CURRENT_TIMESTAMP so it matches the SQL literal.
        const rendered = mysqlDialect.sqlToQuery(drizzleDefault as any).sql.toLowerCase();
        drizzleDefaultNorm = rendered.includes("now()") ? "CURRENT_TIMESTAMP" : rendered;
      } else if (typeof drizzleDefault === "string") {
        drizzleDefaultNorm = "'" + drizzleDefault + "'";
      } else {
        drizzleDefaultNorm = String(drizzleDefault);
      }
      if (sqlDefault !== drizzleDefaultNorm) {
        issues.push({
          table: tableName,
          kind: "default_value_mismatch",
          detail: `${column.name}: SQL DEFAULT=${sqlDefault} drizzle DEFAULT=${drizzleDefaultNorm}`,
        });
      }
    }
    const sqlType = /^[ \t]*`[a-zA-Z0-9_]+` +([a-zA-Z]+(?:\([^)]*\))?)/.exec(found.line)?.[1];
    const drizzleType = column.sqlType;
    const norm = (t: string) => t.toLowerCase().replace(/auto_increment|unsigned/g, "").replace(/\s+/g, "").trim();
    if (!sqlType || norm(sqlType) !== norm(drizzleType)) {
      issues.push({
        table: tableName,
        kind: "type_mismatch",
        detail: `${column.name}: SQL TYPE=${sqlType ?? "?"} drizzle TYPE=${drizzleType || "?"}`,
      });
    }
    if (column.isEnum) {
      const enumInSql = /enum\(([^)]*)\)/.exec(found.line);
      const sqlValues = enumInSql ? enumInSql[1].split(",").map((v) => v.trim().replace(/'/g, "")) : [];
      if (JSON.stringify(sqlValues) !== JSON.stringify(column.enumValues)) {
        issues.push({ table: tableName, kind: "enum_mismatch", detail: `${column.name}: SQL enum [${sqlValues}] != drizzle [${column.enumValues}]` });
      }
    }
  }

  // SQL -> drizzle (R2: now real, via the indentation-tolerant regex)
  for (const sqlColumn of sqlColumns) {
    if (!spec.columns.some((c) => c.name === sqlColumn.column)) {
      issues.push({ table: tableName, kind: "sql_only_column", detail: `${sqlColumn.column} exists in SQL but not in drizzle` });
    }
  }

  return issues;
}

/** UNIQUE/KEY index name + column-list parity for one table. Pure. */
export function indexContractIssues(
  tableName: string,
  block: string,
  spec: EngagementTableSpec
): ContractIssue[] {
  const issues: ContractIssue[] = [];
  const sqlIndexes = sqlIndexLines(block);
  for (const index of spec.indexes) {
    const found = sqlIndexes.find((i) => i.name === index.name);
    if (!found) {
      issues.push({ table: tableName, kind: "index_mismatch", detail: `${index.name} missing from SQL` });
      continue;
    }
    if (found.unique !== index.unique || JSON.stringify(found.columns) !== JSON.stringify(index.columns)) {
      issues.push({
        table: tableName,
        kind: "index_mismatch",
        detail: `${index.name}: SQL [${found.unique ? "UNIQUE " : ""}${found.columns}] != drizzle [${index.unique ? "UNIQUE " : ""}${index.columns}]`,
      });
    }
  }
  for (const sqlIndex of sqlIndexes) {
    if (!spec.indexes.some((i) => i.name === sqlIndex.name)) {
      issues.push({ table: tableName, kind: "index_mismatch", detail: `${sqlIndex.name} exists in SQL but not in drizzle` });
    }
  }
  return issues;
}

describe("0068_engagement_foundation migration contract", () => {
  it("declares exactly 13 engagement tables and the SQL candidate has exactly 13 CREATE TABLE statements", () => {
    const tables = describeEngagementTables();
    expect(tables).toHaveLength(13);
    const blocks = sqlCreateBlocks();
    expect(blocks.size).toBe(13);
  });

  it("every drizzle table has a matching CREATE TABLE block", () => {
    const blocks = sqlCreateBlocks();
    for (const table of describeEngagementTables()) {
      expect(blocks.has(table.tableName)).toBe(true);
    }
  });

  it("column contract is clean on the real artifacts (two-way, R2 indentation-aware)", () => {
    const blocks = sqlCreateBlocks();
    const allIssues: ContractIssue[] = [];
    for (const table of describeEngagementTables()) {
      allIssues.push(...columnContractIssues(table.tableName, blocks.get(table.tableName)!, table));
    }
    expect(allIssues).toEqual([]);
  });

  it("column contract is clean on the real artifacts including R3 type/default checks", () => {
    const blocks = sqlCreateBlocks();
    const allIssues: ContractIssue[] = [];
    for (const table of describeEngagementTables()) {
      const issues = columnContractIssues(table.tableName, blocks.get(table.tableName)!, table);
      allIssues.push(
        ...issues.filter((i) => i.kind === "type_mismatch" || i.kind === "default_value_mismatch")
      );
    }
    expect(allIssues).toEqual([]);
  });

  it("primary key definitions match between SQL and drizzle (R3)", () => {
    const blocks = sqlCreateBlocks();
    for (const table of describeEngagementTables()) {
      const sqlPk = Array.from(blocks.get(table.tableName)!.matchAll(/PRIMARY KEY \(`([a-zA-Z0-9_]+)`\)/g)).map(
        (m) => m[1]
      );
      expect({ table: table.tableName, sqlPk }).toEqual({
        table: table.tableName,
        sqlPk: table.primaryColumns,
      });
    }
  });

  it("index contract is clean on the real artifacts (names, uniqueness, column lists)", () => {
    const blocks = sqlCreateBlocks();
    const allIssues: ContractIssue[] = [];
    for (const table of describeEngagementTables()) {
      allIssues.push(...indexContractIssues(table.tableName, blocks.get(table.tableName)!, table));
    }
    expect(allIssues).toEqual([]);
  });

  it("SQL declares NOT NULL exactly where drizzle marks notNull (R1, kept)", () => {
    const blocks = sqlCreateBlocks();
    for (const table of describeEngagementTables()) {
      const block = blocks.get(table.tableName)!;
      for (const { line } of sqlColumnLines(block)) {
        const drizzleColumn = table.columns.find((c) => line.includes("`" + c.name + "`"));
        expect({ line, hasSpec: !!drizzleColumn }).toEqual({ line, hasSpec: true });
        const notNullInSql = /NOT NULL/.test(line);
        expect({ line: line.slice(0, 60), notNullInSql, notNullInDrizzle: drizzleColumn!.notNull }).toEqual({
          line: line.slice(0, 60),
          notNullInSql: drizzleColumn!.notNull,
          notNullInDrizzle: drizzleColumn!.notNull,
        });
      }
    }
  });

  it("rating stars carries a 1..5 CHECK constraint in the SQL candidate (R1)", () => {
    expect(sql.includes("novelRatings_stars_range_chk")).toBe(true);
    expect(/CHECK \(`stars` BETWEEN 1 AND 5\)/.test(sql)).toBe(true);
    // DATABASE VERSION LIMITATION: MySQL >= 8.0.16 and MariaDB >= 10.2
    // enforce CHECK constraints; older engines parse but ignore them. The
    // application-level Zod contract (ratingUpsertInput) remains the
    // primary validation in every deployment.
  });

  // ---- R2 negative tests: the contract must FAIL on genuine drift ----

  it("NEGATIVE: a SQL-only ghost column is detected by the two-way contract", () => {
    const blocks = sqlCreateBlocks();
    const block = blocks.get("engagementFeedback")!;
    const drifted = block.replace(
      /(\n  `status` enum[^\n]*)/,
      "$1\n  `ghostCol` int NULL,"
    );
    const spec = describeEngagementTables().find((t) => t.tableName === "engagementFeedback")!;
    const issues = columnContractIssues("engagementFeedback", drifted, spec);
    expect(issues.some((i) => i.kind === "sql_only_column" && i.detail.includes("ghostCol"))).toBe(true);
  });

  it("NEGATIVE: a drizzle-only column (SQL missing it) is detected", () => {
    const blocks = sqlCreateBlocks();
    const block = blocks.get("engagementFeedback")!;
    const drifted = block.replace(/,\n  `message` text NOT NULL/, "");
    const spec = describeEngagementTables().find((t) => t.tableName === "engagementFeedback")!;
    const issues = columnContractIssues("engagementFeedback", drifted, spec);
    expect(issues.some((i) => i.kind === "drizzle_only_column" && i.detail.includes("message"))).toBe(true);
  });

  it("NEGATIVE: flipped nullability is detected as a mismatch", () => {
    const blocks = sqlCreateBlocks();
    const block = blocks.get("engagementFeedback")!;
    const drifted = block.replace("`subject` varchar(160) NOT NULL", "`subject` varchar(160) NULL");
    const spec = describeEngagementTables().find((t) => t.tableName === "engagementFeedback")!;
    const issues = columnContractIssues("engagementFeedback", drifted, spec);
    expect(issues.some((i) => i.kind === "nullability_mismatch" && i.detail.includes("subject"))).toBe(true);
  });

  it("NEGATIVE: enum value drift is detected", () => {
    const blocks = sqlCreateBlocks();
    const block = blocks.get("engagementFeedback")!;
    const drifted = block.replace(
      "enum('bug','suggestion','usability','other')",
      "enum('bug','suggestion','usability')"
    );
    const spec = describeEngagementTables().find((t) => t.tableName === "engagementFeedback")!;
    const issues = columnContractIssues("engagementFeedback", drifted, spec);
    expect(issues.some((i) => i.kind === "enum_mismatch" && i.detail.includes("category"))).toBe(true);
  });

  it("NEGATIVE: an index removed from SQL is detected", () => {
    const blocks = sqlCreateBlocks();
    const block = blocks.get("novelRatings")!;
    const drifted = block.replace(/,\n  UNIQUE KEY `novelRatings_user_novel_uq` \(`userId`, `novelId`\)/, "");
    const spec = describeEngagementTables().find((t) => t.tableName === "novelRatings")!;
    const issues = indexContractIssues("novelRatings", drifted, spec);
    expect(issues.some((i) => i.detail.includes("novelRatings_user_novel_uq"))).toBe(true);
  });

  it("NEGATIVE: DEFAULT value drift is detected (R3)", () => {
    const blocks = sqlCreateBlocks();
    const block = blocks.get("engagementFeedback")!;
    const drifted = block.replace("DEFAULT 'bug'", "DEFAULT 'other'");
    const spec = describeEngagementTables().find((t) => t.tableName === "engagementFeedback")!;
    const issues = columnContractIssues("engagementFeedback", drifted, spec);
    expect(issues.some((i) => i.kind === "default_value_mismatch" && i.detail.includes("category"))).toBe(true);
  });

  it("NEGATIVE: SQL type drift is detected (R3)", () => {
    const blocks = sqlCreateBlocks();
    const block = blocks.get("engagementFeedback")!;
    const drifted = block.replace("`subject` varchar(160) NOT NULL", "`subject` varchar(200) NOT NULL");
    const spec = describeEngagementTables().find((t) => t.tableName === "engagementFeedback")!;
    const issues = columnContractIssues("engagementFeedback", drifted, spec);
    expect(issues.some((i) => i.kind === "type_mismatch" && i.detail.includes("subject"))).toBe(true);
  });

  it("NEGATIVE: primary key drift is detected (R3)", () => {
    const blocks = sqlCreateBlocks();
    const block = blocks.get("engagementFeedback")!;
    const drifted = block.replace(
      "PRIMARY KEY (`id`)",
      "PRIMARY KEY (`userId`)"
    );
    const sqlPk = Array.from(drifted.matchAll(/PRIMARY KEY \(`([a-zA-Z0-9_]+)`\)/g)).map((m) => m[1]);
    const spec = describeEngagementTables().find((t) => t.tableName === "engagementFeedback")!;
    expect({ sqlPk, drizzlePk: spec.primaryColumns }).toEqual({
      sqlPk: ["userId"],
      drizzlePk: ["id"],
    });
  });

  it("journal registers exactly one 0068 entry directly after 0067", () => {
    const tags = journal.entries.map((e) => e.tag);
    expect(tags.at(-1)).toBe("0068_engagement_foundation");
    expect(tags.at(-2)).toBe("0067_notifications_engagement");
    expect(journal.entries.filter((e) => e.tag === "0068_engagement_foundation")).toHaveLength(1);
    const last = journal.entries.at(-1)!;
    expect(last.idx).toBe(68);
  });
});
