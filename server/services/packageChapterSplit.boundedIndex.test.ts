import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import {
  EPISODE_NUMBER_LONG_TOKEN_SQL_PATTERN,
  SALE_MODE_RANGE_SQL_PATTERN,
  episodeNumberKeysetSqlCondition,
  episodeNumberTokenSqlPattern,
} from "./packageChapterSplit.service";
import { RANGE_EPISODE_NUMBER_PATTERN, normalizeEpisodeRange } from "./readerService";

/**
 * IPE-R4R3 regression: the bounded inventory loader classifies existing
 * chapters by matching SQL-fetched candidate rows against the JS
 * normalizer. The SQL predicate is a DELIBERATE superset (see
 * episodeNumberTokenSqlPattern), so the load stays bounded without a
 * positional LIMIT that could hide a duplicate/conflict. These tests pin
 * the two properties that make that safe, evaluated with a JS RegExp -
 * the pattern uses only constructs (ASCII classes, groups, anchors) whose
 * meaning is identical under MySQL 8's ICU REGEXP, which the integration
 * suite then exercises end to end.
 */

/** Every raw variant here MUST normalize to its key, so the pattern MUST match it. */
const MUST_MATCH: Array<[string, string[]]> = [
  ["5", ["5", "05", "005", "5.0", "5.00", "005.000", " 5 ", "#5", "##5", "บทที่ 5", "ตอนที่5", "Chapter 5", "EP 5", "ep5", "x5y", "5abc", "5-", "abc-5-def", "-5", "5."]],
  ["0", ["0", "00", "0.0", "000.00", "บทที่ 0"]],
  ["1", ["1", "01", "1.0", "บทที่ 1", "0.99999999999999999", "0.999999999999999999", "0.999999999999999999999", "1.00000000000000000001"]],
  ["2", ["2", "02", "2.0", "1.99999999999999999", "2.0000000000000001"]],
  ["0.5", ["0.5", "00.5", "0.50", "0.500", "0.50000000000000001"]],
  ["12", ["12", "012", "12.0", "Chapter 12"]],
  ["5.5", ["5.5", "05.5", "5.50", "05.50", "บทที่ 5.5", "5.50000000000000001"]],
  ["51", ["51", "051", "51.0"]],
  ["100", ["100", "0100", "100.00", "#100"]],
  // Near-boundary SAFE side: <= 15 significant digits round-trip to their
  // own digits, so these keys are found through the exact-digit arm.
  ["0.99999999999999", ["0.99999999999999"]],
  ["0.999999999999999", ["0.999999999999999"]],
  ["0.9999999999999999", ["0.9999999999999999", "00.9999999999999999", "0.99999999999999990"]],
];

/** Lookalikes that normalize differently: not matching keeps the read bounded. */
const MUST_NOT_MATCH: Array<[string, string[]]> = [
  ["5", ["15", "50", "55", "055", "555", "12345", " 15 "]],
  ["5.5", ["5.55", "15.5", "5.6", "0.55"]],
  ["12", ["112", "120", "212", "123"]],
];

/** The SQL candidate contract for one key: exact-digit arm OR the rounding net. */
function matchesKey(key: string, raw: string): boolean {
  const pattern = episodeNumberTokenSqlPattern(key);
  if (pattern && new RegExp(pattern).test(raw)) return true;
  return new RegExp(EPISODE_NUMBER_LONG_TOKEN_SQL_PATTERN).test(raw);
}

