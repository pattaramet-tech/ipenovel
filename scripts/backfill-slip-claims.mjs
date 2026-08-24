#!/usr/bin/env node
/**
 * Backfill paymentSlipClaims from already-approved payments and wallet top-ups.
 *
 * ── Why ───────────────────────────────────────────────────────────────────
 * Migration 0037 creates an EMPTY claim registry. Every payment and top-up
 * approved before it has no claim row, so its bank reference is unprotected
 * by the new UNIQUE constraints and could be replayed. This tool writes the
 * missing claims so historical value creation is represented in the registry.
 *
 * Until it has run to completion, the approval path also performs a full
 * historical scan on every claim (see legacySlipCompatibilityService). That
 * scan is O(N) per approval and is disabled only by --mark-complete below.
 *
 * ── Safety ────────────────────────────────────────────────────────────────
 *   * DRY-RUN IS THE DEFAULT. --live is required to write anything.
 *   * --mark-complete requires --live, and applies only after a fully clean
 *     run: every page scanned to EOF on BOTH sources, no query failures, no
 *     insert failures, and no unresolved strong-identifier collisions.
 *   * NEVER modifies payment/top-up financial status, amounts, or approval
 *     metadata. It only INSERTs into paymentSlipClaims (and, with
 *     --mark-complete, one settings row).
 *   * NEVER calls an LLM. When a legacy row has rawText but no case-preserving
 *     reference, the LOCAL parser is re-run against that stored text.
 *   * Collisions are REPORTED, never swallowed. Two historical rows sharing a
 *     strong identifier is a real finding an operator must adjudicate.
 *   * Refuses a production-looking DATABASE_URL without an explicit override.
 *
 * ── Pagination ────────────────────────────────────────────────────────────
 * Scans page-by-page ordered by ascending primary key until both sources are
 * exhausted. --page-size bounds MEMORY per page; it never caps total rows
 * scanned. No single transaction spans the run: pages commit independently,
 * so a crash mid-run leaves the state incomplete and the safety scan enabled.
 *
 * ── Running this script ──────────────────────────────────────────────────
 * This is a .mjs file, but it dynamically imports real application modules
 * written in TypeScript (drizzle/schema.ts, server/services/
 * slipIdentifierService.ts, server/ocr-slip-verification-v2.ts) using
 * extensionless imports and this project's tsconfig.json path aliases
 * (@shared/*, @/*). Plain `node` has no built-in understanding of either -
 * it resolves ESM imports strictly by exact file extension and knows
 * nothing about tsconfig `paths` - so `node scripts/backfill-slip-claims.mjs`
 * fails the moment it reaches one of those imports (ERR_MODULE_NOT_FOUND),
 * every time DATABASE_URL is actually configured. This is NOT a missing-file
 * bug; it is the wrong loader for this dependency graph.
 *
 * `tsx` (already a devDependency, already the loader `pnpm dev`/`pnpm
 * test:ci`/`pnpm migrate:media` use for the same reason) resolves both
 * correctly. Always invoke this script through it - use ONE of:
 *
 *   pnpm backfill:slip-claims -- --dry-run
 *   pnpm backfill:slip-claims -- --dry-run --page-size 500
 *   pnpm backfill:slip-claims -- --live --page-size 500
 *   pnpm backfill:slip-claims -- --live --mark-complete
 *
 * or the equivalent direct form:
 *
 *   npx tsx scripts/backfill-slip-claims.mjs --dry-run
 *
 * Never invoke this script with plain `node`.
 */

import process from "node:process";
import { BackfillOptionError, parseBackfillOptions } from "./lib/backfillCliOptions.mjs";
import { createCollisionTracker } from "./lib/backfillCollisionTracker.mjs";
import {
  classifyRepresentation,
  STRONG_FIELDS,
} from "./lib/backfillRepresentation.mjs";

const TOOL_VERSION = "backfill-slip-claims@2";

let options;
try {
  options = parseBackfillOptions(process.argv.slice(2));
} catch (error) {
  if (error instanceof BackfillOptionError) {
    console.error(`[backfill] ${error.message}`);
    process.exit(2);
  }
  throw error;
}

const { isLive, markComplete, pageSize, allowProductionLookingUrl } = options;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("[backfill] DATABASE_URL is not set. Refusing to run.");
  process.exit(2);
}

const looksProduction =
  /prod/i.test(databaseUrl) && !/preview|staging|test|local/i.test(databaseUrl);
