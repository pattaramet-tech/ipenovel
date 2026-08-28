import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  BackfillOptionError,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  parseBackfillOptions,
  parsePageSize,
} from "../scripts/lib/backfillCliOptions.mjs";

/**
 * P1: the backfill script was completely non-functional.
 *
 * It referenced `gt`, `asc` and `pageSize` which were never imported or
 * declared, so BOTH dry-run and live mode threw on the first page query and
 * no backfill was possible. Parsing is now a pure module so it can be tested
 * without a DATABASE_URL, and a static smoke check below pins the symbols so
 * this exact regression cannot return.
 */

describe("parsePageSize", () => {
  it("defaults to 500 when the flag is absent", () => {
    expect(parsePageSize(["--dry-run"])).toBe(DEFAULT_PAGE_SIZE);
    expect(DEFAULT_PAGE_SIZE).toBe(500);
  });

  it("accepts an explicit value", () => {
    expect(parsePageSize(["--dry-run", "--page-size", "100"])).toBe(100);
  });

  it("accepts the upper bound exactly", () => {
    expect(parsePageSize(["--page-size", String(MAX_PAGE_SIZE)])).toBe(MAX_PAGE_SIZE);
  });

  it("rejects a missing value", () => {
    expect(() => parsePageSize(["--page-size"])).toThrow(BackfillOptionError);
    expect(() => parsePageSize(["--page-size"])).toThrow(/requires a value/i);
  });

  it("rejects a following flag being swallowed as the value", () => {
    expect(() => parsePageSize(["--page-size", "--live"])).toThrow(/requires a value/i);
  });

  it("rejects zero", () => {
    expect(() => parsePageSize(["--page-size", "0"])).toThrow(/greater than 0/i);
  });

  it("rejects a negative value", () => {
    expect(() => parsePageSize(["--page-size", "-1"])).toThrow(/positive integer/i);
  });

  it("rejects a non-numeric value", () => {
    expect(() => parsePageSize(["--page-size", "abc"])).toThrow(/positive integer/i);
  });

  it("rejects a decimal", () => {
    expect(() => parsePageSize(["--page-size", "12.5"])).toThrow(/positive integer/i);
  });

  it("rejects an absurdly large value", () => {
    expect(() => parsePageSize(["--page-size", "999999"])).toThrow(
      new RegExp(`<= ${MAX_PAGE_SIZE}`)
    );
  });

  it("NEVER silently falls back when the operator supplied something invalid", () => {
    // Quietly substituting the default would hide a typo behind a run that
    // looks successful.
    for (const bad of ["0", "-1", "abc", "12.5", "999999"]) {
      expect(() => parsePageSize(["--page-size", bad])).toThrow();
    }
  });

  it("explains that page size bounds memory, not total rows scanned", () => {
    try {
      parsePageSize(["--page-size", "999999"]);
      throw new Error("should have thrown");
    } catch (error) {
      expect((error as Error).message).toMatch(/does not limit how many rows are scanned/i);
    }
  });
});

describe("parseBackfillOptions", () => {
  it("dry-run is the DEFAULT - writing requires an explicit --live", () => {
    const opts = parseBackfillOptions([]);
    expect(opts.isLive).toBe(false);
    expect(opts.isDryRun).toBe(true);
  });

  it("--live enables writing", () => {
    const opts = parseBackfillOptions(["--live"]);
    expect(opts.isLive).toBe(true);
    expect(opts.isDryRun).toBe(false);
  });

  it("--dry-run and --live are mutually exclusive", () => {
    expect(() => parseBackfillOptions(["--dry-run", "--live"])).toThrow(/mutually exclusive/i);
  });

  it("--mark-complete REQUIRES --live", () => {
    expect(() => parseBackfillOptions(["--mark-complete"])).toThrow(/requires --live/i);
    expect(() => parseBackfillOptions(["--dry-run", "--mark-complete"])).toThrow(
      /requires --live/i
    );
  });

  it("a dry run can never mark the backfill complete", () => {
    const opts = parseBackfillOptions(["--dry-run"]);
    expect(opts.markComplete).toBe(false);
  });

  it("--live --mark-complete is permitted", () => {
    const opts = parseBackfillOptions(["--live", "--mark-complete"]);
    expect(opts.isLive).toBe(true);
    expect(opts.markComplete).toBe(true);
  });

  it("carries the validated page size through", () => {
    expect(parseBackfillOptions(["--live", "--page-size", "250"]).pageSize).toBe(250);
  });

  it("the production override is opt-in", () => {
    expect(parseBackfillOptions([]).allowProductionLookingUrl).toBe(false);
    expect(
      parseBackfillOptions(["--i-understand-this-is-not-production"]).allowProductionLookingUrl
    ).toBe(true);
  });
});

