# Legacy reference repair: payment 11280001 — implementation only

## Scope and current boundary

This implementation handles **only `order_payment:11280001`**. The user has
confirmed that the existing R2 slip and this payment are the same transaction.
That is a first-operator assertion, not a claim that software has authenticated
the operator, verified historical bytes, or completed second-human review.

The pinned prepare run is `05e9e0ee-edbc-46ab-bb6e-6527824bd308`, with exact
plan SHA-256 `d89ee2bc6aa911e65a1262a190d60343401faeede6b044276ab44f8be0dffe77`.
Its reported host backup is `/root/ipe-legacy-relink-backup-sP1sjG/plan.json`.
The host backup is NOT automatically available inside the app container.
Do not overwrite or edit this original plan.

The other nine rows, payment `82350007`, IPE-013, financial approvals, OCR,
claim backfill and historical completion flags are excluded.

**No live repair or schema change is authorized by this implementation run.**
There is no apply/live CLI mode or application endpoint. The writer is an
isolated, tested library for a later separately approved execution entry point.
The manual audit DDL is outside `drizzle/` and the migration journal, so app
deployment, attestation and dry-run cannot create that table automatically.

## 1. Record the first operator's assertion privately

The new CLI is `scripts/repair-legacy-slip-reference.ts`. Standalone help is inert:

```sh
node --import tsx scripts/repair-legacy-slip-reference.ts --help
```