if (looksProduction && !allowProductionLookingUrl) {
  console.error(
    "[backfill] DATABASE_URL looks like PRODUCTION. Refusing to run.\n" +
      "           This tool is intended for preview/staging. If you are certain,\n" +
      "           re-run with --i-understand-this-is-not-production."
  );
  process.exit(2);
}

console.log(
  `[backfill] mode=${isLive ? "LIVE (will INSERT claims)" : "DRY-RUN (no writes)"} ` +
    `pageSize=${pageSize} markComplete=${markComplete ? "yes" : "no"}`
);

const { default: mysql } = await import("mysql2/promise");
const { drizzle } = await import("drizzle-orm/mysql2");
const { and, asc, eq, gt, isNotNull, or } = await import("drizzle-orm");
let schema, identifiers, parser;
try {
  schema = await import("../drizzle/schema.ts");
  identifiers = await import("../server/services/slipIdentifierService.ts");
  parser = await import("../server/ocr-slip-verification-v2.ts");
} catch (error) {
  if (error instanceof Error && error.code === "ERR_MODULE_NOT_FOUND") {
    console.error(
      "[backfill] Failed to load a TypeScript application module: " +
        `${error.message}\n` +
        "           This script must be run through tsx, not plain node - it dynamically\n" +
        "           imports .ts files using extensionless imports and tsconfig path\n" +
        "           aliases (@shared/*, @/*) that node's own ESM resolver cannot follow.\n" +
        "           Re-run with: pnpm backfill:slip-claims -- <same flags>\n" +
        "           or:          npx tsx scripts/backfill-slip-claims.mjs <same flags>"
    );
    process.exit(2);
  }
  throw error;
}

const connection = await mysql.createConnection(databaseUrl);
const db = drizzle(connection);

/**
 * Derives strong identifiers from a stored row.
 *
 * CASING ORDER MATTERS. hashSlipReference is case-preserving, but
 * pre-migration rows stored only the OLD upper-cased `reference`; hashing
 * that produces a value a fresh mixed-case read can never match. So a stored
 * hash or referenceRaw is used when present, otherwise the stored rawText is
 * re-parsed with the LOCAL parser (recovering the original casing from the
 * OCR evidence), and only then the upper-cased field.
 */
function deriveIdentifiers(extractedDataJson) {
  const direct = identifiers.deriveStrongIdentifiersFromExtractedData(extractedDataJson);

  let parsed;
  try {
    parsed = extractedDataJson ? JSON.parse(extractedDataJson) : null;
  } catch {
    parsed = null;
  }

  // The advisory legacy alias is ONLY for rows whose original casing is
  // unrecoverable - persisted with just an upper-cased `reference`, no
  // referenceRaw, no stored hash, no reparsable rawText. Those are the only
  // rows a mixed-case replay cannot be matched against by exact hash.
  //
  // It is deliberately NOT computed for every row: writing it where casing IS
  // recoverable would manufacture ambiguity that does not exist and drag
  // unrelated future payments into manual review.
  const rawReference = identifiers.getRawReferenceForLegacyLookup(extractedDataJson);
  const aliasIfUnrecoverable = () =>
    rawReference ? identifiers.hashSlipReference(rawReference.toUpperCase()) : undefined;

  const hasCasePreservingEvidence =
    (typeof parsed?.referenceHash === "string" && parsed.referenceHash.length === 64) ||
    Boolean(parsed?.referenceRaw);

  if (hasCasePreservingEvidence && identifiers.hasStrongIdentifier(direct.identifiers)) {
    // Casing survived - no ambiguity, so no alias.
    return {
      ...direct,
      legacyReferenceUpperHash: undefined,
      referenceEvidence: parsed?.referenceHash ? "stored_hash" : "reference_raw",
      recoveredByReparse: false,
    };
  }

  const rawText = parsed?.rawText;
  if (typeof rawText === "string" && rawText.trim().length > 0) {
    try {
      const reExtracted = parser.extractSlipData(rawText);
      const reHash = identifiers.hashSlipReference(
        reExtracted.referenceRaw ?? reExtracted.reference
      );
      if (reHash) {
        // Reparsing recovered the TRUE casing, so this row is no longer
        // ambiguous and must not carry an alias.
        return {
          identifiers: { ...direct.identifiers, referenceHash: reHash },
          semanticFingerprint: direct.semanticFingerprint ?? reExtracted.semanticFingerprint,
          legacyReferenceUpperHash: undefined,
          referenceEvidence: "reparsed_raw_text",
          recoveredByReparse: true,
        };
      }
    } catch {
      // Fall through - a parser failure loses only the best-quality evidence.
    }
  }

  // Last resort: only the upper-cased legacy field survives. THIS is the
  // ambiguous case, and the ONLY one that receives an advisory alias.
  const isLegacyUppercaseOnly = Boolean(rawReference) && !hasCasePreservingEvidence;
  return {
    ...direct,
    legacyReferenceUpperHash: isLegacyUppercaseOnly ? aliasIfUnrecoverable() : undefined,
    referenceEvidence: isLegacyUppercaseOnly ? "legacy_uppercase" : "none",
    recoveredByReparse: false,
  };
}

