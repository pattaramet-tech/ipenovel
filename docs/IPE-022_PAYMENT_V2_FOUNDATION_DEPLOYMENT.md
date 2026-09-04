# IPE-022 Payment V2 Foundation Deployment

This runbook covers only the additive IPE-021-D foundation in migrations
`0045_add_payment_v2_foundation` and `0046_add_points_accounts_mutex`. It does
not enable Payment Approval V2 routes or remove any V1 path.

## Safe rollout and restart behavior

1. Deploy the new build normally. Startup takes the existing named migration
   lock, runs committed migrations, verifies every required table, column,
   unique/index, and foreign key, reconciles foundation data, then runs the
   read-only readiness checks before opening the HTTP port. Reconciliation
   briefly locks all `users` rows and then all `pointsAccounts` rows in one
   transaction, matching the live lock order and quiescing both legacy and
   new points writers while the global snapshot converges.
2. `0045` and `0046` are safe to retry after any MySQL/MariaDB implicit DDL
   commit. `CREATE TABLE IF NOT EXISTS`, information-schema-guarded ALTERs,
   duplicate-safe guard insertion, and repeatable points reconciliation make a
   second run converge instead of failing with an already-exists error.
3. During a rolling replacement, an old instance may still create a user or
   append a legacy `pointsTransactions` row after the migration's first
   backfill. New classified mutations repair a missing guard from canonical
   non-cancelled `accountMergeCases` state before taking the guard lock. New
   points mutations keep the transitional `users` lock, repair/lock the
   `pointsAccounts` row, and reconcile it from the latest committed ledger row
   ordered by `createdAt DESC, id DESC` before arithmetic.
4. Plain balance reads use that same deterministic latest-ledger value while
   the mixed-version bridge exists. New writers update `pointsAccounts` and
   the ledger atomically, so this fallback cannot expose an account-only
   intermediate state.
5. Keep the bridge until deployment telemetry proves that every old instance
   is drained. Removing the bridge belongs to a later explicitly reviewed
   cutover task, not this foundation change.

The legacy users-row lock is intentionally retained during the bridge. It is
the rendezvous that prevents a ledger-only V1 writer from committing between a
new writer's reconciliation and its account update. The new guard remains the
first lock for new code, preserving the established lock hierarchy.

## Readiness evidence

Startup refuses to serve if any of these post-reconciliation checks is nonzero:

- users missing an `accountMutationGuards` row;
- a guard whose `mergeState`/`activeMergeCaseId` differs from the user's
  canonical non-cancelled `accountMergeCases` row;
- users missing a `pointsAccounts` row;
- a `pointsAccounts.balance` that differs from the latest
  `pointsTransactions.balanceAfter` by `(createdAt DESC, id DESC)`, or `0.00`
  when no ledger row exists.

The production implementation is
`findPaymentV2FoundationDataMismatches()` in `scripts/migrate.mjs`. It emits the
exact mismatch class and count, without logging user rows or credentials.
Operators may run `pnpm db:migrate` again after correcting the underlying
problem; the migrations and reconciliation are restart-safe.

## Rollback without financial-write loss

Application rollback is additive and does not require schema rollback:

1. Drain/stop the new instances and restore the previous application image.
2. Leave `accountMutationGuards`, `pointsAccounts`, and nullable
   `pointsTransactions.effectKey` in place. Do not drop these objects and do
   not delete or rewrite ledger rows. The prior application ignores them.
3. Treat `pointsTransactions` as the compatibility recovery record while the
   old image is active. It continues to receive every legacy points write.
4. Before rolling forward again, run the new build's startup migration step.
   Its reconciliation re-derives missing guards and makes every points mirror
   equal the deterministic latest ledger balance before readiness can pass.
5. If readiness still reports guard-state mismatches, stop the rollout and
   investigate the named count against `accountMergeCases`; do not guess a
   guard state or manually reset generation. If it reports points mismatches,
   preserve the ledger, correct the cause, and rerun reconciliation.

Dropping the new tables/column during rollback is unsafe: an overlapping new
instance could still depend on their locks, and deleting `pointsAccounts`
would discard the convergence/version evidence. Leaving the additive schema
in place preserves both legacy writes and a deterministic forward recovery.
