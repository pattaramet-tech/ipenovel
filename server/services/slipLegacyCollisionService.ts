/**
 * Durable legacy evidence registry: KNOWN COLLISIONS and PERMANENTLY UNKNOWN
 * rows. Replaces the O(N) historical scan's two "can't resolve cleanly"
 * outcomes with two indexed, durable tables written once by the backfill.
 *
 * ── Why this exists (IPE-004 hotfix) ──────────────────────────────────────
 * The pre-hotfix design (legacySlipCompatibilityService) paged through every
 * approved historical row on every new approval and failed closed the moment
 * it hit ANY row it could not fully verify - even a row with nothing to do
 * with the payment being approved. A production dry-run backfill found 915
 * historical rows (out of 4,147) whose file identity can NEVER be recovered
 * (`no_slip_image_url` - the row simply has no slip image URL, so its bytes
 * are gone forever) and 114 genuine strong-identifier collisions among
 * historical rows (85 reference, 29 file). Neither fact can ever change, so
 * a scan that fails closed on them blocks legitimate, wholly unrelated
 * approvals FOREVER, which is the incident this module fixes.
 *
 * The fix is not to weaken anti-replay - it's to stop re-deriving the same
 * unresolvable facts on every approval and instead record them ONCE, durably,
 * in a shape a new approval can check with an indexed lookup on ITS OWN
 * identifiers:
 *
 *   KNOWN COLLISION - two or more historical rows already share one exact
 *   identifier hash. No winner is ever picked (that would fabricate
 *   uniqueness over financial history). Any future submission whose own
 *   identifier hash matches is blocked from auto-approval - not because it IS
 *   necessarily one of those historical rows, but because we already know
 *   this exact identifier is not safe to treat as unclaimed.
 *
 *   PERMANENTLY UNKNOWN - a historical row's file identity can never be
 *   established. Recorded primarily for operator/audit visibility - it is
 *   NEVER used as a global duplicate match (an unrelated new submission has
 *   no way to collide with an identifier that was never computed, and
 *   forcing every future approval to treat "some unrelated row somewhere is
 *   unknown" as a reason to stop is exactly the defect being fixed here).
 *   It IS consulted for one narrow, bounded, indexed purpose (IPE-004-C03,
 *   `findAnyLegacyFileIdentityUnknown` below): once the O(N) scan retires,
 *   a current submission whose ONLY strong evidence is a fileHash cannot be
 *   proven clean on the file axis while ANY permanently-unknown row exists,
 *   since it could be a byte-identical replay of one - this check is a
 *   single `LIMIT 1` read, never a scan, and never fires for a submission
 *   that also carries a reference or QR (those axes are fully covered by
 *   the indexed registries and are never affected by this table's contents).
 *
 * Both tables are ONLY ever written by the backfill tool
 * (scripts/backfill-slip-claims.mjs). A live approval path never inserts
 * here - it only reads, via the indexed lookups below.
 */

import { paymentSlipLegacyCollisions, paymentSlipLegacyUnknown } from "../../drizzle/schema";
import { and, eq } from "drizzle-orm";
import type { StrongDuplicateKind, SlipStrongIdentifiers } from "./slipIdentifierService";

export type LegacyCollisionSourceType = "order_payment" | "wallet_topup";

export interface LegacyCollisionMatch {
  kind: StrongDuplicateKind;
  identifierHash: string;
  /** One representative member, for admin display/navigation only. */
  matchedSourceType: LegacyCollisionSourceType;
  matchedSourceId: number;
}

const KIND_FIELD: Record<StrongDuplicateKind, keyof SlipStrongIdentifiers> = {
  reference: "referenceHash",
  file: "fileHash",
  qr: "qrPayloadHash",
};

/**
 * Indexed lookup: does the incoming submission's own strong identifier match
 * a KNOWN historical collision? One query per present identifier kind, each
 * hitting `paymentSlipLegacyCollisions_identifierHash_idx` (kind,
 * identifierHash) - no table scan, no pagination, bounded by the number of
 * identifiers the incoming slip actually carries (at most three).
 *
 * Read-only. Returns the first match found, checked in a fixed order
 * (reference, file, qr) purely for determinism; a real collision would only
 * ever exist on one axis for a given incoming identifier value in practice.
 *
 * The collision FACT is "this hash is in paymentSlipLegacyCollisions" - it
 * never depends on excluding the caller. The backfill records EVERY member of
 * a colliding group (the historical owner AND the row that clashed with it),
 * so a genuine collision is authoritative no matter which member is being
 * evaluated. `self`, when given, only picks a DIFFERENT member as the
 * `matchedSource` for admin display/navigation when one exists; if the only
 * recorded member is the caller, that still counts as a match and fails
 * closed - a lone self-member is a degenerate/partial registry state and the
 * safe direction there is manual review, never a silent singleton "winner".
 */
export async function findKnownLegacyCollision(
  identifiers: SlipStrongIdentifiers,
  tx: any,
  self?: { sourceType: LegacyCollisionSourceType; sourceId: number }
): Promise<LegacyCollisionMatch | undefined> {
  for (const kind of ["reference", "file", "qr"] as StrongDuplicateKind[]) {
    const hash = identifiers[KIND_FIELD[kind]];
    if (!hash) continue;

    const rows = await tx
      .select()
      .from(paymentSlipLegacyCollisions)
      .where(
        and(eq(paymentSlipLegacyCollisions.kind, kind), eq(paymentSlipLegacyCollisions.identifierHash, hash))
      )
      .limit(5);

    const all = (rows ?? []) as any[];
    if (all.length === 0) continue;
    // Prefer a member that is NOT the caller for display; fall back to any.
    const row =
      all.find(
        (r) => !(self && r.sourceType === self.sourceType && r.sourceId === self.sourceId)
      ) ?? all[0];
    return {
      kind,
      identifierHash: hash,
      matchedSourceType: row.sourceType as LegacyCollisionSourceType,
      matchedSourceId: row.sourceId as number,
    };
  }

  return undefined;
}