const stats = {
  scanned: 0,
  alreadyClaimed: 0,
  wouldClaim: 0,
  claimed: 0,
  recoveredByReparse: 0,
  noIdentifier: 0,
  /** Represented rows whose required advisory alias is missing. */
  wouldEnrichAlias: 0,
  aliasEnriched: 0,
  /** Rows still lacking required alias coverage when the run ends. */
  aliasUncovered: 0,
  aliasInconsistencies: [],
  failures: [],
  paymentMaxId: 0,
  walletTopupMaxId: 0,
};

/**
 * Every strong identifier is tracked INDEPENDENTLY - see
 * scripts/lib/backfillCollisionTracker.mjs for why keying on
 * `referenceHash ?? fileHash` silently missed file collisions.
 */
const tracker = createCollisionTracker();

/**
 * Groups of historical rows sharing one advisory legacy alias.
 *
 * Reported SEPARATELY from strong-identifier collisions and deliberately not
 * treated as evidence of a historical duplicate: the alias is lossy, so rows
 * folding together may be entirely different transactions. Every source row
 * is retained - no source "wins" ownership of an alias, because doing so
 * would silently drop protection for the others.
 */
const legacyAliasGroups = new Map();

function noteLegacyAlias(aliasHash, current) {
  if (!aliasHash) return;
  const existing = legacyAliasGroups.get(aliasHash) ?? [];
  existing.push(`${current.sourceType}#${current.sourceId}`);
  legacyAliasGroups.set(aliasHash, existing);
}

/**
 * Classifies a historical row against the REGISTRY.
 *
 * A row counts as REPRESENTED only when the SAME source already owns EVERY
 * strong identifier the row carries AND, when the row's casing is
 * unrecoverable, that same-source claim also carries the required advisory
 * alias. The decision itself lives in scripts/lib/backfillRepresentation.mjs
 * so the matrix can be tested without a database; this wrapper only fetches.
 *
 * The looser "any one identifier matched -> represented" rule was unsafe: if
 * an existing claim shared this row's reference but NOT its distinct
 * fileHash, the row was skipped, the run could still be marked complete, and
 * that file hash stayed unclaimed - so a later replay whose OCR missed the
 * reference could claim the file and create value again. Partial ownership
 * and cross-source ownership are therefore both reported, never absorbed.
 */
async function classifyAgainstRegistry(ids, current, expectedAliasHash) {
  const present = STRONG_FIELDS.filter(([, field]) => Boolean(ids[field]));
  if (present.length === 0) return undefined;

  const conditions = present.map(([, field]) =>
    eq(schema.paymentSlipClaims[field], ids[field])
  );

  // Every matching claim, not just the first - a row can legitimately touch
  // more than one claim, and that is exactly the case worth reporting.
  const rows = await db
    .select()
    .from(schema.paymentSlipClaims)
    .where(conditions.length === 1 ? conditions[0] : or(...conditions))
    .limit(20);

  return classifyRepresentation(ids, current, rows, expectedAliasHash);
}

/**
 * Re-reads one claim and confirms the alias actually landed. An enrichment
 * that silently affected zero rows must not be counted as coverage.
 */
async function verifyAliasPersisted(claimId, expectedAliasHash) {
  const rows = await db
    .select()
    .from(schema.paymentSlipClaims)
    .where(eq(schema.paymentSlipClaims.id, claimId))
    .limit(1);
  return rows?.[0]?.legacyReferenceUpperHash === expectedAliasHash;
}

