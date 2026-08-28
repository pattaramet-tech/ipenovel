/**
 * Advanced Account Merge - typed domain contracts (IPE-003 Foundation).
 *
 * Shared shapes between this phase's read-only preview
 * (server/services/accountMergePreviewService.ts) and the later execution
 * phases (IPE-005 Guard & Concurrency, IPE-006 Financial, IPE-007
 * Entitlements/User Data, IPE-008 Final Orchestration/Admin UI) - defined
 * once here so a later phase extends these types instead of each phase
 * re-deriving its own, drifting shape for the same concepts.
 */

/** Which classified bucket (see accountRecoveryDataClassification.ts) a
 *  merge-inventoried table belongs to - "indirect_*" for a table with no
 *  direct userId column, reached only via a parent FK (see
 *  ACCOUNT_RECOVERY_INDIRECT_TABLES). */
export type AccountMergeTableCategory =
  | "economic"
  | "user_owned"
  | "indirect_economic"
  | "indirect_user_owned";

/**
 * What a LATER execution phase would need to do with this table's rows for
 * this specific source/target pair - descriptive only in this phase, never
 * acted on here.
 *
 * - "no_action": zero rows on the source side - nothing to move.
 * - "transfer_only": source has rows, this table has its own direct
 *   `userId` column, and no per-account uniqueness constraint that a
 *   straightforward `userId` re-parent could ever violate (an append-only
 *   ledger/history table).
 * - "preserve_via_parent": source has rows in an INDIRECT table - one with
 *   no direct `userId` column at all (category "indirect_economic"/
 *   "indirect_user_owned"), reached only through a parent FK
 *   (cartItems -> carts, orderItems/payments/orderHistory -> orders). A
 *   later phase never re-parents these by `userId` because there is no such
 *   column to rewrite; the rows simply follow their already-inventoried
 *   parent when it moves. Deliberately NOT "transfer_only", which means a
 *   direct `userId` re-parent this table cannot have.
 * - "consolidate_singleton": the table enforces UNIQUE(userId) - both
 *   source and target already own their own single row, so a later phase
 *   must explicitly combine them (e.g. sum a wallet balance), never a
 *   plain re-parent (which would violate the unique constraint outright).
 * - "transfer_with_dedupe": the table enforces a UNIQUE(userId, <content>)
 *   constraint - most rows can be re-parented as-is, but `conflictCount`
 *   rows collide with a row the target already owns and need an explicit
 *   resolution rule from a later phase.
 */
export type AccountMergeProjectedAction =
  | "no_action"
  | "transfer_only"
  | "preserve_via_parent"
  | "consolidate_singleton"
  | "transfer_with_dedupe";

export type AccountMergeTableFinding = {
  table: string;
  category: AccountMergeTableCategory;
  /** Exact row count for the source account - never a presence-only probe. */
  sourceCount: number;
  /** Exact row count for the target account. */
  targetCount: number;
  /** Rows whose per-account unique key ALSO exists on the target side - a
   *  plain `userId` re-parent of these specific rows would violate that
   *  constraint. 0 for a table with no such constraint (see
   *  AccountMergeProjectedAction's "transfer_only"/"consolidate_singleton"
   *  docs for how those cases are represented instead). */
  conflictCount: number;
  projectedAction: AccountMergeProjectedAction;
  warnings: string[];
};

/** A wallet-balance or points-balance projection - DATA ONLY. Nothing in
 *  IPE-003 ever writes a balance, ledger row, or wallet/points transaction;
 *  see accountMergePreviewService.ts's own docstring for the proof. */
export type AccountMergeBalanceProjection = {
  /** Exact decimal string (never a floating-point number) - the source
   *  account's CURRENT balance, unchanged by computing this projection. */
  sourceBalance: string;
  /** The target account's CURRENT balance. */
  targetBalance: string;
  /** sourceBalance + targetBalance, exact decimal string (moneyAdd) - what
   *  the target's balance WOULD become if a later phase merged the two
   *  accounts today. Never written anywhere by this phase. */
  projectedMergedBalance: string;
};

