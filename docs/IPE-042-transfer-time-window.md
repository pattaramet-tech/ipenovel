# IPE-042: Order auto-approval transfer window

Base: 32ba302e18676e17042bbc692229f08db79e7aaa (IPE-040).
Branch: feat/ipe042-order-transfer-window.
Context: IPE-042-C01.

A provider-verified order is eligible for automatic approval only when:
transferTime <= orders.createdAt <= transferTime + 180 seconds.
The upper boundary is inclusive, with no minute rounding. The trusted API occurredAt
is compared to the current locked order row, not payment creation, upload, or verification time.
UTC and explicit timezone offsets are compared as instants. Missing, invalid or timezone-less
timestamps fail closed.

The original VERIFIED result is preserved. An ineligible order remains pending_review
with one of ORDER_TRANSFER_TIME_INVALID, ORDER_CREATED_BEFORE_TRANSFER, or
ORDER_CREATED_AFTER_TRANSFER_WINDOW in approvalReason. Existing admin diagnostics show this reason.
The original amount/recipient/duplicate/terminal-state/policy checks still apply.
Manual approval remains available. Wallet auto approval has no new time condition in this task.

No additional migration. IPE-040 migration 0038 is still required if the target lacks it.
No retroactive update of existing approved orders and no production deployment.

Validation covers 180s and 181s in real MariaDB, subsecond boundaries, UTC/Bangkok,
midnight, malformed/missing dates, locked order vs payment timestamps, and unchanged wallet behavior.
Exact-HEAD final test counts and review/verification results are recorded in AI Coding Operations.

Implementation was isolated into a new worktree after concurrent order-number work introduced
conflicts in the previous shared worktree. Those conflicts and unrelated files were not resolved
or included here. This branch intentionally contains IPE-040 plus the time policy only.
