/**
 * The single, exhaustively-audited inventory of every user-referencing
 * column in drizzle/schema.ts, and how each one is treated by the Admin
 * Users Management hard-delete safety check
 * (server/db.ts's getAdminUserDeleteAssessment, orchestrated by
 * server/services/adminUserManagementService.ts's deleteAdminUserSafely -
 * see that function's own docstring for why it is NOT currently wired to
 * any tRPC procedure, pending a concurrency-safety fix from PR #45's
 * security review).
 *
 * Deliberately a SEPARATE inventory from
 * server/services/accountRecoveryDataClassification.ts, not a reuse of it -
 * that file's `deliberately_ignored` category exists specifically because
 * the Account Recovery workflow only ever cares about the SOURCE account's
 * own data, and treats an admin/actor reference (who reviewed a payment,
 * who created a top-up log, ...) as irrelevant. Deleting a user is
 * different: if this account ever acted as an admin/reviewer/creator on
 * some other row, hard-deleting it would either orphan that reference or
 * silently destroy who-did-what history, so those columns MUST also block
 * deletion here even though Account Recovery correctly ignores them.
 *
 * This list is CROSS-CHECKED by
 * server/services/adminUserDeletionClassification.test.ts against a
 * runtime reflection over every real `drizzle/schema.ts` table (via
 * drizzle-orm's `getTableColumns`/`is(..., MySqlTable)`, not a hand-typed
 * guess) for exactly two properties:
 *   1. every user-referencing (dataType "number", name matching
 *      /userid|ownerid|createdby|reviewedby|approvedby|actorid|adminid/i)
 *      column that actually exists in the schema has a matching entry
 *      here (fails loudly if a new column like this is ever added to the
 *      schema without a corresponding classification decision);
 *   2. every entry here still corresponds to a real, existing
 *      table+column (fails loudly if a table/column is renamed or removed
 *      and this file silently goes stale).
 *
 * Categories:
 * - "economic": wallet/balance/points, purchases, orders, payments,
 *   transactions, purchased episodes, coupons/financial rights. ANY row
 *   here on the target account is an unconditional, no-admin-override
 *   block on deletion.
 * - "user_owned": cart, library/wishlist, reading progress, check-ins, and
 *   any other non-economic per-user data. Also an unconditional block -
 *   a hard delete is only ever permitted for a genuinely, completely
 *   empty account.
 * - "audit_or_actor": this account acted as an ADMIN/reviewer/creator/
 *   requester somewhere else in the schema (approved a payment, reviewed a
 *   top-up, authored a campaign, requested/reviewed an account recovery,
 *   ...). Blocking here (unlike Account Recovery's deliberately_ignored
 *   treatment of the same columns) exists specifically to protect
 *   who-did-what audit trails that would otherwise silently point at a
 *   deleted row.
 * - "login_data": authIdentities.userId - the target's OWN login
 *   credential row, not third-party data. NEVER a blocker - the delete
 *   transaction deletes it together with the users row in the same
 *   transaction (see deleteAdminUserTransaction).
 * - "never_blocks": every other column that structurally cannot represent
 *   real, protectable data about the target account - an unverified,
 *   user-typed claim (accountRecoveryRequests.requestedLegacyUserId), or
 *   this feature's OWN audit trail's `targetUserId` (adminUserAuditLogs),
 *   which is deliberately built with no foreign key specifically so it
 *   survives a target user's hard delete (see drizzle/schema.ts's
 *   adminUserAuditLogs doc comment) - it would be self-defeating for that
 *   same "what was done to this user" record to also block the deletion it
 *   exists to outlive. NOTE: adminUserAuditLogs.actorAdminId is the OPPOSITE
 *   case - it IS an audit_or_actor blocker (see that category above) - the
 *   two columns on this one table are deliberately classified differently.
 */

export type AdminUserDeletionCategory = "economic" | "user_owned" | "audit_or_actor" | "login_data" | "never_blocks";

