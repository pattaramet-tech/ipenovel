# Order approval verification deadline and diagnostics

## Scope

This fix builds on `7381280e600e8ae447a63f0e18da4d2af990b638` and addresses long-lived manual order-approval transactions. It does not close IPE-026, resume IPE-013, change Preview configuration, run a historical backfill, or bypass replay protection.

The incident showed an open transaction with five reported row locks, zero modified rows and an idle connection. Performance Schema was disabled. That establishes a long-lived transaction, not which payment or application stage owned it. The legacy scanner is a code-supported candidate, not a proven attribution of that incident.

## Behavior

- After acquiring and reloading the payment, manual approval creates one 15-second monotonic verification budget. Current-slip hashing, the historical duplicate scan and the alias-group scan share it. Per-file timeouts cannot exceed the remaining budget.
- Expiry throws `ORDER_PAYMENT_VERIFICATION_TIMEOUT`; an incomplete scan is never interpreted as clean. Checks before claim insertion, after awaited verification/claim work and before returning from finalization prevent a timed-out approval from committing financial effects.
- This is a cooperative application budget, **not a hard 15-second HTTP or database timeout**. In-flight SQL follows database timeout rules. The local static-credential signer is awaited; an uncooperative signer cannot be forcibly canceled, but its late result is refused. No transaction is abandoned using `Promise.race`.
- Hashing aborts stalled response-body reads, rejects partial bytes, and does not wait indefinitely for cancellation cleanup. Existing hash format, SSRF rules and ordinary `undefined` failure behavior remain intact.
- While holding payment locks, approval reads the backfill setting on the same connection using a current shared read. This avoids another pool lease and stale `complete:true` reads. Missing/malformed values keep scanning enabled; transaction SQL failures propagate, because continuing after an implicit rollback would be unsafe.
- The shared setting lock is held until transaction settlement. Backfill completion/reset writers currently update this setting separately from financial transactions; preserve that lock ordering in future changes.

The new budget is passed only by `approvePayment` (including callers borrowing an outer transaction). Other approval/Recheck paths are not given a new aggregate budget in this fix. Shared hash-reader cancellation improvements apply to their existing calls too.

## Runtime trace

Each `[OrderPaymentApprovalExecution]` record is one JSON line containing a generated run ID, payment ID, Node PID, database connection ID when available, fixed stage/event and elapsed milliseconds. No SQL, bank references, hashes, file paths, signed URLs, slip bytes or administrator labels are logged.

Stage start/end/error and one slow-stage warning identify whether an attempt is waiting for `payment_lock`, reading `current_byte_hash`, checking `legacy_scan_state`, running `legacy_duplicate_scan`/`legacy_alias_scan`, or finalizing financial changes. Match all records by run ID, not payment ID alone.

For owned transactions, `committed` is logged only after the database transaction promise resolves. A rejection logs `transaction_failed`, not a claim that rollback necessarily succeeded. Borrowed transactions log `returned_to_caller`/`failed_to_caller`; their owner remains responsible for transaction settlement.

HTTP 503 for verification timeout is distinct from the existing "busy with another request" lock-timeout message. Repeated verification timeout is a reason to investigate historical coverage/storage, not to repeatedly click Approve or set the backfill-complete flag manually. Any coverage repair/backfill requires a separately scoped operation.

## Verification

- Targeted unit gates cover budget exhaustion across rows/pages, alias scanning, pre-claim expiry, current-byte integrity, stream cancellation, log isolation, backfill read failure and established financial/replay behavior.
- Real-database regressions use only the verified disposable `127.0.0.1:3306/ipenovel_test`. Slow finite historical I/O is simulated while real approval and a competing payment lock run concurrently. Both owned and borrowed transactions unwind before the competitor acquires the lock, with no claim/history/points/purchase/coupon effects. The borrowed case also verifies rollback of an earlier transaction-local write.
- Positive controls retain historical duplicate refusal and a successful indexed approval with one claim/history/reward.
- No Preview database, real payment, environment variable, connection or deployment was changed during these tests. A successful local build is not live Preview verification.