// ─── Static smoke check on the script itself ─────────────────────────────

describe("the backfill script defines its pagination symbols", () => {
  const source = fs.readFileSync(
    path.resolve(process.cwd(), "scripts/backfill-slip-claims.mjs"),
    "utf-8"
  );
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

  it("imports gt from drizzle-orm", () => {
    expect(code).toMatch(/await import\("drizzle-orm"\)/);
    const importLine = code.match(/const \{[^}]*\} = await import\("drizzle-orm"\)/)?.[0] ?? "";
    expect(importLine).toMatch(/\bgt\b/);
  });

  it("imports asc from drizzle-orm", () => {
    const importLine = code.match(/const \{[^}]*\} = await import\("drizzle-orm"\)/)?.[0] ?? "";
    expect(importLine).toMatch(/\basc\b/);
  });

  it("imports or from drizzle-orm for the multi-identifier registry lookup", () => {
    const importLine = code.match(/const \{[^}]*\} = await import\("drizzle-orm"\)/)?.[0] ?? "";
    expect(importLine).toMatch(/\bor\b/);
  });

  it("declares pageSize from the validated CLI options", () => {
    expect(code).toMatch(/const \{[^}]*pageSize[^}]*\} = options/);
    expect(code).toMatch(/parseBackfillOptions/);
  });

  it("uses gt + asc + pageSize in the scan", () => {
    expect(code).toMatch(/gt\(idCol, cursor\)/);
    expect(code).toMatch(/\.orderBy\(asc\(idCol\)\)/);
    expect(code).toMatch(/\.limit\(pageSize\)/);
  });

  it("no longer parses the obsolete --limit flag", () => {
    expect(code).not.toMatch(/--limit/);
    expect(code).not.toMatch(/limitArg/);
  });

  it("reports pageSize (not a total-row limit) in its console output", () => {
    expect(code).toMatch(/pageSize=\$\{pageSize\}/);
    expect(code).not.toMatch(/limit=\$\{limit\}/);
  });

  it("documents --page-size, not --limit, in its usage examples", () => {
    expect(source).toMatch(/--page-size 500/);
    expect(source).not.toMatch(/--limit 500/);
  });

  it("pages until exhausted rather than stopping after one batch", () => {
    // Loop + cursor advance + explicit EOF marking.
    expect(code).toMatch(/for \(;;\)/);
    expect(code).toMatch(/cursor = page\[page\.length - 1\]\.id/);
    expect(code).toMatch(/reachedEof\[key\] = true/);
  });
});


// ─── P1: "already represented" must require FULL, SAME-SOURCE ownership ──