export type AdminUserDeletionColumnClassification = {
  table: string;
  column: string;
  category: AdminUserDeletionCategory;
  /** Human-readable label for the blocker's `reference` field in
   *  admin.users.deleteAssessment's response - never a table/column name
   *  verbatim, always a category-level description (never real row data). */
  reference: string;
  reason: string;
};

export const ADMIN_USER_DELETION_CLASSIFICATION: AdminUserDeletionColumnClassification[] = [
  // ---- login_data: the target's own login credential, never a blocker ----
  {
    table: "authIdentities",
    column: "userId",
    category: "login_data",
    reference: "Auth Identities",
    reason:
      "The target account's own Google login row - not third-party data to block on. Deleted in the SAME transaction as the users row (see deleteAdminUserTransaction), never left orphaned.",
  },

  // ---- economic: wallet/points/purchases/orders/payments/transactions/coupons ----
  { table: "orders", column: "userId", category: "economic", reference: "Orders", reason: "A financial transaction record." },
  { table: "purchases", column: "userId", category: "economic", reference: "Purchases", reason: "A content-purchase entitlement." },
  { table: "episodePurchases", column: "userId", category: "economic", reference: "Episode Purchases", reason: "A wallet-paid content-purchase entitlement." },
  { table: "walletAccounts", column: "userId", category: "economic", reference: "Wallet Account", reason: "The wallet balance itself." },
  { table: "walletTransactions", column: "userId", category: "economic", reference: "Wallet Transactions", reason: "A wallet ledger entry." },
  { table: "walletTopups", column: "userId", category: "economic", reference: "Wallet Top-ups", reason: "A wallet top-up (money in)." },
  { table: "topupLogs", column: "userId", category: "economic", reference: "Top-up Logs", reason: "An admin-audit record of a real credited top-up - financial history, owned by this user." },
  { table: "pointsTransactions", column: "userId", category: "economic", reference: "Points Transactions", reason: "The points-balance ledger - a redeemable financial right." },
  { table: "couponUsages", column: "userId", category: "economic", reference: "Coupon Usages", reason: "A record of a coupon (discount/financial right) having been spent on a real order." },
  { table: "coupons", column: "ownerUserId", category: "economic", reference: "Personal Coupons", reason: "A personal coupon (scope=\"user\") is itself an unredeemed financial right belonging to this account." },
  { table: "sportsMatchVotes", column: "userId", category: "economic", reference: "Sports Votes", reason: "Records real points spent on a wager, and may reference an issued reward coupon." },
  { table: "sportsMatchRewards", column: "userId", category: "economic", reference: "Sports Match Rewards", reason: "A reward coupon issued to this user - a financial right." },
  { table: "dailyCheckinRewardGrants", column: "userId", category: "economic", reference: "Daily Check-in Reward Grants", reason: "A granted points/coupon reward - a financial right, distinct from the check-in event itself." },

  // ---- user_owned: cart/library/reading progress/check-ins ----
  { table: "carts", column: "userId", category: "user_owned", reference: "Cart", reason: "The user's shopping cart." },
  { table: "wishlists", column: "userId", category: "user_owned", reference: "Wishlist", reason: "The user's wishlist/library." },
  { table: "readingProgress", column: "userId", category: "user_owned", reference: "Reading Progress", reason: "Per-episode reading position/progress." },
  { table: "dailyCheckins", column: "userId", category: "user_owned", reference: "Daily Check-ins", reason: "The check-in event record itself (date/streak)." },

  // ---- audit_or_actor: this account acted as an admin/reviewer/creator/requester elsewhere ----
  { table: "orderHistory", column: "actorUserId", category: "audit_or_actor", reference: "Order History Actor References", reason: "Records this account performing an order status transition - deleting it would orphan that audit trail." },
  { table: "payments", column: "reviewedByUserId", category: "audit_or_actor", reference: "Payment/Admin Review References", reason: "This account reviewed a payment slip - an admin-actor reference that must survive." },
  { table: "payments", column: "approvedByAdminId", category: "audit_or_actor", reference: "Payment/Admin Review References", reason: "This account approved a payment - an admin-actor reference that must survive." },
  { table: "walletTopups", column: "reviewedByUserId", category: "audit_or_actor", reference: "Wallet Review/Approval References", reason: "This account reviewed a wallet top-up." },
  { table: "walletTopups", column: "approvedByAdminId", category: "audit_or_actor", reference: "Wallet Review/Approval References", reason: "This account approved a wallet top-up." },
  { table: "topupLogs", column: "createdBy", category: "audit_or_actor", reference: "Top-up Log Creator References", reason: "This account authored a top-up log entry (admin/system actor, not the log's own owner)." },
  { table: "dailyCheckinCampaigns", column: "createdBy", category: "audit_or_actor", reference: "Daily Check-in Campaign Creator References", reason: "This account authored a global daily check-in campaign config." },
  { table: "accountRecoveryRequests", column: "requesterUserId", category: "audit_or_actor", reference: "Account Recovery Requests", reason: "This account filed an account-recovery request - part of that workflow's own audit trail." },
  { table: "accountRecoveryRequests", column: "reviewedByAdminId", category: "audit_or_actor", reference: "Account Recovery Requests", reason: "This account reviewed an account-recovery request." },
  { table: "accountRecoveryRequests", column: "sourceUserId", category: "audit_or_actor", reference: "Account Recovery Requests", reason: "This account was the source of an executed account-recovery move." },
  { table: "accountRecoveryRequests", column: "targetUserId", category: "audit_or_actor", reference: "Account Recovery Requests", reason: "This account was the target of an executed account-recovery move." },
  { table: "accountRecoveryAuditLogs", column: "actorAdminId", category: "audit_or_actor", reference: "Account Recovery Audit References", reason: "This account performed an audited account-recovery transition." },
  { table: "accountRecoveryAuditLogs", column: "sourceUserId", category: "audit_or_actor", reference: "Account Recovery Audit References", reason: "This account was the source in an account-recovery audit entry." },
  { table: "accountRecoveryAuditLogs", column: "targetUserId", category: "audit_or_actor", reference: "Account Recovery Audit References", reason: "This account was the target in an account-recovery audit entry." },
  // IPE-003: Advanced Account Merge's own case/audit rows - same
  // protection as the accountRecoveryRequests/accountRecoveryAuditLogs
  // entries above, for the same reason.
  { table: "accountMergeCases", column: "sourceUserId", category: "audit_or_actor", reference: "Account Merge Cases", reason: "This account was the source of a merge case." },
  { table: "accountMergeCases", column: "targetUserId", category: "audit_or_actor", reference: "Account Merge Cases", reason: "This account was the target of a merge case." },
  { table: "accountMergeCases", column: "createdByAdminId", category: "audit_or_actor", reference: "Account Merge Cases", reason: "This account (an admin) created a merge case." },
  { table: "accountMergeAuditLogs", column: "actorAdminId", category: "audit_or_actor", reference: "Account Merge Audit References", reason: "This account performed an audited merge action." },
  { table: "accountMergeAuditLogs", column: "sourceUserId", category: "audit_or_actor", reference: "Account Merge Audit References", reason: "This account was the source in a merge audit entry." },
  { table: "accountMergeAuditLogs", column: "targetUserId", category: "audit_or_actor", reference: "Account Merge Audit References", reason: "This account was the target in a merge audit entry." },
  {
    table: "adminUserAuditLogs",
    column: "actorAdminId",
    category: "audit_or_actor",
    reference: "Admin User Audit Log Actor References",
    reason:
      "Review finding on PR #45: this account is the ADMIN who performed a prior name/role edit or delete (recorded while it still held role=\"admin\"). Protecting audit_or_actor identity is exactly this category's purpose - a former admin's actions must remain attributable after a later demotion, so this must block deletion even though it lives in this feature's own audit table (unlike targetUserId below, which is deliberately NOT protected the same way).",
  },

  {
    table: "paymentSlipReviewResolutions",
    column: "adminUserId",
    category: "audit_or_actor",
    reference: "Legacy Case Resolution Actor References",
    reason:
      "This account is the ADMIN who resolved a legacy reference case ambiguity - the one place a human deliberately overrides an automated anti-replay signal on a financial record. Exactly the who-did-what identity this category exists to protect, so it blocks deletion; the decision must stay attributable even after a later demotion.",
  },
  {
    table: "ocrVerificationAttempts",
    column: "initiatedByUserId",
    category: "audit_or_actor",
    reference: "OCR Recheck Actor References",
    reason:
      "This account is the ADMIN who requested an OCR recheck on someone else's payment. Same reasoning as adminUserAuditLogs.actorAdminId: a former admin's diagnostic actions on a financial record must remain attributable after a later demotion, so this blocks deletion. NULL on automatic (system-initiated) attempts, which therefore reference no user at all.",
  },

  // ---- economic: financial value creation ----
  {
    table: "paymentSlipClaims",
    column: "userId",
    category: "economic",
    reference: "Payment Slip Claims",
    reason:
      "A claim row is proof this account consumed a real bank transaction to create financial value (an order payment or a wallet top-up), so it is economic evidence in its own right - and such an account is already blocked by the underlying payments/orders/walletTopups rows anyway. Critically, the claim row itself must NEVER be deleted along with the user: paymentSlipClaims is the global anti-replay registry, and removing a user's claims would re-open every slip they ever used for replay by anyone. Like adminUserAuditLogs it carries no foreign key precisely so it outlives the accounts it references; unlike that table it also BLOCKS deletion, because it represents money rather than a record of administration.",
  },

  // ---- never_blocks: unverified claims and this feature's own self-outliving audit trail ----
  {
    table: "accountRecoveryRequests",
    column: "requestedLegacyUserId",
    category: "never_blocks",
    reference: "Account Recovery Requests (Unverified Claim)",
    reason: "A user-typed, NEVER-VERIFIED claim of a legacy account id, shown to an admin for context only (see accountRecoveryDataClassification.ts's identical \"recovery_internal\" treatment of this same column) - not evidence the claimed user has any real data here, so it must never block that user's deletion.",
  },
  {
    table: "adminUserAuditLogs",
    column: "targetUserId",
    category: "never_blocks",
    reference: "Admin User Audit Logs",
    reason: "This feature's OWN append-only audit trail, deliberately built with no foreign key specifically so it survives a target user's hard delete (see drizzle/schema.ts's adminUserAuditLogs doc comment) - the record of what was done TO this user must remain readable after they're gone, so this column alone must never block that deletion. Contrast actorAdminId above, which protects a different identity (WHO did it) and IS a blocker.",
  },
];

