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
 * ── Safety ────────────────────────────────────────────────────────────────
 *   * DRY-RUN IS THE DEFAULT. --live is required to write anything.
 *   * NEVER modifies payment/top-up financial status, amounts, or approval
 *     metadata. It only INSERTs into paymentSlipClaims.
 *   * NEVER calls an LLM. When a legacy row has rawText but no parsed
 *     reference, the LOCAL parser is re-run against that stored text - no
 *     network, no provider cost, no new OCR decision.
 *   * Collisions are REPORTED, never silently swallowed. Two historical rows
 *     sharing one reference is a real finding (a past double-credit, or a
 *     parser bug) and an operator must see it rather than have an
 *     INSERT IGNORE hide it.
 *   * Refuses to run against a database whose URL looks like production
 *     unless --i-understand-this-is-not-production is passed, so a stray
 *     shell env cannot point it at live data.
 *
 * Usage:
 *   node scripts/backfill-slip-claims.mjs --dry-run
 *   node scripts/backfill-slip-claims.mjs --live
 *   node scripts/backfill-slip-claims.mjs --dry-run --limit 500
 */

import process from "node:process";

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);

const isLive = has("--live");
const isDryRun = has("--dry-run") || !isLive;
const limitArg = args.indexOf("--limit");
const limit = limitArg >= 0 ? Number(args[limitArg + 1]) : 10000;

if (isLive && has("--dry-run")) {
  console.error("[backfill] --dry-run and --live are mutually exclusive.");
  process.exit(2);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("[backfill] DATABASE_URL is not set. Refusing to run.");
  process.exit(2);
}

// Guard against an operator accidentally pointing this at production.
const looksProduction = /prod/i.test(databaseUrl) && !/preview|staging|test|local/i.test(databaseUrl);
if (looksProduction && !has("--i-understand-this-is-not-production")) {
  console.error(
    "[backfill] DATABASE_URL looks like PRODUCTION. Refusing to run.\n" +
      "           This tool is intended for preview/staging. If you are certain,\n" +
      "           re-run with --i-understand-this-is-not-production."
  );
  process.exit(2);
}

console.log(
  `[backfill] mode=${isLive ? "LIVE (will INSERT claims)" : "DRY-RUN (no writes)"} limit=${limit}`
);

const { default: mysql } = await import("mysql2/promise");
const { drizzle } = await import("drizzle-orm/mysql2");
const { and, eq, isNotNull } = await import("drizzle-orm");
const schema = await import("../drizzle/schema.ts");
const identifiers = await import("../server/services/slipIdentifierService.ts");
const parser = await import("../server/ocr-slip-verification-v2.ts");

const connection = await mysql.createConnection(databaseUrl);
const db = drizzle(connection);

/**
 * Derives a reference hash from a stored row, re-running the LOCAL parser
 * against stored rawText when the row has no usable reference.
 *
 * This is what recovers the KBank rows that previously failed with
 * MISSING_REFERENCE: their rawText contained `เลขที่รายการ: ...` all along;
 * only the parser could not see the label. Re-parsing locally recovers the
 * reference with no LLM call.
 */
function deriveIdentifiers(extractedDataJson) {
  const direct = identifiers.deriveStrongIdentifiersFromExtractedData(extractedDataJson);

  let parsed;
  try {
    parsed = extractedDataJson ? JSON.parse(extractedDataJson) : null;
  } catch {
    parsed = null;
  }

  // CASING IS THE WHOLE POINT OF THIS ORDER.
  //
  // hashSlipReference is deliberately case-preserving, but pre-migration rows
  // stored only the OLD upper-cased `reference`. Hashing that field produces a
  // value a fresh mixed-case read (e.g. SCB's 202608225ApOyxElgdOo7YVwv) can
  // never match. So a stored hash or referenceRaw is used when present, and
  // otherwise the stored rawText is re-parsed with the LOCAL parser FIRST -
  // recovering the original casing from the OCR evidence - before falling back
  // to the upper-cased field.
  //
  // An earlier revision returned `direct` immediately whenever it yielded any
  // identifier, which meant the upper-cased fallback won over better evidence.
  const hasCasePreservingEvidence =
    (typeof parsed?.referenceHash === "string" && parsed.referenceHash.length === 64) ||
    Boolean(parsed?.referenceRaw);

  if (hasCasePreservingEvidence && identifiers.hasStrongIdentifier(direct.identifiers)) {
    return { ...direct, recoveredByReparse: false };
  }

  const rawText = parsed?.rawText;
  if (typeof rawText === "string" && rawText.trim().length > 0) {
    try {
      // LOCAL parser only - never an LLM call.
      const reExtracted = parser.extractSlipData(rawText);
      const reHash = identifiers.hashSlipReference(
        reExtracted.referenceRaw ?? reExtracted.reference
      );
      if (reHash) {
        return {
          identifiers: { ...direct.identifiers, referenceHash: reHash },
          semanticFingerprint: direct.semanticFingerprint ?? reExtracted.semanticFingerprint,
          recoveredByReparse: true,
        };
      }
    } catch {
      // Fall through to the legacy field - a parser failure must not lose the
      // row entirely, only its best-quality evidence.
    }
  }

  // Last resort: whatever direct derivation produced (the upper-cased field).
  return { ...direct, recoveredByReparse: false };
}