describe("episodeNumberTokenSqlPattern + rounding net (bounded inventory superset)", () => {
  it("matches every raw string that normalizeEpisodeRange maps to the key - a false negative here would silently miss a conflict", () => {
    for (const [key, variants] of MUST_MATCH) {
      expect(episodeNumberTokenSqlPattern(key), `key ${key} must produce a pattern`).not.toBeNull();
      for (const raw of variants) {
        expect(normalizeEpisodeRange(raw), `raw "${raw}" normalizes to key "${key}"`).toBe(key);
        expect(matchesKey(key, raw), `SQL candidate condition for key "${key}" must match raw "${raw}"`).toBe(true);
      }
    }
  });

  it("rejects lookalike numbers so the superset fetch stays small", () => {
    for (const [key, variants] of MUST_NOT_MATCH) {
      for (const raw of variants) {
        expect(normalizeEpisodeRange(raw), `raw "${raw}" must NOT normalize to key "${key}"`).not.toBe(key);
        expect(matchesKey(key, raw), `SQL candidate condition for key "${key}" must reject raw "${raw}"`).toBe(false);
      }
    }
  });

  it("returns null instead of an unsafe pattern for canonical forms no raw digit string can supersede", () => {
    // String(1e21) / String(1e-7) from absurd heading digits, and non-numeric
    // garbage: callers fall back to the novel-wide read (correctness first)
    // instead of running a pattern that could miss rows.
    expect(episodeNumberTokenSqlPattern("1e+21")).toBeNull();
    expect(episodeNumberTokenSqlPattern("1e-7")).toBeNull();
    expect(episodeNumberTokenSqlPattern("NaN")).toBeNull();
    expect(episodeNumberTokenSqlPattern("")).toBeNull();
    expect(episodeNumberTokenSqlPattern("Infinity")).toBeNull();
    expect(episodeNumberTokenSqlPattern("1e+20")).toBeNull();
  });
});

/**
 * IPE-R4R3R3: the SQL legacy-range predicate must accept EVERY string the
 * JS resolveSaleMode() fallback accepts. The engines diverge on whitespace:
 * ECMAScript \s matches U+FEFF (BOM/ZWNBSP) while ICU's Unicode
 * White_Space does not, and ICU additionally matches U+0085 which JS \s
 * does not. The SQL class enumerates the exact JS set plus U+0085 as a
 * harmless (JS-refined) margin, so the only safe direction - superset -
 * is pinned here against the REAL JS regex (imported, never re-implemented).
 */
describe("SALE_MODE_RANGE_SQL_PATTERN vs resolveSaleMode legacy arm (IPE-R4R3R3)", () => {
  // ECMAScript \s members plus the ICU-margin/extra chars; the property
  // only asserts when the JS regex accepts, so extra chars are free.
  const WHITESPACE_CHARS = [
    "\t", "\n", "\v", "\f", "\r", " ",
    "\u00a0", // NBSP - both engines agree
    "\u1680", "\u2000", "\u2005", "\u200a", "\u2028", "\u2029", "\u202f", "\u205f", "\u3000",
    "\ufeff", // BOM/ZWNBSP - JS \s YES, ICU White_Space NO (the divergence)
    "\u0085", // NEL - ICU White_Space YES, JS \s no (margin, over-fetch only)
    "\u180e", "\u200b", // neither engine's whitespace: JS must reject
  ];
  const NUMBERS = ["3", "03", "3.5", "03.50", "10"];

  it("accepts every string the JS legacy-range regex accepts (no false negative)", () => {
    const sqlRegExp = new RegExp(SALE_MODE_RANGE_SQL_PATTERN);
    let jsAccepted = 0;
    for (const w of WHITESPACE_CHARS) {
      for (const a of NUMBERS) {
        for (const b of NUMBERS) {
          // every whitespace slot the JS regex has: lead, both mid gaps, trail
          const raws = [
            `${w}${a} - ${b}`,
            `${a}${w}-${b}`,
            `${a} -${w}${b}`,
            `${a} - ${b}${w}`,
            `${w}${a}${w}-${w}${b}${w}`,
          ];
          for (const raw of raws) {
            if (!RANGE_EPISODE_NUMBER_PATTERN.test(raw)) continue; // margin chars: JS rejects, SQL may over-fetch
            jsAccepted += 1;
            expect(sqlRegExp.test(raw), `SQL legacy predicate must match ${JSON.stringify(raw)}`).toBe(true);
          }
        }
      }
    }
    expect(jsAccepted).toBeGreaterThan(500);
  });

  it("BOM (U+FEFF) specifically: accepted by JS, must be accepted by SQL even though ICU White_Space rejects it", () => {
    for (const raw of ["\uFEFF3 - 7", "3\uFEFF-\uFEFF7", "3 - 7\uFEFF", "\uFEFF\uFEFF03.5 - 7\uFEFF"]) {
      expect(RANGE_EPISODE_NUMBER_PATTERN.test(raw), `JS accepts ${JSON.stringify(raw)}`).toBe(true);
      expect(new RegExp(SALE_MODE_RANGE_SQL_PATTERN).test(raw), `SQL accepts ${JSON.stringify(raw)}`).toBe(true);
    }
  });

  it("keeps rejecting structurally invalid strings JS rejects too (digits required around '-')", () => {
    for (const raw of ["-", " - ", "3-", "-7", "3 - seven", "3 - 7 (special)"]) {
      expect(RANGE_EPISODE_NUMBER_PATTERN.test(raw), `JS rejects ${JSON.stringify(raw)}`).toBe(false);
      expect(new RegExp(SALE_MODE_RANGE_SQL_PATTERN).test(raw)).toBe(false);
    }
  });
});