async function processRows(sourceType, rows) {
  for (const row of rows) {
    stats.scanned += 1;
    if (sourceType === "order_payment") {
      stats.paymentMaxId = Math.max(stats.paymentMaxId, row.id);
    } else {
      stats.walletTopupMaxId = Math.max(stats.walletTopupMaxId, row.id);
    }

    const derived = deriveIdentifiers(row.extractedData);
    if (derived.recoveredByReparse) stats.recoveredByReparse += 1;

    const ids = derived.identifiers;
    if (!identifiers.hasStrongIdentifier(ids)) {
      stats.noIdentifier += 1;
      continue;
    }

    const current = { sourceType, sourceId: row.id };

    // Registry classification: represented only when THIS source already owns
    // EVERY identifier this row carries. Partial or foreign ownership is a
    // reported collision, never a silent skip.
    // The alias this row REQUIRES. Undefined whenever the casing survived -
    // those rows need no advisory coverage and must never be given one.
    const expectedAlias = derived.legacyReferenceUpperHash;

    let registry;
    try {
      registry = await classifyAgainstRegistry(ids, current, expectedAlias);
    } catch (error) {
      stats.failures.push({
        source: `${sourceType}#${row.id}`,
        stage: "registry lookup",
        error: error?.code ?? error?.message ?? "unknown",
      });
      continue;
    }

    if (registry?.kind === "represented") {
      stats.alreadyClaimed += 1;
      tracker.remember(ids, current);
      // Represented rows carry their alias too, so the advisory grouping
      // report covers the whole corpus rather than just newly claimed rows.
      noteLegacyAlias(expectedAlias, current);
      continue;
    }

    if (registry?.kind === "alias_inconsistent") {
      // Never overwrite: the recorded alias may be protecting a fold this
      // derivation no longer produces. An operator decides, and completion
      // is refused until they do.
      stats.aliasInconsistencies.push({
        source: `${sourceType}#${row.id}`,
        expected: `${String(registry.expected).slice(0, 12)}...`,
        existing: `${String(registry.existing).slice(0, 12)}...`,
      });
      stats.aliasUncovered += 1;
      tracker.remember(ids, current);
      continue;
    }

    if (registry?.kind === "needs_alias") {
      // Strong identifiers are fully owned by this source, but the required
      // advisory alias is absent - the exact state that let a mixed-case
      // replay through after completion. Repair the SAME claim; never insert
      // a second one, since the alias is lossy and non-unique.
      tracker.remember(ids, current);
      noteLegacyAlias(expectedAlias, current);

      if (!isLive) {
        stats.wouldEnrichAlias += 1;
        stats.aliasUncovered += 1;
        console.log(
          `  WOULD_ENRICH_LEGACY_ALIAS  ${sourceType}#${row.id}  claim#${registry.claim?.id}`
        );
        continue;
      }

      try {
        await db
          .update(schema.paymentSlipClaims)
          .set({ legacyReferenceUpperHash: registry.expected })
          .where(eq(schema.paymentSlipClaims.id, registry.claim.id));

        // Re-read: an update that affected nothing is not coverage.
        if (await verifyAliasPersisted(registry.claim.id, registry.expected)) {
          stats.aliasEnriched += 1;
        } else {
          stats.aliasUncovered += 1;
          stats.failures.push({
            source: `${sourceType}#${row.id}`,
            stage: "alias enrichment",
            error: "alias not present after update",
          });
        }
      } catch (error) {
        stats.aliasUncovered += 1;
        stats.failures.push({
          source: `${sourceType}#${row.id}`,
          stage: "alias enrichment",
          error: error?.code ?? error?.message ?? "unknown",
        });
      }
      continue;
    }

    if (registry?.kind === "collision") {
      for (const finding of registry.findings) tracker.collisions.push(finding);
      continue;
    }

    // Collisions WITHIN this run, checked per identifier.
    const collidingKinds = tracker.check(ids, current);
    if (collidingKinds.length > 0) continue;

    tracker.remember(ids, current);
    noteLegacyAlias(derived.legacyReferenceUpperHash, current);

    if (!isLive) {
      stats.wouldClaim += 1;
      continue;
    }

    try {
      await db.insert(schema.paymentSlipClaims).values({
        sourceType,
        sourceId: row.id,
        userId: row.userId ?? 0,
        referenceHash: ids.referenceHash ?? null,
        // Advisory alias, set ONLY for legacy_uppercase evidence.
        legacyReferenceUpperHash: derived.legacyReferenceUpperHash ?? null,
        fileHash: ids.fileHash ?? null,
        qrPayloadHash: ids.qrPayloadHash ?? null,
        semanticFingerprint: derived.semanticFingerprint ?? null,
        claimedAt: new Date(),
      });
      stats.claimed += 1;
    } catch (error) {
      // A duplicate-key error here is a genuine collision the pre-checks
      // missed (e.g. a concurrent writer); anything else is a real failure.
      const isDuplicate = error?.code === "ER_DUP_ENTRY" || error?.errno === 1062;
      if (isDuplicate) {
        tracker.collisions.push({
          kind: "registry",
          identifier: "(unique index)",
          first: "existing claim",
          second: `${sourceType}#${row.id}`,
        });
      } else {
        stats.failures.push({
          source: `${sourceType}#${row.id}`,
          stage: "insert",
          error: error?.code ?? error?.message ?? "unknown",
        });
      }
    }
  }
}