/**
 * Does ANY historical approved row have a permanently-unknown file identity
 * (paymentSlipLegacyUnknown)? One bounded `LIMIT 1` read - never a scan of
 * the row corpus.
 *
 * This is the post-completion file-axis sufficiency signal. Once the O(N)
 * historical scan is retired, the reference and QR axes are fully covered by
 * the indexed registries, but a subset of historical rows (`no_slip_image_url`)
 * permanently lost their slip bytes, so their exact fileHash could never be
 * computed and is in NO registry. If any such row exists, a current
 * submission whose ONLY strong evidence is a fileHash cannot be proven safe
 * and must fail closed - see evaluateSlipConflict.
 *
 * Returns one representative row for admin display/navigation, or undefined
 * when the unknown registry is empty (nothing to fail closed over).
 */
export async function findAnyLegacyFileIdentityUnknown(
  tx: any
): Promise<{ sourceType: LegacyCollisionSourceType; sourceId: number } | undefined> {
  const rows = await tx.select().from(paymentSlipLegacyUnknown).limit(1);
  const row = (rows ?? [])[0];
  return row
    ? {
        sourceType: row.sourceType as LegacyCollisionSourceType,
        sourceId: row.sourceId as number,
      }
    : undefined;
}

/**
 * Idempotently records one member of a known collision group. Safe to call
 * more than once for the same (kind, identifierHash, sourceType, sourceId) -
 * the UNIQUE index makes a repeat call a no-op, which is what makes the
 * backfill safe to re-run.
 *
 * Never called by a live approval - only the backfill tool.
 */
export async function recordLegacyCollisionMember(
  member: {
    kind: StrongDuplicateKind;
    identifierHash: string;
    sourceType: LegacyCollisionSourceType;
    sourceId: number;
  },
  tx: any
): Promise<{ recorded: boolean; alreadyPresent: boolean }> {
  try {
    await tx.insert(paymentSlipLegacyCollisions).values({
      kind: member.kind,
      identifierHash: member.identifierHash,
      sourceType: member.sourceType,
      sourceId: member.sourceId,
    });
    return { recorded: true, alreadyPresent: false };
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      return { recorded: true, alreadyPresent: true };
    }
    throw error;
  }
}

/**
 * Idempotently records that a historical row's file identity is permanently
 * unknown. Safe to call more than once for the same source - the UNIQUE
 * (sourceType, sourceId) index makes a repeat call a no-op.
 *
 * Never called by a live approval - only the backfill tool.
 */
export async function recordLegacyUnknownRow(
  row: { sourceType: LegacyCollisionSourceType; sourceId: number; reason: string },
  tx: any
): Promise<{ recorded: boolean; alreadyPresent: boolean }> {
  try {
    await tx.insert(paymentSlipLegacyUnknown).values({
      sourceType: row.sourceType,
      sourceId: row.sourceId,
      reason: row.reason,
    });
    return { recorded: true, alreadyPresent: false };
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      return { recorded: true, alreadyPresent: true };
    }
    throw error;
  }
}

/**
 * Removes a stale "unknown" record for one source, e.g. because a re-run of
 * the backfill was able to establish its identity after all (the underlying
 * slip bytes became recoverable, or the recovery primitive stopped failing
 * transiently). Never called for `no_slip_image_url` rows in practice - that
 * reason can never become resolvable - but kept generic and safe to call
 * unconditionally so the backfill does not need to special-case the reason.
 *
 * Never called by a live approval - only the backfill tool.
 */
export async function clearLegacyUnknownRow(
  source: { sourceType: LegacyCollisionSourceType; sourceId: number },
  tx: any
): Promise<void> {
  await tx
    .delete(paymentSlipLegacyUnknown)
    .where(
      and(
        eq(paymentSlipLegacyUnknown.sourceType, source.sourceType),
        eq(paymentSlipLegacyUnknown.sourceId, source.sourceId)
      )
    );
}

/**
 * MySQL/MariaDB duplicate-key signals. Checked structurally rather than by
 * message text so a locale-translated server message still classifies.
 */
function isDuplicateKeyError(error: unknown): boolean {
  const e = error as { code?: string; errno?: number; message?: string } | null;
  if (!e) return false;
  if (e.code === "ER_DUP_ENTRY") return true;
  if (e.errno === 1062) return true;
  return typeof e.message === "string" && /duplicate entry/i.test(e.message);
}

/** Admin-safe description of a known collision. Never leaks a hash. */
export function describeLegacyCollision(match: LegacyCollisionMatch): string {
  const what =
    match.kind === "file"
      ? "This exact slip image"
      : match.kind === "qr"
        ? "This slip's QR payload"
        : "This bank transaction reference";
  const where =
    match.matchedSourceType === "order_payment"
      ? `order payment #${match.matchedSourceId}`
      : `wallet top-up #${match.matchedSourceId}`;
  return (
    `${what} is already known to be shared by MORE THAN ONE approved historical record ` +
    `(including ${where}), discovered during the legacy backfill. No single historical ` +
    `record was picked as the "real" owner - that would fabricate uniqueness over financial ` +
    `history. This is NOT proof this submission is one of them, but it cannot be auto-approved. ` +
    `Manual investigation of the complete historical group is required.`
  );
}
