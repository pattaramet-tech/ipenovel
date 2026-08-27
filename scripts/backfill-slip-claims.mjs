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
import { recoverFileHashIdentifier } from "./lib/backfillFileHashRecovery.mjs";
import { deriveIdentifiers as deriveIdentifiersPure } from "./lib/backfillIdentifierDerivation.mjs";
import {
  detectStaleReferenceClaim,
  buildStaleReferenceMigrationPatch,
} from "./lib/backfillStaleReferenceMigration.mjs";
import { evaluateBackfillCompletion } from "./lib/backfillCompletionGate.mjs";

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
const { and, asc, eq, gt, or } = await import("drizzle-orm");
let schema, identifiers, parser, fileHashService, legacyCollisionService;
try {
  schema = await import("../drizzle/schema.ts");
  identifiers = await import("../server/services/slipIdentifierService.ts");
  parser = await import("../server/ocr-slip-verification-v2.ts");
  fileHashService = await import("../server/services/slipFileHashService.ts");
  legacyCollisionService = await import("../server/services/slipLegacyCollisionService.ts");
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
 * Derives strong identifiers from a stored row. Thin wrapper around the pure
 * decision in scripts/lib/backfillIdentifierDerivation.mjs (see there for the
 * casing-recovery order and why legacy_uppercase evidence never becomes
 * exact referenceHash authority) - injecting the real TS-module functions so
 * this stays the only place they are wired together.
 */
function deriveIdentifiers(extractedDataJson) {
  return deriveIdentifiersPure(extractedDataJson, {
    deriveStrongIdentifiersFromExtractedData: identifiers.deriveStrongIdentifiersFromExtractedData,
    getRawReferenceForLegacyLookup: identifiers.getRawReferenceForLegacyLookup,
    hashSlipReference: identifiers.hashSlipReference,
    hasStrongIdentifier: identifiers.hasStrongIdentifier,
    extractSlipData: parser.extractSlipData,
  });
}

const stats = {
  scanned: 0,
  alreadyClaimed: 0,
  wouldClaim: 0,
  claimed: 0,
  recoveredByReparse: 0,
  /** Server-side fileHash recovered from stored slip bytes for a row whose
   *  extractedData carried no strong identifier at all (NULL or otherwise). */
  fileHashRecovered: 0,
  /**
   * Approved rows left with NO exact identifier at all: either extractedData
   * carried none and fileHash recovery also failed, OR extractedData carried
   * another exact identifier (reference/QR) but exact fileHash coverage could
   * not be established. Reference/QR presence never excuses missing file-byte
   * replay coverage - either way this is UNRESOLVED, never silently skipped,
   * never counted as coverage, and alone blocks --mark-complete.
   */
  noIdentifier: 0,
  unresolvedRows: [],
  /**
   * Durable classification of UNRESOLVED rows into paymentSlipLegacyUnknown -
   * the fix for the incident where zero unresolved rows was required before
   * the historical scan could ever be disabled. Every unresolved row must
   * land in `unknownRowsRecorded` (write succeeded, whether newly inserted or
   * already present from a prior run) for completion; `unknownRowsFailed`
   * blocks it.
   */
  unknownRowsRecorded: 0,
  unknownRowsFailed: 0,
  wouldRecordUnknown: 0,
  /**
   * Durable classification of COLLISION findings into
   * paymentSlipLegacyCollisions - the historical-collision analogue of the
   * above. Every member of every collision finding must land in
   * `collisionMembersRecorded` for completion; `collisionMembersFailed`
   * blocks it.
   */
  collisionMembersRecorded: 0,
  collisionMembersFailed: 0,
  wouldRecordCollisionMembers: 0,
  /** Represented rows whose required advisory alias is missing. */
  wouldEnrichAlias: 0,
  aliasEnriched: 0,
  /** Rows still lacking required alias coverage when the run ends. */
  aliasUncovered: 0,
  aliasInconsistencies: [],
  /**
   * Rows already represented via another strong identifier whose same-source
   * claim was missing exact fileHash coverage - repaired by adding it.
   */
  wouldAddFileHash: 0,
  fileHashCoverageAdded: 0,
  /** Rows still lacking required fileHash coverage when the run ends. */
  fileHashUncovered: 0,
  /**
   * Claims written by an OLDER backfill version that stored lossy
   * legacy-uppercase evidence as EXACT referenceHash ownership - repaired in
   * place (obsolete exact reference cleared, alias/fileHash retained/added).
   */
  wouldRepairStaleClaim: 0,
  staleClaimsRepaired: 0,
  /** Stale claims not yet repaired when the run ends - blocks completion. */
  staleClaimsUncovered: 0,
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
 * Durably records ONE historical row as UNRESOLVED (permanently unknown file
 * identity) in paymentSlipLegacyUnknown - IPE-004's fix for the incident
 * where an unresolved row could never be reconciled with "mark complete".
 *
 * Idempotent: the service's insert-or-detect-duplicate call makes a repeat
 * run for the same source a no-op, never a second row and never an error.
 */
async function recordUnknownRow(sourceType, sourceId, reason) {
  if (!isLive) {
    stats.wouldRecordUnknown += 1;
    return;
  }
  try {
    await legacyCollisionService.recordLegacyUnknownRow(
      { sourceType, sourceId, reason: reason ?? "unknown" },
      db
    );
    stats.unknownRowsRecorded += 1;
  } catch (error) {
    stats.unknownRowsFailed += 1;
    stats.failures.push({
      source: `${sourceType}#${sourceId}`,
      stage: "record unknown row",
      error: error?.code ?? error?.message ?? "unknown",
    });
  }
}

/**
 * Clears a stale UNRESOLVED record for one source that a re-run of the
 * backfill was able to fully resolve after all (e.g. a transient recovery
 * failure that succeeded this time). Best-effort: a failure here is not
 * itself a completion blocker - the row is now properly represented/claimed,
 * which is what matters - but is still surfaced in the failures list so an
 * operator notices a stale unknown record was left behind.
 */
async function clearStaleUnknownRow(sourceType, sourceId) {
  if (!isLive) return;
  try {
    await legacyCollisionService.clearLegacyUnknownRow({ sourceType, sourceId }, db);
  } catch {
    // Best-effort cleanup only; the row's own classification already
    // succeeded via a different path, so this never blocks completion.
  }
}

/**
 * Durably records EVERY collision finding accumulated in `tracker.collisions`
 * (both from the registry cross-check and from in-run duplicates) into
 * paymentSlipLegacyCollisions - IPE-004's fix for the incident where a
 * collision could never be reconciled with "mark complete". No winner is
 * ever picked: every identified member of every finding is recorded under
 * its (kind, identifierHash), which is what makes a future exact match on
 * that hash block via one indexed lookup instead of silently succeeding
 * because the registry has no single owner for it.
 *
 * Deduplicated by (kind, hash, sourceType, sourceId) before writing so a
 * member referenced by more than one finding (e.g. both directions of the
 * SAME clash) is only written once - the underlying UNIQUE index would make
 * a repeat write a no-op anyway, but deduplicating here keeps the reported
 * counters meaningful. Called ONCE, after the full scan completes, so every
 * finding accumulated during the run (including ones discovered via the
 * classifyAgainstRegistry cross-check on a LATER page) is captured.
 */
async function finalizeCollisionRegistry() {
  const seen = new Set();
  const members = [];

  for (const finding of tracker.collisions) {
    if (!finding.hash) continue; // no identifiable hash to record under
    for (const source of [finding.firstSource, finding.secondSource]) {
      if (!source) continue;
      const key = `${finding.kind}|${finding.hash}|${source.sourceType}|${source.sourceId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      members.push({ kind: finding.kind, identifierHash: finding.hash, ...source });
    }
  }

  if (!isLive) {
    stats.wouldRecordCollisionMembers += members.length;
    return;
  }

  for (const member of members) {
    try {
      await legacyCollisionService.recordLegacyCollisionMember(member, db);
      stats.collisionMembersRecorded += 1;
    } catch (error) {
      stats.collisionMembersFailed += 1;
      stats.failures.push({
        source: `${member.sourceType}#${member.sourceId}`,
        stage: "record collision member",
        error: error?.code ?? error?.message ?? "unknown",
      });
    }
  }
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

/**
 * Re-reads one claim and confirms the recovered fileHash actually landed. An
 * enrichment that silently affected zero rows must not be counted as
 * coverage.
 */
async function verifyFileHashPersisted(claimId, expectedFileHash) {
  const rows = await db
    .select()
    .from(schema.paymentSlipClaims)
    .where(eq(schema.paymentSlipClaims.id, claimId))
    .limit(1);
  return rows?.[0]?.fileHash === expectedFileHash;
}

/**
 * The one existing claim for a source, looked up directly by
 * (sourceType, sourceId) rather than by any hash value.
 *
 * Needed specifically for stale-claim migration: a claim written by an OLDER
 * backfill version may hold, as its EXACT `referenceHash`, a value today's
 * derivation would never produce again (see migrateStaleReferenceClaim) -
 * that claim is therefore invisible to classifyAgainstRegistry's hash-based
 * lookup, which only ever queries by values `ids` currently holds.
 */
async function findSameSourceClaim(current) {
  const rows = await db
    .select()
    .from(schema.paymentSlipClaims)
    .where(
      and(
        eq(schema.paymentSlipClaims.sourceType, current.sourceType),
        eq(schema.paymentSlipClaims.sourceId, current.sourceId)
      )
    )
    .limit(1);
  return rows?.[0];
}

/**
 * Repairs a claim an OLDER backfill version wrote before this codebase
 * stopped treating lossy legacy-uppercase evidence as EXACT reference
 * ownership (see scripts/lib/backfillIdentifierDerivation.mjs). That old
 * claim's `referenceHash` hard-blocks any future, genuinely distinct
 * transaction that happens to fold to the same upper-cased value - exactly
 * the bug this closed for NEW backfill runs, except the wrong ownership
 * already written by an OLD run survives untouched by them.
 *
 * ── Provenance, not a guess ─────────────────────────────────────────────
 * Only ever called when TODAY's derivation, run against this row's own
 * stored `extractedData`, independently computes the SAME lossy hash as the
 * claim's stored `referenceHash` (checked by the caller before invoking
 * this). That value could only ever have come from this exact row's own
 * upper-cased reference field via the old buggy code path - never a
 * legitimate exact reference, which would be case-preserving and therefore
 * a DIFFERENT hash. A claim whose referenceHash does not match is left
 * completely untouched.
 *
 * ── What changes ──────────────────────────────────────────────────────────
 * The SAME claim row is migrated in place - never a second INSERT for this
 * source. The obsolete exact `referenceHash` is cleared (it was never
 * legitimate authority), the required advisory alias is ensured, and a
 * freshly recovered exact fileHash is folded in ONLY into an empty slot -
 * an existing fileHash on the claim is never overwritten by this repair.
 */
async function migrateStaleReferenceClaim(staleClaim, ids, expectedAlias, sourceType, rowId) {
  const patch = buildStaleReferenceMigrationPatch(staleClaim, ids, expectedAlias);

  if (!isLive) {
    stats.wouldRepairStaleClaim += 1;
    stats.staleClaimsUncovered += 1;
    console.log(
      `  WOULD_MIGRATE_STALE_LEGACY_CLAIM  ${sourceType}#${rowId}  claim#${staleClaim.id}`
    );
    return;
  }

  try {
    await db
      .update(schema.paymentSlipClaims)
      .set(patch)
      .where(eq(schema.paymentSlipClaims.id, staleClaim.id));

    const rows = await db
      .select()
      .from(schema.paymentSlipClaims)
      .where(eq(schema.paymentSlipClaims.id, staleClaim.id))
      .limit(1);
    const persisted = rows?.[0];
    // Re-read: an update that affected nothing (or landed only partially) is
    // not coverage.
    const ok =
      persisted &&
      persisted.referenceHash === null &&
      persisted.legacyReferenceUpperHash === expectedAlias &&
      (!patch.fileHash || persisted.fileHash === patch.fileHash);

    if (ok) {
      stats.staleClaimsRepaired += 1;
    } else {
      stats.staleClaimsUncovered += 1;
      stats.failures.push({
        source: `${sourceType}#${rowId}`,
        stage: "stale claim migration",
        error: "claim not in expected state after update",
      });
    }
  } catch (error) {
    // A duplicate-key error means the freshly recovered fileHash is ALREADY
    // claimed by a different source - a genuine collision, never swallowed.
    const isDuplicate = error?.code === "ER_DUP_ENTRY" || error?.errno === 1062;
    if (isDuplicate) {
      tracker.collisions.push({
        kind: "file",
        identifier: "(unique index)",
        hash: ids.fileHash,
        first: "existing claim",
        second: `${sourceType}#${rowId}`,
        // The other party is identified only by the database's rejection,
        // not a specific row - recording this row's own membership is still
        // what stops a future exact match on this hash from slipping through.
        secondSource: { sourceType, sourceId: rowId },
      });
    } else {
      stats.staleClaimsUncovered += 1;
      stats.failures.push({
        source: `${sourceType}#${rowId}`,
        stage: "stale claim migration",
        error: error?.code ?? error?.message ?? "unknown",
      });
    }
  }
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

    let ids = derived.identifiers;
    const current = { sourceType, sourceId: row.id };
    // The alias this row REQUIRES. Undefined whenever the casing survived -
    // those rows need no advisory coverage and must never be given one.
    // Truthy ONLY for legacy_uppercase evidence (see deriveIdentifiers).
    const expectedAlias = derived.legacyReferenceUpperHash;

    // Detect a claim an OLDER backfill version wrote for THIS SAME source,
    // before this codebase stopped treating lossy legacy-uppercase evidence
    // as exact reference ownership. Looked up by SOURCE, not by hash: today's
    // derivation has already (correctly) stripped this value from `ids`, so
    // the hash-based registry lookup below can never find it - leaving that
    // wrong ownership to survive every rerun, and a later fresh insert to
    // create a SECOND claim for the same source. See
    // migrateStaleReferenceClaim for the provenance proof this depends on.
    let staleClaim;
    if (expectedAlias) {
      const sameSource = await findSameSourceClaim(current);
      staleClaim = detectStaleReferenceClaim(sameSource, expectedAlias);
    }

    if (!ids.fileHash) {
      // extractedData carried no exact fileHash - whether or not it carried
      // another exact identifier (reference/QR), and whether or not it is
      // NULL entirely. A pre-existing reference/QR must never silently
      // excuse missing file-byte replay coverage: replaying the same image
      // when OCR is disabled or fails could otherwise present only a
      // fileHash and evade a claim that only ever recorded the reference.
      // Recover it server-side from this row's OWN stored slip bytes,
      // exactly as a live submission would.
      const recovery = await recoverFileHashIdentifier({
        slipImageUrl: row.slipImageUrl,
        computeSlipFileHash: fileHashService.computeSlipFileHash,
      });

      if (recovery.fileHash) {
        ids = { ...ids, fileHash: recovery.fileHash };
        stats.fileHashRecovered += 1;
        if (staleClaim) {
          // The stale claim can be fully repaired with this freshly
          // recovered fileHash - migrate it in place and stop; there is
          // nothing left for the normal registry/insert path to do.
          await migrateStaleReferenceClaim(staleClaim, ids, expectedAlias, sourceType, row.id);
          continue;
        }
      } else if (!identifiers.hasStrongIdentifier(ids)) {
        // UNRESOLVED: no identifier in extractedData AND no recoverable file
        // hash. This row has NO claim and remains replayable - it must block
        // --mark-complete, never be silently skipped.
        if (staleClaim) {
          // Still repair the obsolete EXACT ownership even without a
          // replacement fileHash - it must never survive a rerun, since it
          // wrongly hard-blocks any future distinct transaction sharing the
          // same fold. The row itself remains correctly unresolved below.
          await migrateStaleReferenceClaim(staleClaim, ids, expectedAlias, sourceType, row.id);
        }
        stats.noIdentifier += 1;
        stats.unresolvedRows.push({
          source: `${sourceType}#${row.id}`,
          reason: recovery.unresolvedReason,
        });
        // Durably classify as UNKNOWN (paymentSlipLegacyUnknown) rather than
        // leaving this row in a fourth, silently-skipped state. This is what
        // lets --mark-complete succeed even though this row can never be
        // resolved (e.g. no_slip_image_url is permanent) - see
        // scripts/lib/backfillCompletionGate.mjs.
        await recordUnknownRow(sourceType, row.id, recovery.unresolvedReason);
        continue;
      } else {
        // UNRESOLVED: another exact identifier (reference/QR) exists, but
        // exact fileHash coverage could not be established for this row. Per
        // the invariant above, that identifier does NOT excuse the gap - this
        // row is still unresolved and still blocks --mark-complete, even
        // though it "has" a strong identifier.
        if (staleClaim) {
          await migrateStaleReferenceClaim(staleClaim, ids, expectedAlias, sourceType, row.id);
        }
        stats.noIdentifier += 1;
        stats.unresolvedRows.push({
          source: `${sourceType}#${row.id}`,
          reason: recovery.unresolvedReason,
        });
        // Durably classify as UNKNOWN (paymentSlipLegacyUnknown) rather than
        // leaving this row in a fourth, silently-skipped state. This is what
        // lets --mark-complete succeed even though this row can never be
        // resolved (e.g. no_slip_image_url is permanent) - see
        // scripts/lib/backfillCompletionGate.mjs.
        await recordUnknownRow(sourceType, row.id, recovery.unresolvedReason);
        continue;
      }
    }

    if (staleClaim) {
      // ids.fileHash was already present before recovery was even
      // considered (extractedData carried it directly) - the stale claim can
      // still be migrated using it.
      await migrateStaleReferenceClaim(staleClaim, ids, expectedAlias, sourceType, row.id);
      continue;
    }

    // Registry classification: represented only when THIS source already owns
    // EVERY identifier this row carries. Partial or foreign ownership is a
    // reported collision, never a silent skip.

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
      // Best-effort: a prior run may have durably recorded this source as
      // UNKNOWN before a later re-run (fixed data, restored bytes, or a
      // transient recovery failure resolving itself) resolved it properly.
      // Never blocks completion on its own - see clearStaleUnknownRow.
      await clearStaleUnknownRow(sourceType, row.id);
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

    if (registry?.kind === "needs_file_hash") {
      // Another strong identifier is fully owned by this source, but the
      // exact fileHash this row now carries (recovered above, or already
      // present) is absent from that same-source claim - the exact state
      // that let a same-image replay through when its reference/QR could not
      // be recovered. Repair the SAME claim; never insert a second one.
      tracker.remember(ids, current);
      noteLegacyAlias(expectedAlias, current);

      if (!isLive) {
        stats.wouldAddFileHash += 1;
        stats.fileHashUncovered += 1;
        console.log(
          `  WOULD_ADD_FILE_HASH  ${sourceType}#${row.id}  claim#${registry.claim?.id}`
        );
        continue;
      }

      try {
        await db
          .update(schema.paymentSlipClaims)
          .set({ fileHash: registry.expected })
          .where(eq(schema.paymentSlipClaims.id, registry.claim.id));

        // Re-read: an update that affected nothing is not coverage.
        if (await verifyFileHashPersisted(registry.claim.id, registry.expected)) {
          stats.fileHashCoverageAdded += 1;
        } else {
          stats.fileHashUncovered += 1;
          stats.failures.push({
            source: `${sourceType}#${row.id}`,
            stage: "file hash enrichment",
            error: "fileHash not present after update",
          });
        }
      } catch (error) {
        // A duplicate-key error here means this exact fileHash is ALREADY
        // claimed by a different source - a genuine collision the pre-check
        // (a targeted equality lookup, not a live race) missed because it
        // only ran once at classification time.
        const isDuplicate = error?.code === "ER_DUP_ENTRY" || error?.errno === 1062;
        if (isDuplicate) {
          tracker.collisions.push({
            kind: "file",
            identifier: "(unique index)",
            hash: registry.expected,
            first: "existing claim",
            second: `${sourceType}#${row.id}`,
            secondSource: { sourceType, sourceId: row.id },
          });
        } else {
          stats.fileHashUncovered += 1;
          stats.failures.push({
            source: `${sourceType}#${row.id}`,
            stage: "file hash enrichment",
            error: error?.code ?? error?.message ?? "unknown",
          });
        }
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
        // Which exact identifier collided is not reported by the driver -
        // record durably under every present identifier this row carries so
        // none of them is left able to slip through a future indexed lookup.
        for (const [kind, field] of STRONG_FIELDS) {
          if (!ids[field]) continue;
          tracker.collisions.push({
            kind,
            identifier: "(unique index)",
            hash: ids[field],
            first: "existing claim",
            second: `${sourceType}#${row.id}`,
            secondSource: { sourceType, sourceId: row.id },
          });
        }
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
  // GLOBAL scans - every APPROVED row, full stop. Deliberately NOT filtered
  // on extractedData being non-NULL: an approved row from an older
  // OCR-disabled/manual-approval flow can have NULL extraction and still
  // represents real value created, so it must be scanned like any other -
  // deriveIdentifiers/recoverFileHashIdentifier below are what decide
  // whether it is claimable, not the scan predicate. Paged by ascending
  // primary key so coverage is COMPLETE and deterministic. Deliberately NOT
  // a fixed row cap: an arbitrary limit would silently leave later rows
  // unbackfilled and replayable.
  async function scanAll(key, table, statusCol, idCol, extractedCol, extraCols, onPage) {
    let cursor = 0;
    for (;;) {
      const page = await db
        .select({ id: idCol, extractedData: extractedCol, ...extraCols })
        .from(table)
        .where(and(eq(statusCol, "approved"), gt(idCol, cursor)))
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
    { orderId: schema.payments.orderId, slipImageUrl: schema.payments.slipImageUrl },
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
    { userId: schema.walletTopups.userId, slipImageUrl: schema.walletTopups.slipImageUrl },
    async (page) => {
      await processRows("wallet_topup", page);
    }
  );

  // Durably classify every UNRESOLVED row and every COLLISION finding found
  // during the scan, ONCE, now that the full corpus (both tables) has been
  // seen. See recordUnknownRow (called inline per row, since a row's
  // unresolved status is final the moment it is scanned) and
  // finalizeCollisionRegistry (called here, once, so a collision discovered
  // via a claim written on a LATER page is still captured for every member).
  await finalizeCollisionRegistry();

  console.log("\n[backfill] ---- SUMMARY ----");
  console.log(`  scanned approved records : ${stats.scanned}`);
  console.log(`  already represented      : ${stats.alreadyClaimed}`);
  console.log(`  recovered by re-parse    : ${stats.recoveredByReparse}`);
  console.log(`  file hash recovered      : ${stats.fileHashRecovered}`);
  console.log(`  UNRESOLVED (no exact fileHash coverage): ${stats.noIdentifier}`);
  console.log(
    isLive
      ? `  file hash coverage added : ${stats.fileHashCoverageAdded}`
      : `  would add file hash cover: ${stats.wouldAddFileHash}`
  );
  console.log(`  rows lacking file hash cover : ${stats.fileHashUncovered}`);
  console.log(
    isLive
      ? `  stale legacy claims repaired : ${stats.staleClaimsRepaired}`
      : `  would repair stale claims    : ${stats.wouldRepairStaleClaim}`
  );
  console.log(`  stale claims still uncovered : ${stats.staleClaimsUncovered}`);
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
  console.log(
    isLive
      ? `  collision members RECORDED (durable) : ${stats.collisionMembersRecorded}`
      : `  would record collision members       : ${stats.wouldRecordCollisionMembers}`
  );
  console.log(`  collision members FAILED to record   : ${stats.collisionMembersFailed}`);
  console.log(
    isLive
      ? `  unresolved rows RECORDED as unknown (durable) : ${stats.unknownRowsRecorded}`
      : `  would record unresolved rows as unknown       : ${stats.wouldRecordUnknown}`
  );
  console.log(`  unresolved rows FAILED to record as unknown   : ${stats.unknownRowsFailed}`);
  console.log(`  failures                 : ${stats.failures.length}`);

  if (tracker.collisions.length > 0) {
    console.log(
      "\n[backfill] COLLISIONS - durably recorded as KNOWN COLLISIONS (no winner picked;" +
        " does NOT block completion once every member is recorded):"
    );
    for (const c of tracker.collisions) {
      console.log(`  - [${c.kind}] ${c.identifier}  ${c.first}  <->  ${c.second}`);
    }
    console.log(
      "\n  A collision means two APPROVED records share one strong identifier.\n" +
        "  That is either a historical double-credit or a parser bug. It has NOT\n" +
        "  been auto-resolved and no financial record was modified. It is instead\n" +
        "  recorded durably (paymentSlipLegacyCollisions) so any future exact match\n" +
        "  on that identifier is blocked via an indexed lookup, with no winner ever\n" +
        "  chosen among the historical rows."
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

  if (stats.unresolvedRows.length > 0) {
    console.log(
      "\n[backfill] UNRESOLVED - no exact fileHash could be established for this row " +
        "(a reference/QR identifier, if present, does not excuse missing file-byte " +
        "replay coverage). Durably recorded as PERMANENTLY UNKNOWN " +
        "(paymentSlipLegacyUnknown) - this does NOT block completion once every such " +
        "row is recorded, and it is NEVER consulted to block or approve an unrelated " +
        "future submission:"
    );
    for (const u of stats.unresolvedRows) {
      // Only sourceType/sourceId and a fixed reason code - never a slip URL,
      // secret, or hash.
      console.log(`  - ${u.source}  (${u.reason})`);
    }
    console.log(
      "\n  This approved record is missing exact fileHash replay coverage and remains\n" +
        "  replayable on the file axis IF something turns out to be a byte-identical\n" +
        "  copy of it - but its own identity can never be established (most commonly\n" +
        "  no_slip_image_url: the bytes are permanently gone), so there is nothing\n" +
        "  further this tool, or any future scan, could ever do about it. Recording it\n" +
        "  explicitly is what lets the backfill be marked complete despite it."
    );
  }

  // ── Completion ─────────────────────────────────────────────────────────
  // See scripts/lib/backfillCompletionGate.mjs for the exact rule and why it
  // no longer requires zero unresolved rows or zero collisions - both are
  // permanent facts about historical data that can be durably CLASSIFIED but
  // can never be reduced to zero by any number of re-runs. What still blocks
  // completion is a row landing in NONE of protected/collision/unknown: a
  // processing failure, an operator-only alias inconsistency, or a failed
  // durable write for a collision/unknown record.
  const gate = evaluateBackfillCompletion(
    {
      failures: stats.failures,
      aliasUncovered: stats.aliasUncovered,
      aliasInconsistencies: stats.aliasInconsistencies,
      fileHashUncovered: stats.fileHashUncovered,
      staleClaimsUncovered: stats.staleClaimsUncovered,
      unknownRowsFailed: stats.unknownRowsFailed,
      collisionMembersFailed: stats.collisionMembersFailed,
    },
    reachedEof
  );
  const cleanRun = gate.cleanRun;

  if (markComplete) {
    if (!cleanRun) {
      console.error(
        "\n[backfill] REFUSING to mark complete. A completion flag disables the legacy\n" +
          "           safety scan, so it is only written after every historical row has\n" +
          "           been classified as protected, collision, or unknown - with no\n" +
          "           processing failures:\n" +
          `             ${gate.reasons.join(" ") || "(no reasons - unexpected)"}\n` +
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
        collisionMembersRecorded: stats.collisionMembersRecorded,
        unknownRowsRecorded: stats.unknownRowsRecorded,
      });
      console.log(
        "\n[backfill] Marked COMPLETE. The approval path will now rely on the durable\n" +
          "           registries (paymentSlipClaims, paymentSlipLegacyCollisions) via\n" +
          "           indexed lookups and skip the historical scan entirely. Every new\n" +
          "           approval still writes its own claim atomically; the " +
          `${stats.unknownRowsRecorded} permanently\n` +
          "           unknown historical row(s) are on file for operators but are never\n" +
          "           consulted to block or approve an unrelated future submission."
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

  // A genuine problem (a processing failure, an operator-only alias
  // inconsistency, or a durable classification write that itself failed)
  // always exits non-zero. Collisions and unresolved rows that were
  // successfully, durably classified are the EXPECTED steady state for a
  // corpus with real historical data - they no longer make a clean live run
  // "look failed" forever. A dry run still exits non-zero whenever there is
  // anything for an operator to review before going live, since nothing was
  // actually written yet.
  const hasGenuineProblem =
    stats.failures.length > 0 ||
    stats.aliasInconsistencies.length > 0 ||
    stats.collisionMembersFailed > 0 ||
    stats.unknownRowsFailed > 0;
  const dryRunHasFindings = !isLive && (tracker.collisions.length > 0 || stats.noIdentifier > 0);

  if (hasGenuineProblem || dryRunHasFindings) {
    process.exitCode = 1;
  }
} finally {
  await connection.end();
}