/**
 * IPE-R4R3R6: the keyset candidate condition hoists the rounding net
 * (EPISODE_NUMBER_LONG_TOKEN_SQL_PATTERN, 653 chars) from once per key to
 * at most once per query. (E1 OR NET) OR ... OR (EN OR NET) ===
 * NET OR E1 OR ... OR EN - pure OR flattening, so the matched row set
 * cannot change. These tests pin BOTH halves of that claim: the SQL shape
 * (rendered through drizzle's real MySQL dialect via sqlToQuery - no
 * database involved) and the row-level equivalence of the old per-key
 * composition versus the hoisted one, evaluated over a corpus that
 * includes the rounding-net forms, range keys, digit-free labels, mixed
 * keysets and the exponential-fallback form. The patterns are valid in
 * both JS RegExp and MySQL 8 REGEXP by contract (see
 * episodeNumberTokenSqlPattern's docstring); MySQL execution itself is
 * exercised end to end by the disposable-DB integration suite.
 */
describe("episodeNumberKeysetSqlCondition - NET hoist shape + equivalence (IPE-R4R3R6)", () => {
  const dialect = new MySqlDialect();

  function shape(condition: any) {
    const { sql: text, params } = dialect.sqlToQuery(condition);
    return {
      regexpPredicates: (text.match(/regexp/gi) || []).length,
      sqlParameters: params.length,
      netCopies: params.filter((p) => p === EPISODE_NUMBER_LONG_TOKEN_SQL_PATTERN).length,
      lengthChars: text.length,
    };
  }

  it("numeric keysets of 1/10/100/1000 keys carry the NET exactly once (never per key)", () => {
    for (const n of [1, 10, 100, 1000]) {
      const keyset = episodeNumberKeysetSqlCondition(
        Array.from({ length: n }, (_, i) => String(i + 1))
      );
      expect(keyset.fallbackToNovelWide, `${n} keys must bind`).toBe(false);
      const s = shape(keyset.condition);
      expect(s.netCopies, `${n} keys: NET copies must be 1`).toBe(1);
      // N exact-digit arms + 1 hoisted NET.
      expect(s.regexpPredicates, `${n} keys: REGEXP predicates`).toBe(n + 1);
      expect(s.sqlParameters, `${n} keys: bound parameters`).toBe(n + 1);
    }
  });

  it("range key ANDs its endpoint exact arms plus one NET", () => {
    const s = shape(episodeNumberKeysetSqlCondition(["51 - 100"]).condition);
    expect(s.netCopies).toBe(1);
    expect(s.regexpPredicates).toBe(3); // 2 endpoint exacts (ANDed) + 1 NET
    expect(s.sqlParameters).toBe(3);
  });

  it("pure digit-free keyset carries NO NET arm (unchanged contract)", () => {
    const s = shape(episodeNumberKeysetSqlCondition(["ตอนพิเศษ"]).condition);
    expect(s.netCopies).toBe(0);
    expect(s.regexpPredicates).toBe(1); // NOT REGEXP "[0-9]"
  });

  it("mixed numeric + digit-free keyset hoists the NET exactly once", () => {
    const s = shape(episodeNumberKeysetSqlCondition(["5", "ตอนพิเศษ", "12 - 20"]).condition);
    expect(s.netCopies).toBe(1);
    // 1 (numeric exact) + 1 (digit-free NOT REGEXP) + 2 (range endpoints) + 1 NET
    expect(s.regexpPredicates).toBe(5);
  });

  it("exponential-form canonical key still falls back to the novel-wide read", () => {
    const keyset = episodeNumberKeysetSqlCondition(["1e+21"]);
    expect(keyset.fallbackToNovelWide).toBe(true);
    expect(keyset.condition).toBeNull();
  });

  /**
   * Row-level equivalence: evaluates the OLD per-key composition
   * ((E1 OR NET) OR ... OR (EN OR NET), NET only on numeric keys) against
   * the NEW hoisted one ((NET)? OR E1 OR ... OR EN) for every corpus row,
   * where endpoint/net arms run as JS RegExp (dual-engine by contract).
   */
  function evaluateBothCompositions(keyset: string[], raw: string): { old: boolean; now: boolean; fallback: boolean } {
    const netMatch = new RegExp(EPISODE_NUMBER_LONG_TOKEN_SQL_PATTERN).test(raw);
    let anyNumeric = false;
    let fallback = false;
    let oldMatch = false;
    let endpointMatchAny = false;
    for (const key of keyset) {
      const parts = key.includes(" - ") ? key.split(" - ") : [key];
      const arms = parts.map((part) => {
        const pattern = episodeNumberTokenSqlPattern(part);
        if (pattern) return { numeric: true, matches: () => new RegExp(pattern).test(raw) };
        if (/\d/.test(part)) return { numeric: true, unsafe: true as const };
        // digit-free endpoint arm: NOT REGEXP "[0-9]"
        return { numeric: false, matches: () => !/[0-9]/.test(raw) };
      });
      if (arms.some((arm) => "unsafe" in arm)) {
        fallback = true; // novel-wide read on BOTH sides - matches everything
        continue;
      }
      const allNumeric = arms.every((arm) => arm.numeric);
      const endpointsMatch = arms.every((arm) => arm.matches());
      if (allNumeric) anyNumeric = true;
      if (endpointsMatch) endpointMatchAny = true;
      // OLD: numeric key -> endpoints OR NET; digit-free key -> endpoints only.
      if (allNumeric ? endpointsMatch || netMatch : endpointsMatch) oldMatch = true;
    }
    const nowMatch = (anyNumeric && netMatch) || endpointMatchAny;
    return { old: fallback ? true : oldMatch, now: fallback ? true : nowMatch, fallback };
  }

  const CORPUS = [
    "5", "05", "005.000", "5.0", "5.00", "15", "50", "1.5", "5.5", "5.55",
    "0.5", "0.99999999999999999", "0.50000000000000001", "123456789012345.6",
    "12345678901234567890", "0950", "950", "100", "0100", "1", "0",
    "1 - 5", "51 - 100", "9 - 10", "\uFEFF906 - 908\uFEFF",
    "\u00A04\u00A0-\u00A08", "\u202F2\u202F-\u202F9", "\u00A0700 - 702\u00A0",
    "ตอนพิเศษ", "ตอนที่ 5", "x5y", "-5", "5-", "", "1e+21", "NaN",
  ];

  const KEYSETS: Array<{ label: string; keys: string[] }> = [
    { label: "numeric 1..50", keys: Array.from({ length: 50 }, (_, i) => String(i + 1)) },
    { label: "numeric 941..1000", keys: Array.from({ length: 60 }, (_, i) => String(941 + i)) },
    { label: "range key", keys: ["51 - 100"] },
    { label: "digit-free key", keys: ["ตอนพิเศษ"] },
    { label: "mixed keys", keys: ["5", "ตอนพิเศษ", "12 - 20"] },
    { label: "exponential key", keys: ["1e+21"] },
    { label: "padded duplicates", keys: ["950", "0950"] },
  ];

  it("hoisted and per-key compositions match the identical row set on every corpus row x keyset", () => {
    let checked = 0;
    let fallbackKeysets = 0;
    for (const { label, keys } of KEYSETS) {
      for (const raw of CORPUS) {
        const result = evaluateBothCompositions(keys, raw);
        expect(
          result.now,
          `hoisted composition must match raw ${JSON.stringify(raw)} for keyset "${label}"`
        ).toBe(result.old);
        checked += 1;
        if (result.fallback) fallbackKeysets += 1;
      }
    }
    // The exponential keyset must have been classified as a novel-wide
    // fallback (identical all-match on both sides), and the rest as real
    // comparisons - proving the corpus actually exercised both paths.
    expect(fallbackKeysets).toBe(CORPUS.length);
    expect(checked).toBe(CORPUS.length * KEYSETS.length);
  });

  it("the rounding-net rows round-trip through the hoisted keyset exactly like the per-key one (spot checks)", () => {
    // The classic IEEE-754 rounding examples from the net's docstring:
    // a novel-wide fetch is NOT required - the hoisted NET still catches
    // these rows for key "1"/"0.5".
    for (const raw of ["0.99999999999999999", "0.50000000000000001", "1.00000000000000000001"]) {
      const result = evaluateBothCompositions(["1", "0.5"], raw);
      expect(result.fallback).toBe(false);
      expect(result.now, `NET must still catch ${raw}`).toBe(result.old);
      expect(result.now).toBe(true);
    }
  });
});

