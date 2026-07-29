import { describe, it, expect } from "vitest";
import { drizzle } from "drizzle-orm/mysql2";
import { sql } from "drizzle-orm";
import { episodes } from "../../drizzle/schema";
import { buildEpisodeLevelPredicate } from "./hybridHealthQueries";

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