const stats = {
  scanned: 0,
  alreadyClaimed: 0,
  wouldClaim: 0,
  claimed: 0,
  recoveredByReparse: 0,
  noIdentifier: 0,
  collisions: [],
};

/** In-run index so two historical rows sharing a reference are detected. */
const seen = new Map();

async function processRows(sourceType, rows) {
  for (const row of rows) {
    stats.scanned += 1;

    const derived = deriveIdentifiers(row.extractedData);
    if (derived.recoveredByReparse) stats.recoveredByReparse += 1;

    if (!identifiers.hasStrongIdentifier(derived.identifiers)) {
      stats.noIdentifier += 1;
      continue;
    }

    const key = derived.identifiers.referenceHash ?? derived.identifiers.fileHash;

    const prior = seen.get(key);
    if (prior) {
      // Two APPROVED historical records share one bank transaction. Report -
      // never quietly skip: this is either a past double-credit or a parser
      // bug, and an operator must decide which.
      stats.collisions.push({
        identifier: key.slice(0, 12) + "...",
        first: `${prior.sourceType}#${prior.sourceId}`,
        second: `${sourceType}#${row.id}`,
      });
      continue;
    }
    seen.set(key, { sourceType, sourceId: row.id });

    // Skip rows already represented (idempotent re-runs).
    const existing = await db
      .select({ id: schema.paymentSlipClaims.id })
      .from(schema.paymentSlipClaims)
      .where(eq(schema.paymentSlipClaims.referenceHash, derived.identifiers.referenceHash ?? ""))
      .limit(1);
    if (existing?.length) {
      stats.alreadyClaimed += 1;
      continue;
    }

    if (!isLive) {
      stats.wouldClaim += 1;
      continue;
    }

    try {
      await db.insert(schema.paymentSlipClaims).values({
        sourceType,
        sourceId: row.id,
        userId: row.userId ?? 0,
        referenceHash: derived.identifiers.referenceHash ?? null,
        fileHash: derived.identifiers.fileHash ?? null,
        qrPayloadHash: null,
        semanticFingerprint: derived.semanticFingerprint ?? null,
        claimedAt: new Date(),
      });
      stats.claimed += 1;
    } catch (error) {
      // A duplicate-key error here is itself a collision worth reporting.
      stats.collisions.push({
        identifier: String(key).slice(0, 12) + "...",
        first: "existing claim",
        second: `${sourceType}#${row.id}`,
        error: error?.code ?? "insert failed",
      });
    }
  }
}

try {
  // GLOBAL scans - every user, approved rows only (approval is the evidence
  // that value was created), paged by ascending primary key so coverage is
  // COMPLETE and deterministic. Deliberately not the old user-scoped or
  // pending-only helpers, and deliberately NOT a fixed row cap: an arbitrary
  // limit would silently leave later rows unbackfilled and replayable.
  async function scanAll(table, statusCol, idCol, extractedCol, extraCols, onPage) {
    let cursor = 0;
    for (;;) {
      const page = await db
        .select({ id: idCol, extractedData: extractedCol, ...extraCols })
        .from(table)
        .where(and(eq(statusCol, "approved"), isNotNull(extractedCol), gt(idCol, cursor)))
        .orderBy(asc(idCol))
        .limit(pageSize);

      if (!page || page.length === 0) return;
      await onPage(page);
      cursor = page[page.length - 1].id;
      if (page.length < pageSize) return;
    }
  }

  await scanAll(
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
    isLive ? `  claims INSERTED          : ${stats.claimed}` : `  would insert             : ${stats.wouldClaim}`
  );
  console.log(`  collisions REPORTED      : ${stats.collisions.length}`);

  if (stats.collisions.length > 0) {
    console.log("\n[backfill] COLLISIONS - review each before treating the backfill as complete:");
    for (const c of stats.collisions) {
      console.log(`  - ${c.identifier}  ${c.first}  <->  ${c.second}${c.error ? `  (${c.error})` : ""}`);
    }
    console.log(
      "\n  A collision means two APPROVED records share one bank transaction.\n" +
        "  That is either a historical double-credit or a parser bug. It has NOT\n" +
        "  been auto-resolved and no financial record was modified."
    );
  }

  if (!isLive) {
    console.log("\n[backfill] DRY-RUN complete. No rows were written. Re-run with --live to apply.");
  }

  process.exitCode = stats.collisions.length > 0 ? 1 : 0;
} finally {
  await connection.end();
}