describe("registry classification is not satisfied by a partial match", () => {
  const lib = fs
    .readFileSync(path.resolve(process.cwd(), "scripts/lib/backfillRepresentation.mjs"), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ 	]*\/\/.*$/gm, "");
  const code = fs
    .readFileSync(path.resolve(process.cwd(), "scripts/backfill-slip-claims.mjs"), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ 	]*\/\/.*$/gm, "");

  it("uses a classifier rather than a first-match lookup", () => {
    expect(code).toMatch(/classifyAgainstRegistry/);
    expect(code).not.toMatch(/findExistingClaimRow/);
  });

  // The decision itself now lives in scripts/lib/backfillRepresentation.mjs
  // so its matrix can be tested against real inputs rather than source text -
  // see server/services/boundResolutionAndAliasCoverage.test.ts. These
  // assertions moved with it.
  it("only reports a collision when an identifier is owned by a FOREIGN source", () => {
    // IPE-004 review finding P2: a missing identifier (reference, file OR qr)
    // on an otherwise same-source claim is no longer folded into "any
    // unclaimed field -> collision" - it is a dedicated, repairable state
    // (see the needs_strong_identifier test below) so a claim already
    // covering another identifier isn't dragged into manual review purely for
    // a gap the tool itself can safely fill. Only a hash owned by a
    // DIFFERENT source is a genuine collision.
    expect(lib).toMatch(/if \(findings\.length > 0\) \{/);
    // IPE-004-C05: the return also carries `residual` (missingStrong) now -
    // every present sibling axis owned by nobody, so the caller can still
    // durably claim or fail it instead of silently dropping it.
    expect(lib).toMatch(/return \{ kind: "collision", findings, residual: missingStrong \};/);
  });

  it("a same-source claim missing any strong identifier (reference/file/qr) is repairable, not a collision", () => {
    expect(lib).toMatch(/missingStrong\.push\(\{ kind, field, value: ids\[field\] \}\)/);
    expect(lib).toMatch(
      /return \{ kind: "needs_strong_identifier", claim: sameSourceClaim, missing: missingStrong \};/
    );
  });

  it("reports an identifier claimed by a DIFFERENT source", () => {
    expect(lib).toMatch(/claimed by a DIFFERENT source/);
  });

  it("a collision result never counts as represented", () => {
    const idx = code.indexOf('registry?.kind === "collision"');
    expect(idx).toBeGreaterThan(-1);
    const block = code.slice(idx, idx + 300);
    expect(block).not.toMatch(/alreadyClaimed/);
    expect(block).toMatch(/tracker\.collisions\.push/);
  });

  it("fetches every matching claim, not just the first", () => {
    // limit(1) would hide a second, differently-owned claim.
    const idx = code.indexOf("async function classifyAgainstRegistry");
    const block = code.slice(idx, code.indexOf("async function verifyAliasPersisted", idx));
    expect(block).not.toMatch(/\.limit\(1\)/);
    expect(block).toMatch(/\.limit\(20\)/);
  });

  // IPE-004: collisions found via the registry cross-check no longer keep
  // the run from being marked complete forever - a real dry-run found 114
  // genuine historical collisions, a permanent fact about financial history
  // no re-run could ever reduce to zero. Instead every member of every
  // collision finding must be durably recorded into
  // paymentSlipLegacyCollisions (see finalizeCollisionRegistry and
  // scripts/lib/backfillCompletionGate.mjs); only a FAILED durable write
  // still blocks completion.
  it("collisions from the registry are durably recorded, not left blocking completion forever", () => {
    expect(code).not.toMatch(/tracker\.collisions\.length === 0/);
    expect(code).toMatch(/finalizeCollisionRegistry\(\)/);
    expect(code).toMatch(/collisionMembersFailed: stats\.collisionMembersFailed/);
  });

  it("persists the advisory legacy alias under its corrected name", () => {
    expect(code).toMatch(/legacyReferenceUpperHash: derived\.legacyReferenceUpperHash/);
  });

  it("delegates identifier derivation to the pure, testable module", () => {
    expect(code).toMatch(
      /import \{ deriveIdentifiers as deriveIdentifiersPure \} from "\.\/lib\/backfillIdentifierDerivation\.mjs"/
    );
    const idx = code.indexOf("function deriveIdentifiers(extractedDataJson)");
    const block = code.slice(idx, idx + 400);
    expect(block).toMatch(/deriveIdentifiersPure\(extractedDataJson, \{/);
  });

  it("sets the alias ONLY for unrecoverable legacy_uppercase rows, and never carries the same value into referenceHash", () => {
    const derivation = fs
      .readFileSync(
        path.resolve(process.cwd(), "scripts/lib/backfillIdentifierDerivation.mjs"),
        "utf-8"
      )
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");
    expect(derivation).toMatch(/getRawReferenceForLegacyLookup/);
    // Recoverable casing -> explicitly no alias.
    expect(derivation).toMatch(/legacyReferenceUpperHash: undefined/);
    // Only the last-resort branch produces one, and it strips referenceHash
    // rather than carrying through the lossy value `direct` computed.
    const start = derivation.indexOf("if (isLegacyUppercaseOnly) {");
    expect(start).toBeGreaterThan(-1);
    const block = derivation.slice(start, start + 500);
    expect(block).toMatch(/referenceHash: undefined/);
    expect(block).toMatch(/legacyReferenceUpperHash: aliasIfUnrecoverable\(\)/);
  });
});
