# R40R59 — Release Gap Closure Record (Notifications)

Date: 2026-10-30 · Worktree: `notifications-engagement` @ 6396954 (uncommitted)
Gate: `R40R59_TARGETED_RELEASE_GAPS_QUALIFIED / SCHEDULER_DECISION_PENDING`

## A. Bulk Operation Key Collision (client) — FIXED

- **Finding**: `NotificationBellContainer` held ONE `operationKey` shared by
  `markAllRead` and `deleteAll`. The server's bulk identity is
  `(actorUserId, operationKey)` with an IMMUTABLE action kind
  (server/notifications/bulkOperations.ts: `operation.kind !== kind` → throw
  "kind mismatch") — so a mark-all followed by a delete-all replayed the same
  key and the delete-all failed with a kind mismatch (or silently replayed
  the earlier operation on the server's idempotent path).
- **Fix**: `client/src/components/bulkOperationKeys.ts` — per-action-kind key
  manager (`begin/confirmSuccess/reset`) + `makeBulkOperationKey` generator
  (server contract `^[A-Za-z0-9_-]{8,96}$`). The container keeps one key per
  kind, reuses it across retries of an uncertain outcome, mints a fresh key
  after each server-confirmed success, and drops every key on identity
  change (login/logout/account switch). No optimistic success anywhere.
- **Tests**: `bulkOperationKeys.test.ts` (6 unit tests) + Playwright A11
  "mark-all THEN delete-all in the same session" (fails on the old shared
  key with a server kind-mismatch, passes with the fix).

## B. Coupon × Order × Notification Real-DB Evidence — QUALIFIED

`server/notifications/couponNotificationE2E.integration.test.ts` (2 tests,
real router callers + real services + real transactions on the disposable
`ipenovel_test` MySQL 8; additive to couponOwnership tests 10/12/14 which
already prove the financial invariants):

- CR-1..CR-10: two orders race to consume ONE single-use coupon through
  concurrent real `admin.payments.approve` calls; the winner settles with
  exactly one `order_completed` event + one outbox row + coupon usage row = 1
  + usageCount = 1 + one winning purchase; the loser rolls back completely
  (order pending, payment not approved, zero purchases/points/events).
  Includes a NOTIFICATION FAILURE INJECTION (a poisoned pre-existing event
  with the exact eventKey but mismatched identity) proving a notification
  failure rolls back the whole business approval, and a duplicate sequential
  approval emitting nothing new.
- CR-11: with a FRESH module registry where `NOTIFICATIONS_ENABLED` is
  absent, the financial approval still settles (order/payment approved) and
  writes ZERO notification rows (event/outbox counts unchanged).

## C. Existing Integration Failures Audit — ROOT-CAUSED AND CLOSED

The 4 long-standing failures
(`authorEditorial.boardReconcile/columnGuard×2/publishedGuard`) fail with:

```
Error: SELECT command denied to user 's6_app'@'172.17.0.1'
       for table 'data_lock_waits'
```

**Root cause**: environment, not code. These IPE-070R4B lock-race tests
observe real InnoDB lock contention through
`performance_schema.data_lock_waits`; the disposable container's minimal
test user (`s6_app`) was never granted that monitoring privilege.

**Environment repair (no test file touched, no schema change)**:
`GRANT SELECT ON performance_schema.data_lock_waits/data_locks/threads TO
s6_app@'%'` → re-run: **23/23 passed** across all three files.

**Separate work item** (closed in this round; keep the grant in any future
disposable-DB bootstrap): when re-creating the acceptance container, grant
the test user performance_schema lock-monitoring SELECTs if lock-race
qualification suites are in scope.

## D. Scheduler Activation Recommendation (READ-ONLY — nothing implemented)

**Recommended: External one-shot scheduler (single-strike cron) calling an
operator-authenticated tick — with the in-process runner's busy guard and
the SQL lease fencing as the only concurrency controls.**

- The runtime composition (`controlledRuntime.ts`) is already
  fail-closed/gate-gated and one-shot; the safest activation is the one that
  adds NO new concurrency model: an external timer (Coolify-scheduled
  command or host cron inside the container) that executes a bounded
  `tick()` and exits.
- Multi-replica safety comes free from the existing `SKIP LOCKED` claim +
  `leaseToken` fencing (proven E6/R11): N replicas can run the same cron;
  each event is claimed by exactly one.
- Retry/dead-letter/limits are already implemented and qualified; the
  scheduler only needs to invoke, never to track state.
- Kill switch stays the two environment gates
  (`NOTIFICATIONS_ENABLED` + `NOTIFICATIONS_DELIVERY_ENABLED`) — turning
  delivery off makes every tick a no-op without redeploying.
- An in-process timer inside the web server is rejected: it couples delivery
  health to request serving, complicates graceful shutdown, and would need
  the same fencing anyway. A dedicated background worker is the
  scale-out path later, not now (current load: bounded pages of ≤100
  recipients per event per tick).
- Monitoring: the outbox's `state/attempt/lastFailureCode` columns already
  form the ops surface (pending/leased/dead_letter counts).
- Rollback: remove the cron entry; the gates stay default-off per
  environment.

## Remaining Release Blockers (unchanged)

1. Migration 0067 must be applied to a qualified database BEFORE the app
   release (Release HOLD 0067-first) + Staging-first approval.
2. Scheduler activation decision (recommendation above) — nothing mounted
   today.
3. Production UI enablement requires the build-time
   `VITE_NOTIFICATIONS_UI_ENABLED=true` decision per environment.