/**
 * IPE-R4R3R6R1: SQL predicate REGRESSION HARDENING. The hoist must keep the
 * OR/AND grouping exactly right, so these tests assert the REAL rendered
 * expression structure from episodeNumberKeysetSqlCondition through the
 * actual drizzle MySQL dialect (sqlToQuery) - not just REGEXP/param counts:
 *   - Numeric keyset:  (COL REGEXP NET or COL REGEXP E1 or ... )
 *   - Range keyset:    (COL REGEXP NET or (COL REGEXP E_a and COL REGEXP E_b))
 *   - Mixed:           (COL REGEXP NET or COL REGEXP E_num or COL NOT REGEXP [0-9] or (...and...))
 *   - Pure digit-free: COL NOT REGEXP [0-9]   (NO NET arm)
 *   - Exponential key: fallbackToNovelWide=true, condition=null
 * plus the parameter BINDING ORDER of the real statement, negative tests
 * that fail if OR is ever flipped to AND (or range endpoints get regrouped),
 * and the empty-keyset caller guard. Rendered placeholders are substituted
 * with their bound parameter values in document order, so [NET] marks the
 * long-token net, [P] any other bound pattern; the column reference is
 * normalized to COL on both sides of every comparison.
 */
describe("keyset SQL predicate structure, binding order and guards (IPE-R4R3R6R1)", () => {
  const dialect = new MySqlDialect();
  const COLUMN = "`episodes`.`episodeNumber`";

  /** Render + substitute each `?` placeholder with its bound value, then normalize the column ref. */
  function annotate(condition: any): string {
    const { sql: text, params } = dialect.sqlToQuery(condition);
    let paramIndex = 0;
    return text.replace(/\?/g, () => {
      const value = params[paramIndex++];
      return value === EPISODE_NUMBER_LONG_TOKEN_SQL_PATTERN ? "[NET]" : `[${String(value)}]`;
    }).split(COLUMN).join("COL");
  }

  function exactArm(key: string): string {
    return `COL REGEXP [${episodeNumberTokenSqlPattern(key)}]`;
  }
  const NET_ARM = "COL REGEXP [NET]";
  const DIGIT_FREE_ARM = "COL NOT REGEXP [[0-9]]";

  it("numeric keyset: NET arm first, exact arms in key order, joined ONLY by or", () => {
    const annotated = annotate(episodeNumberKeysetSqlCondition(["5", "12", "100"]).condition);
    expect(annotated).toBe(
      `(${NET_ARM} or ${exactArm("5")} or ${exactArm("12")} or ${exactArm("100")})`
    );
    // Negative: a flip to AND (guarding the whole keyset) must fail loudly.
    expect(annotated, "OR must never collapse into AND").not.toMatch(/ and /i);
  });

  it("single numeric key: NET OR exact - never NET AND exact", () => {
    const annotated = annotate(episodeNumberKeysetSqlCondition(["5"]).condition);
    expect(annotated).toBe(`(${NET_ARM} or ${exactArm("5")})`);
    expect(annotated).toMatch(new RegExp(`\\(${NET_ARM.replace(/[[\]]/g, "\\$&")} or `));
    expect(annotated).not.toMatch(/\[NET\] and /i);
  });

  it("range key: NET OR (endpoint1 AND endpoint2) - endpoints grouped inside their own parens", () => {
    const annotated = annotate(episodeNumberKeysetSqlCondition(["51 - 100"]).condition);
    expect(annotated).toBe(`(${NET_ARM} or (${exactArm("51")} and ${exactArm("100")}))`);
    // Negative: endpoints OR'ed instead of AND'ed would silently widen the
    // range arm to "51 present OR 100 present" - must never render.
    expect(annotated).not.toContain(`${exactArm("51")} or ${exactArm("100")}`);
    expect(annotated).toContain(`(${exactArm("51")} and ${exactArm("100")})`);
    // Negative: NET must never be AND-connected to anything.
    expect(annotated).not.toMatch(/\[NET\] and /i);
    // And the AND count is exactly the one inside the endpoint group.
    expect((annotated.match(/ and /gi) || []).length).toBe(1);
  });

  it("mixed numeric/digit-free/range keyset: NET OR exact OR digit-free OR (AND-group), in that order", () => {
    const annotated = annotate(episodeNumberKeysetSqlCondition(["5", "ตอนพิเศษ", "12 - 20"]).condition);
    expect(annotated).toBe(
      `(${NET_ARM} or ${exactArm("5")} or ${DIGIT_FREE_ARM} or (${exactArm("12")} and ${exactArm("20")}))`
    );
    expect((annotated.match(/ and /gi) || []).length).toBe(1);
    expect(annotated).not.toMatch(/\[NET\] and /i);
  });

  it("pure digit-free keyset renders only the digit-free arm with NO NET", () => {
    const annotated = annotate(episodeNumberKeysetSqlCondition(["ตอนพิเศษ"]).condition);
    expect(annotated).toBe(DIGIT_FREE_ARM);
    expect(annotated).not.toContain("[NET]");
  });

  it("parameter binding order matches the rendered placeholder order (real statement)", () => {
    const numeric = dialect.sqlToQuery(episodeNumberKeysetSqlCondition(["5", "12", "100"]).condition);
    expect(numeric.params[0]).toBe(EPISODE_NUMBER_LONG_TOKEN_SQL_PATTERN);
    expect(numeric.params[1]).toBe(episodeNumberTokenSqlPattern("5"));
    expect(numeric.params[2]).toBe(episodeNumberTokenSqlPattern("12"));
    expect(numeric.params[3]).toBe(episodeNumberTokenSqlPattern("100"));
    const range = dialect.sqlToQuery(episodeNumberKeysetSqlCondition(["51 - 100"]).condition);
    expect(range.params).toEqual([
      EPISODE_NUMBER_LONG_TOKEN_SQL_PATTERN,
      episodeNumberTokenSqlPattern("51"),
      episodeNumberTokenSqlPattern("100"),
    ]);
    const mixed = dialect.sqlToQuery(episodeNumberKeysetSqlCondition(["5", "ตอนพิเศษ", "12 - 20"]).condition);
    expect(mixed.params).toEqual([
      EPISODE_NUMBER_LONG_TOKEN_SQL_PATTERN,
      episodeNumberTokenSqlPattern("5"),
      "[0-9]",
      episodeNumberTokenSqlPattern("12"),
      episodeNumberTokenSqlPattern("20"),
    ]);
    const digitFree = dialect.sqlToQuery(episodeNumberKeysetSqlCondition(["ตอนพิเศษ"]).condition);
    expect(digitFree.params).toEqual(["[0-9]"]);
  });

  it("exponential-form canonical key: fallbackToNovelWide=true and condition=null", () => {
    const keyset = episodeNumberKeysetSqlCondition(["1e+21"]);
    expect(keyset.fallbackToNovelWide).toBe(true);
    expect(keyset.condition).toBeNull();
  });

  it("empty keyset: the caller guard in ensureEpisodeClassificationKeys prevents the helper from ever seeing it", () => {
    // drizzle's or() of zero arms renders as undefined - the helper would
    // hand back an unusable condition. The production caller must (and
    // does) short-circuit BEFORE calling the helper. This is pinned
    // structurally against the real source instead of expanding the
    // helper's contract (no production change in this round).
    const empty = episodeNumberKeysetSqlCondition([]);
    expect(empty.fallbackToNovelWide).toBe(false);
    expect(empty.condition).toBeUndefined();

    const source = readFileSync(new URL("./packageChapterSplit.service.ts", import.meta.url), "utf8");
    const ensureStart = source.indexOf("async function ensureEpisodeClassificationKeys(");
    expect(ensureStart).toBeGreaterThanOrEqual(0);
    // The function body ends at its top-level closing brace (a "}" that
    // starts a line) - slicing there keeps the whole caller in view.
    const ensureBody = source.slice(ensureStart, source.indexOf("\n}", ensureStart));
    const guard = ensureBody.indexOf("if (keys.size === 0) return;");
    const helperCall = ensureBody.indexOf("episodeNumberKeysetSqlCondition(keys)");
    expect(guard, "the empty-keyset early return must exist in the caller").toBeGreaterThanOrEqual(0);
    expect(helperCall, "the caller must invoke the keyset helper").toBeGreaterThanOrEqual(0);
    expect(guard, "the empty-keyset guard must run BEFORE the keyset helper").toBeLessThan(helperCall);
  });
});