/**
 * Tables with NO direct user-id-shaped column at all, whose rows are still
 * transitively "this user's data" only through a foreign key to an
 * already-classified table - same purpose as
 * accountRecoveryDataClassification.ts's ACCOUNT_RECOVERY_INDIRECT_TABLES.
 * Not part of the reflection-based column check above (there is no user-id
 * column on these tables to reflect over), and intentionally not queried a
 * second time by the delete-assessment check list: a cartItems/orderItems/
 * payments row can never exist without its parent carts/orders row, which
 * is already checked directly.
 */
export const ADMIN_USER_DELETION_INDIRECT_TABLES: Array<{
  table: string;
  via: string;
  category: Extract<AdminUserDeletionCategory, "economic" | "user_owned">;
  reason: string;
}> = [
  {
    table: "cartItems",
    via: "cartId -> carts.userId",
    category: "user_owned",
    reason: "Cannot exist without a parent carts row, which is already checked directly.",
  },
  {
    table: "orderItems",
    via: "orderId -> orders.userId",
    category: "economic",
    reason: "Cannot exist without a parent orders row, which is already checked directly.",
  },
  {
    table: "payments",
    via: "orderId -> orders.userId",
    category: "economic",
    reason: "Cannot exist without a parent orders row, which is already checked directly. (payments.reviewedByUserId/approvedByAdminId are separately classified above as audit_or_actor - this entry is about the payment row's own ownership via its order, not those actor columns.)",
  },
];
