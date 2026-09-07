# Duplicate slip review and exceptional order approval

Base: 6871fde220a31965d4448c3290355bc91ecb9080 (IPE-040/041/042).
Feature branch: feat/payment-duplicate-exception.

Admin payment rows, dashboard rows and order detail use a shared approval action.
They display matching approved orders/topups, their number, amount, status and approval time, with links to existing admin detail routes.
Exceptional approval requires a checked confirmation and a trimmed 5–1000 character reason.
The server rechecks the target-bound confirmation against current duplicate sources while retaining the provider claim lock.
The original claim is never deleted or reassigned. Automatic approval retains its original duplicate rejection behavior.
An already approved payment returns success without granting more rights.
Exception actor, timestamp, reason and duplicate sources are stored in the payment snapshot and transactional order history.

Scope: exceptional approval is for orders via admin.payments.approve; matching sources include both orders and wallet topups. Wallet approval policy is unchanged.
No Payment V2, slip URL identity gate, new database migration, main merge or deployment is introduced.

Review: same-run code review of admin boundary, target-bound confirmation, transaction rollback, existing claim protection and repeated approval.
Tests: 165 selected unit tests and 13 MariaDB integration tests passed.
Added coverage for explicit confirmation, missing reason, stale/other-target confirmation, cross-wallet duplicate lookup, concurrent exceptional order approval, and subsequent duplicate rejection.
Preview browser interaction remains to be checked: expand linked source; cancel; blank reason; confirm; retry same target; verify order history.