const reachedEof = { payments: false, walletTopups: false };

try {
  // GLOBAL scans - every user, approved rows only (approval is the evidence
  // that value was created), paged by ascending primary key so coverage is
  // COMPLETE and deterministic. Deliberately NOT a fixed row cap: an arbitrary
  // limit would silently leave later rows unbackfilled and replayable.
  async function scanAll(key, table, statusCol, idCol, extractedCol, extraCols, onPage) {
    let cursor = 0;
    for (;;) {
      const page = await db
        .select({ id: idCol, extractedData: extractedCol, ...extraCols })
        .from(table)
        .where(and(eq(statusCol, "approved"), isNotNull(extractedCol), gt(idCol, cursor)))
        .orderBy(asc(idCol))
        .limit(pageSize);

      if (!page || page.length === 0) {
        reachedEof[key] = true;
        return;
      }
      await onPage(page);
      cursor = page[page.length - 1].id;
      if (page.length < pageSize) {
        reachedEof[key] = true;
        return;
      }
    }
  }

  await scanAll(
    "payments",
    schema.payments,
    schema.payments.status,
    schema.payments.id,
    schema.payments.extractedData,
    { orderId: schema.payments.orderId },
    async (page) => {
      // payments has no userId; resolve via the parent order for the claim row.
      for (const p of page) {
        const order = await db
          .select({ userId: schema.orders.userId })
          .from(schema.orders)
          .where(eq(schema.orders.id, p.orderId))
          .limit(1);
        p.userId = order?.[0]?.userId ?? 0;
      }
      await processRows("order_payment", page);
    }
  );

  await scanAll(
    "walletTopups",
    schema.walletTopups,
    schema.walletTopups.status,
    schema.walletTopups.id,
    schema.walletTopups.extractedData,
    { userId: schema.walletTopups.userId },
    async (page) => {
      await processRows("wallet_topup", page);
    }
  );

  console.log("\n[backfill] ---- SUMMARY ----");
  console.log(`  scanned approved records : ${stats.scanned}`);
  console.log(`  already represented      : ${stats.alreadyClaimed}`);
  console.log(`  recovered by re-parse    : ${stats.recoveredByReparse}`);
  console.log(`  no strong identifier     : ${stats.noIdentifier}`);
  console.log(
    isLive
      ? `  claims INSERTED          : ${stats.claimed}`
      : `  would insert             : ${stats.wouldClaim}`
  );
  const ambiguousAliasGroups = [...legacyAliasGroups.entries()].filter(
    ([, sources]) => sources.length > 1
  );
  const legacyAliasesWouldCreate = [...legacyAliasGroups.keys()].length;

  console.log(`  legacy aliases to create : ${legacyAliasesWouldCreate}`);
  console.log(`  ambiguous alias groups   : ${ambiguousAliasGroups.length}`);
  console.log(
    isLive
      ? `  aliases ENRICHED         : ${stats.aliasEnriched}`
      : `  would enrich aliases     : ${stats.wouldEnrichAlias}`
  );
  console.log(`  alias inconsistencies    : ${stats.aliasInconsistencies.length}`);
  console.log(`  rows lacking alias cover : ${stats.aliasUncovered}`);
  console.log(`  collisions REPORTED      : ${tracker.collisions.length}`);
  console.log(`  failures                 : ${stats.failures.length}`);

  if (tracker.collisions.length > 0) {
    console.log("\n[backfill] COLLISIONS - review each before treating the backfill as complete:");
    for (const c of tracker.collisions) {
      console.log(`  - [${c.kind}] ${c.identifier}  ${c.first}  <->  ${c.second}`);
    }
    console.log(
      "\n  A collision means two APPROVED records share one strong identifier.\n" +
        "  That is either a historical double-credit or a parser bug. It has NOT\n" +
        "  been auto-resolved and no financial record was modified."
    );
  }

  if (ambiguousAliasGroups.length > 0) {
    console.log("\n[backfill] AMBIGUOUS_LEGACY_ALIAS_GROUP - advisory, NOT duplicates:");
    for (const [aliasHash, sources] of ambiguousAliasGroups) {
      console.log(`  - ${String(aliasHash).slice(0, 12)}...  ${sources.join("  |  ")}`);
    }
    console.log(
      "\n  These historical rows share one reference only after case folding." +
        " Because upper-casing is lossy this is NOT proof of a duplicate, it is NOT a" +
        " strong identifier collision, and it does NOT block completion." +
        " Every listed row keeps its own alias - none takes ownership." +
        " A future submission folding to one of these values will stop for explicit" +
        " admin review."
    );
  }

  if (stats.aliasInconsistencies.length > 0) {
    console.log("\n[backfill] LEGACY_ALIAS_INCONSISTENCY - operator review required:");
    for (const a of stats.aliasInconsistencies) {
      console.log(`  - ${a.source}  expected ${a.expected}  but claim holds ${a.existing}`);
    }
    console.log(
      "\n  The claim for this source already records a DIFFERENT advisory alias." +
        "\n  Nothing was overwritten: the recorded alias may be protecting a fold this" +
        "\n  derivation no longer produces, and guessing could silently remove coverage." +
        "\n  Completion is REFUSED until each of these is resolved by hand."
    );
  }

  if (stats.failures.length > 0) {
    console.log("\n[backfill] FAILURES:");
    for (const f of stats.failures) {
      console.log(`  - ${f.source} (${f.stage}): ${f.error}`);
    }
  }

  // ── Completion ─────────────────────────────────────────────────────────
  // Required ADVISORY coverage counts toward completion just as strong
  // coverage does. Completion disables the historical scan, so a legacy row
  // whose claim carries no alias would be left with NO protection at all
  // against a mixed-case replay - the hole this rule closes.
  const aliasCoverageComplete =
    stats.aliasUncovered === 0 && stats.aliasInconsistencies.length === 0;

  const cleanRun =
    stats.failures.length === 0 &&
    tracker.collisions.length === 0 &&
    aliasCoverageComplete &&
    reachedEof.payments &&
    reachedEof.walletTopups;

  if (markComplete) {
    if (!cleanRun) {
      console.error(
        "\n[backfill] REFUSING to mark complete. A completion flag disables the legacy\n" +
          "           safety scan, so it is only written after a fully clean run:\n" +
          `             failures=${stats.failures.length} collisions=${tracker.collisions.length} ` +
          `aliasUncovered=${stats.aliasUncovered} aliasInconsistencies=${stats.aliasInconsistencies.length}` +
          ` paymentsEOF=${reachedEof.payments} topupsEOF=${reachedEof.walletTopups}\n` +
          "           Resolve the findings above and re-run."
      );
      process.exitCode = 1;
    } else {
      const state = await import("../server/services/slipBackfillStateService.ts");
      await state.markSlipBackfillComplete({
        toolVersion: TOOL_VERSION,
        paymentMaxId: stats.paymentMaxId,
        walletTopupMaxId: stats.walletTopupMaxId,
        claimsInserted: stats.claimed,
      });
      console.log(
        "\n[backfill] Marked COMPLETE. The approval path will now rely on the\n" +
          "           paymentSlipClaims UNIQUE registry and skip the historical scan.\n" +
          "           Every new approval still writes its own claim atomically."
      );
    }
  } else if (isLive && cleanRun) {
    console.log(
      "\n[backfill] Live run clean. Re-run with --live --mark-complete to disable the\n" +
        "           legacy historical scan."
    );
  }

  if (!isLive) {
    console.log("\n[backfill] DRY-RUN complete. No rows were written. Re-run with --live to apply.");
  }

  if (
    tracker.collisions.length > 0 ||
    stats.failures.length > 0 ||
    stats.aliasInconsistencies.length > 0
  ) {
    process.exitCode = 1;
  }
} finally {
  await connection.end();
}