Create a NEW private statement JSON using a trusted private editor, with these
four fields (replace descriptions with the actual operator's own record):

```json
{
  "reviewer": "Actual operator identifier",
  "reason": "Actual reason for confirming this specific transaction and mapping",
  "evidenceReference": "Reference to the separately retained private review record",
  "sameTransactionConfirmed": true
}
```

Do not put passwords, credentials, private URLs, or full bank account numbers in
the statement. It may contain private reasoning; do not paste it into chat or
commit it to Git. Do not invent a reviewer name, corroborating record, or a
second reviewer merely to pass validation. If only operator observation exists,
describe it honestly; this record cannot promote that observation into
cryptographic migration provenance.

Use a Linux process with access to both files. Every input must be a regular
non-symlink file mode **0600**, in an immediate directory mode **0700**, owned
by root or the current effective UID. Ancestors must not be symlinks or writable
by other users (root-owned sticky `/tmp` is permitted above the private directory).
The reader checks the opened file and path identity again after bounded reading.

If running inside the Preview app, explicitly stage private input copies there
from the protected host backup first, in a newly created private directory, and
verify the plan checksum. Do not mount the whole `/root` into the app, change
permissions to public, or use a public web directory. Paths below are examples
inside the container, not claims that these files have already been created.

```sh
node --import tsx scripts/repair-legacy-slip-reference.ts --record-attestation --plan=/tmp/PRIVATE_INPUT/plan.json --statement=/tmp/PRIVATE_INPUT/statement.json --code-sha=FULL_COMMIT_SHA
```

`FULL_COMMIT_SHA` must be replaced with the deployed implementation commit. It
is operator-declared metadata, not automatically verified deployment identity.
Recording an attestation does not load DB credentials or make DB/R2 requests.
It verifies the exact original plan digest and creates a separate private JSON.

The output artifact uses the existing secure publisher: random
`/tmp/ipe-legacy-relink-...` directory **0700**, file **0600**, exclusive
publication and fsync. Its basename is currently `plan.json` because the
publisher is shared; the **schema is `legacy-slip-operator-attestation/v1`**.
It is NOT a replacement for the original prepare plan. The summary calls it
`privateAttestationPath` and gives `privateAttestationSha256`.

The artifact records its own recording time, operator assertion, full binding
to the selected candidate and plan/intent digests. It explicitly retains
`historicalByteIdentity: UNPROVEN`, `independentReview: null` and
`writeAuthorized: false`. Neither a typed reviewer name nor a checksum proves
identity or actual completion of human review.

Back up that new attestation separately on the host with restricted permissions
and verify its reported digest before any container replacement. Never overwrite
the old plan. A failed publication may leave a private artifact:
`artifactCreated: null` means inspect the reported private directory, not
"there is no file". Never dump private contents as an error fallback.

## 2. Read-only dry-run

After safely recording/staging the attestation:

```sh
node --import tsx scripts/repair-legacy-slip-reference.ts --dry-run --confirm-preview --plan=/tmp/PRIVATE_INPUT/plan.json --attestation=/tmp/PRIVATE_INPUT/attestation.json --code-sha=FULL_COMMIT_SHA
```

The command pins the same Preview DB host/database/port and private bucket as
the original prepare tool. It additionally compares the reviewed target
fingerprint, including the R2 account endpoint, BEFORE creating network clients.
It does not load `.env` or use public R2 credentials as fallback.

For this single payment it:

1. Reads the entire current source/order/related snapshot, comparing all fields.
2. Lists the exact legacy prefix and requires the same single candidate, key,
   ETag and size, with no truncation or unexpected objects.
3. Uses bounded conditional GET and matches actual raw/canonical hashes, byte
   length and MIME against the original private plan.
4. Checks known global claims/collisions/bindings/uploads/object references.
5. Re-reads the full source snapshot AFTER all those reads and requires equality.

There are no DB locks, transactions, writes, R2 mutations, OCR calls or approval
calls in this dry-run. The 60-second budget is cooperative between bounded
operations; it may finish after that budget while an already-running read ends.
DB timestamps remain session-wall-time strings, not normalized UTC.

`DRY_RUN_MATCH` is point-in-time consistency, **not permission to apply**, a
writer token, a second review, or proof of complete historical replay coverage.
`BLOCKED` must be investigated; do not regenerate/alter the original plan to
make drift disappear. Unknown registry rows are preserved, not cleared.

Exit 0 means attestation recorded or dry-run matched; 1 means blocked; 2 means
input/preflight/output/fatal failure. Public summaries omit keys, URLs, slip
hashes, operator identity and financial context. Share only those summaries.

## 3. Guarded writer core — NOT currently callable from the CLI

`scripts/lib/legacySlipRepairWriter.ts` is an isolated future execution core.
No application route or CLI imports it. Adding an execution entry point needs
another explicit live-work approval and review; do not invoke the library by
hand to bypass this boundary.

Prerequisites for any future live run include:

- A distinct second human who actually examined the private mapping evidence;
  an AI/code review of booleans does not substitute for that examination.
- Exact original plan bytes (not merely a caller-supplied digest label),
  plan/intent/attestation/review digest bindings and separate expiring
  live authorization, with accountable operator identities.
- An externally established writer freeze covering payment/order/account merge,
  wallet-topup, backfill, migration, claim/evidence registries and all shared R2
  object writers, not merely the Preview web container. A JSON assertion cannot stop those
  writers by itself, and an ETag is not a permanent immutability guarantee.
- Fresh preflight after establishing the freeze; no R2/network callbacks while
  holding database locks. A previous dry-run result is not reusable authority.
- DBA-approved creation/review of the dedicated InnoDB audit schema from
  `scripts/manual/legacy-slip-reference-repair-audit.sql`. **Do not execute it
  in this run.** Audit before/after snapshots are private financial context;
  restrict table access and backups, and do not expose them to application UI.

The core fails closed on missing/non-open account guards rather than lazily
creating them. It follows the shared guard, shared legacy user, shared current
merge-case, payment-lock hierarchy, then reads current locked payment/order/
related records and cross references. It checks the complete original snapshot,
uses binary-exact old reference comparison, and updates **only `slipImageUrl`**.
The existing automatic `updatedAt` change is the sole allowed companion change.

After-image validation and a durable unique audit record occur in the same
transaction. An audit insert/readback failure rolls back the reference change.
Matching idempotent retries must match both the audit and current complete
after-image; conflicting prior evidence blocks instead of overwriting history.
Commit acknowledgement loss produces `UNKNOWN` with a separate read-only
reconciliation result, never a blind second UPDATE or an unproven rollback claim.

There is no automatic restoration/delete path. Any later restoration must check
current state and receive separate approval; do not restore the entire DB or
delete R2 files/claims to undo one reference change.

## Verification and remaining release gates

Unit tests use synthetic inputs and fake DB/S3/filesystem operations. No test
results are evidence of a live Preview repair. This Windows development host
cannot establish real Linux filesystem/DB concurrency behavior from mocks.

Before enabling a live entry point, separately verify the audit DDL and writer
against an isolated MariaDB 11.4 test database, including lock contention,
rollback and commit acknowledgement loss, plus real Linux private-file handling.
This work does not start Docker/WSL, deploy, execute DDL or connect to Preview.
