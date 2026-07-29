import { describe, it, expect } from "vitest";
import { drizzle } from "drizzle-orm/mysql2";
import { sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { episodes } from "../../drizzle/schema";
import {
  buildEpisodeLevelPredicate,
  buildCandidateWhereClause,
  buildCandidateNovelIdsQuery,
  buildAggregatesForNovelIdsQuery,
  buildSummaryBatchQuery,
  type HybridHealthOverviewQueryParams,
} from "./hybridHealthQueries";

/**
 * Static SQL-shape tests for buildEpisodeLevelPredicate() - the fix for a
 * cross-row false positive review finding: status/saleMode/purchasedOnly
 * used to become three INDEPENDENT aggregate HAVING conditions (each true
 * for a different episode), so a novel could pass a filter combination no
 * single episode actually satisfied (e.g. a LEGACY_ONLY chapter + an
 * unrelated MISSING_BOTH package would pass status=legacy_only +
 * saleMode=package). This asserts the generated SQL combines every active
 * filter into ONE conjunction, evaluable against a single episode row.
 *
 * Uses a throwaway drizzle instance purely to render `.toSQL()` text - the
 * connection string is never dialed (toSQL() does no network I/O), so this
 * needs no database and belongs in the unit project.
 */
const db = drizzle("mysql://user:pass@localhost:3306/db", { mode: "default" });

function renderPredicate(predicate: ReturnType<typeof buildEpisodeLevelPredicate>) {
  if (!predicate) return null;
  return db.select({ x: sql`1` }).from(episodes).where(predicate).toSQL();
}

describe("buildEpisodeLevelPredicate", () => {
  it("returns null when no filter is active (status=all, saleMode=all, purchasedOnly=false)", () => {
    expect(buildEpisodeLevelPredicate({ status: "all", saleMode: "all", purchasedOnly: false })).toBeNull();
  });

  it("legacy_only + package combines BOTH conditions into one AND'd predicate, not two independent ones", () => {
    const predicate = buildEpisodeLevelPredicate({ status: "legacy_only", saleMode: "package", purchasedOnly: false });
    const { sql: text, params } = renderPredicate(predicate)!;

    // Both the content-status condition and the saleMode condition must
    // appear in a SINGLE where clause (joined by "and"), so a matching row
    // has to satisfy both at once - not two separately-true aggregates.
    expect(text).toContain("TRIM(COALESCE(");
    expect(text).toContain("`saleMode` = ?");
    expect(text).toMatch(/where\s*\(.*and.*\)/i);
    expect(params).toEqual(["package"]);
  });

  it("has_plaintext + package looks for a plaintext-having package episode, not packageMissingPlaintextCount", () => {
    const predicate = buildEpisodeLevelPredicate({ status: "has_plaintext", saleMode: "package", purchasedOnly: false });
    const { sql: text, params } = renderPredicate(predicate)!;

    // Must assert TRIM(...) <> '' is true (has plaintext), never "NOT" it -
    // the old bug reused the *missing*-plaintext package count for this case.
    expect(text).not.toMatch(/not\s*\(?\s*trim/i);
    expect(text).toContain("<> ''");
    expect(params).toEqual(["package"]);
  });

  it("purchasedOnly combines with status and saleMode in the same predicate", () => {
    const predicate = buildEpisodeLevelPredicate({ status: "missing_plaintext", saleMode: "chapter", purchasedOnly: true });
    const { sql: text, params } = renderPredicate(predicate)!;

    expect(text).toContain("EXISTS");
    expect(text).toContain("`saleMode` = ?");
    expect(text).toContain("TRIM(COALESCE(");
    expect(params).toEqual(["chapter"]);
  });

  it("saleMode=package alone (status=all) only constrains saleMode", () => {
    const predicate = buildEpisodeLevelPredicate({ status: "all", saleMode: "package", purchasedOnly: false });
    const { sql: text, params } = renderPredicate(predicate)!;

    expect(text).toContain("`saleMode` = ?");
    expect(text).not.toContain("TRIM(COALESCE(");
    expect(params).toEqual(["package"]);
  });

  it("status=missing_both alone (saleMode=all) only constrains content status", () => {
    const predicate = buildEpisodeLevelPredicate({ status: "missing_both", saleMode: "all", purchasedOnly: false });
    const { sql: text } = renderPredicate(predicate)!;

    expect(text).toContain("TRIM(COALESCE(");
    expect(text).not.toContain("`saleMode` = ?");
    expect(text).not.toContain("EXISTS");
  });

  it("purchasedOnly alone activates a predicate (not null)", () => {
    const predicate = buildEpisodeLevelPredicate({ status: "all", saleMode: "all", purchasedOnly: true });
    expect(predicate).not.toBeNull();
    const { sql: text } = renderPredicate(predicate)!;
    expect(text).toContain("EXISTS");
  });
});

/**
 * Hotfix (TiDB errno=8176 memory-limit incident) static SQL-shape tests:
 * the page-first Overview redesign. These assert the candidate-novel query
 * is a plain SELECT with an EXISTS semi-join and LIMIT/OFFSET - never a
 * GROUP BY/aggregate over the whole `episodes` table - and that the
 * page-scoped aggregate query is bounded by `novels.id IN (...)`, and the
 * summary batch query is keyset-paginated (`episodes.id > cursor`), not
 * OFFSET-paginated.
 */
function baseOverviewParams(overrides: Partial<HybridHealthOverviewQueryParams> = {}): HybridHealthOverviewQueryParams {
  return {
    page: 1,
    pageSize: 50,
    status: "missing_plaintext",
    publicationStatus: "all",
    saleMode: "all",
    purchasedOnly: false,
    sortBy: "novelId",
    sortOrder: "desc",
    ...overrides,
  };
}

describe("buildCandidateWhereClause", () => {
  it("with no active filters returns undefined (no WHERE at all - a zero-episode novel must still be a candidate)", () => {
    const clause = buildCandidateWhereClause(baseOverviewParams({ status: "all" }));
    expect(clause).toBeUndefined();
  });

  it("status filter becomes a correlated EXISTS against episodes, not a GROUP BY", () => {
    const clause = buildCandidateWhereClause(baseOverviewParams({ status: "missing_plaintext" }));
    expect(clause).toBeDefined();
    const { sql: text } = db.select({ x: sql`1` }).from(episodes).where(clause!).toSQL();
    expect(text).toContain("EXISTS");
    expect(text).not.toMatch(/group by/i);
  });
});

describe("buildCandidateNovelIdsQuery (Overview step A)", () => {
  it("is a plain SELECT with LIMIT/OFFSET and no GROUP BY/aggregate function anywhere", () => {
    const { sql: text, params } = buildCandidateNovelIdsQuery(db, baseOverviewParams({ page: 2, pageSize: 50 })).toSQL();
    expect(text).not.toMatch(/group by/i);
    expect(text).not.toMatch(/sum\(/i);
    expect(text).toMatch(/limit\s*\?/i);
    expect(text).toMatch(/offset\s*\?/i);
    expect(params).toContain(50); // limit
    expect(params).toContain(50); // offset for page 2 at pageSize 50
  });

  it("includes the EXISTS semi-join when an episode-level filter is active", () => {
    const { sql: text } = buildCandidateNovelIdsQuery(db, baseOverviewParams({ status: "legacy_only" })).toSQL();
    expect(text).toContain("EXISTS");
  });

  it("sorts only by title or novelId - never by an aggregate expression", () => {
    const byTitle = buildCandidateNovelIdsQuery(db, baseOverviewParams({ sortBy: "title", sortOrder: "asc" })).toSQL();
    expect(byTitle.sql).toMatch(/order by `novels`\.`title`/i);

    const byId = buildCandidateNovelIdsQuery(db, baseOverviewParams({ sortBy: "novelId", sortOrder: "desc" })).toSQL();
    expect(byId.sql).toMatch(/order by `novels`\.`id`/i);
  });
});

describe("buildAggregatesForNovelIdsQuery (Overview step C)", () => {
  it("scopes the GROUP BY to WHERE novels.id IN (...) - never a full-table aggregate", () => {
    const { sql: text, params } = buildAggregatesForNovelIdsQuery(db, [1, 2, 3]).toSQL();
    expect(text).toMatch(/group by/i);
    expect(text).toMatch(/`novels`\.`id` in \(\?, \?, \?\)/i);
    expect(params).toEqual([1, 2, 3]);
  });
});

describe("buildSummaryBatchQuery", () => {
  it("is keyset-paginated by episodes.id (cursor), never OFFSET", () => {
    const { sql: text, params } = buildSummaryBatchQuery(db, 12345, 250).toSQL();
    expect(text).toMatch(/`episodes`\.`id` > \?/i);
    expect(text).toMatch(/order by `episodes`\.`id` asc/i);
    expect(text).not.toMatch(/offset/i);
    expect(text).toMatch(/limit\s*\?/i);
    expect(params).toEqual([12345, 250]);
  });

  it("clamps batchSize to the documented max", () => {
    const { params } = buildSummaryBatchQuery(db, 0, 999999).toSQL();
    expect(params[1]).toBeLessThanOrEqual(500);
  });

  it("never selects content or fileUrl as a raw column", () => {
    const { sql: text } = buildSummaryBatchQuery(db, 0, 250).toSQL();
    expect(text).not.toMatch(/select `content`|`episodes`\.`content`(?!.*trim)/i);
    expect(text).not.toMatch(/select .*`fileUrl`[^)]*from/i);
  });
});

/**
 * Regression guard against the exact anti-pattern a direct Manus push to
 * `main` reintroduced (independent of this PR, based on the pre-hotfix
 * PR #21 code): a `queryHybridHealthNovelOverview()` that loaded EVERY
 * matching novel's row (`allNovelRows`) regardless of page, ran episode
 * aggregation in `BATCH_SIZE = 30` chunks across the WHOLE filtered
 * catalog (not just the current page), filtered by `status` only - in
 * JavaScript, after the fact, silently ignoring `saleMode`/`purchasedOnly` -
 * and only paginated at the very end. Merging that branch into this one
 * discarded it entirely in favor of this file's page-first design, but a
 * future edit could plausibly reintroduce a similar shape without anyone
 * noticing purely from behavioral tests, since JS-side batching still
 * "works" - it's just unbounded. These assertions make that regression
 * fail immediately and loudly.
 */
describe("regression guard: no full-catalog aggregation, no in-memory filtering", () => {
  const querySource = readFileSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "hybridHealthQueries.ts"),
    "utf8"
  );

  it("has no allNovelRows-style full-catalog load", () => {
    expect(querySource).not.toMatch(/allNovelRows/);
  });

  it("has no BATCH_SIZE constant looping over the whole filtered catalog", () => {
    expect(querySource).not.toMatch(/BATCH_SIZE\s*=\s*30/);
    expect(querySource).not.toMatch(/for\s*\(.*i\s*\+=\s*BATCH_SIZE/);
  });

  it("does not filter by status/saleMode/purchasedOnly in memory (Array.prototype.filter over merged novel rows)", () => {
    expect(querySource).not.toMatch(/mergedNovels/);
    expect(querySource).not.toMatch(/\.filter\(\(novel/i);
  });

  it("does not sort in memory by an aggregate count (JS Array.sort over novel rows)", () => {
    expect(querySource).not.toMatch(/mergedNovels\.sort/);
  });

  it("the old queryHybridHealthNovelOverview()/queryHybridHealthGlobalSummary() functions are gone - not just renamed", () => {
    expect(querySource).not.toMatch(/export\s+(async\s+)?function\s+queryHybridHealthNovelOverview/);
    expect(querySource).not.toMatch(/export\s+(async\s+)?function\s+queryHybridHealthGlobalSummary/);
  });

  it("pagination is applied by the database (LIMIT/OFFSET on the candidate query), never by Array.slice after aggregating everything", () => {
    // .slice( still appears legitimately (e.g. episodeNumber trimming
    // elsewhere in the codebase's other files), but not in THIS file, where
    // pagination must come from SQL LIMIT/OFFSET only.
    expect(querySource).not.toMatch(/\.slice\(offset/);
  });
});