/**
 * Fail-closed identity/eligibility validation for a candidate source/target
 * pair - computed BEFORE any table inventory or projection, and gates
 * whether that inventory is even meaningful (see
 * AccountMergePreview.tableFindings' own note: empty whenever this is not
 * `isValid`).
 *
 * Deliberately carries ONLY booleans for identity facts (sourceExists,
 * ...HasGoogleIdentity, etc.) - never a raw Google `sub`/email/openId, the
 * same redaction rule accountRecoveryService.ts's
 * AccountRecoverySafetyAssessmentDto already enforces for the sibling
 * Account Recovery workflow.
 */
export type AccountMergeTargetValidation = {
  sourceUserId: number;
  targetUserId: number;
  sourceExists: boolean;
  targetExists: boolean;
  sourceIsAdmin: boolean;
  targetIsAdmin: boolean;
  /** The evidence a future merge execution phase would rely on - source
   *  must genuinely own a real, database-verified Google identity (never a
   *  claimed/typed one - see accountRecoveryService.ts's identical rule). */
  sourceHasGoogleIdentity: boolean;
  /** Target must have NO Google identity yet - a future merge would give
   *  the target the source's identity, exactly like Account Recovery's own
   *  identity-move rule. */
  targetHasGoogleIdentity: boolean;
  distinctAccounts: boolean;
  /** Non-empty means this specific source/target pairing must never be
   *  treated as mergeable - no admin override, same invariant as
   *  AccountRecoverySafetyAssessment.blockReasons. */
  blockers: string[];
  /** True only when blockers is empty. */
  isValid: boolean;
};

/** Informational only - proves paymentSlipClaims/OCR anti-replay evidence
 *  was READ, never written, and documents why a later merge execution
 *  phase must never touch or rewrite these rows (the anti-replay
 *  invariant they enforce is orthogonal to which `users` row owns them). */
export type AccountMergePaymentSlipClaimsInfo = {
  sourceCount: number;
  note: string;
};

/**
 * The full read-only merge preview response for one (blocked recovery
 * request, candidate target) pair - see accountMergePreviewService.ts's
 * buildAccountMergePreview for how this is assembled, and
 * server/routers.ts's accountMerge.admin.preview for the only procedure
 * that returns it.
 */
export type AccountMergePreview = {
  requestId: number;
  sourceUserId: number;
  targetUserId: number;
  targetValidation: AccountMergeTargetValidation;
  /** Empty whenever targetValidation.isValid is false - a preview computed
   *  against an invalid pairing is not meaningful data, not merely
   *  incomplete data. */
  tableFindings: AccountMergeTableFinding[];
  walletProjection: AccountMergeBalanceProjection;
  pointsProjection: AccountMergeBalanceProjection;
  paymentSlipClaims: AccountMergePaymentSlipClaimsInfo;
  /** Aggregated from targetValidation.blockers when the pairing itself is
   *  invalid, or from every tableFindings[] entry a later phase could not
   *  auto-resolve today (a non-empty conflictCount, singleton or
   *  dedupe-keyed) when it is valid - human-readable, never merely a
   *  count. A non-empty hardBlockers list on an OTHERWISE valid preview is
   *  normal, expected content for a genuinely non-empty account, NOT an
   *  error - it is exactly the review information a later execution phase
   *  and the admin need, never a reason by itself to call the preview
   *  invalid (see isPreviewValid below). */
  hardBlockers: string[];
  warnings: string[];
  /** True only when targetValidation.isValid - i.e. this specific
   *  source/target pairing is legitimate and every field above is
   *  trustworthy data about it. Deliberately NOT downgraded by a non-empty
   *  hardBlockers/tableFindings conflict count - those describe the
   *  ACCOUNT's data, not a problem with the preview itself. */
  isPreviewValid: boolean;
};
