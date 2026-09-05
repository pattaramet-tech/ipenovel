# Single legacy slip live-repair candidate: payment 11280001

## Current boundary

This revision prepares and tests an operator entry point. It does **not** authorize
or perform a Preview/Production database repair, R2 change, DDL, redeploy, financial
approval, backfill, or IPE-013 work. Scope remains only `order_payment:11280001`.

`LEGACY_REPAIR_EXECUTION_RELEASED` is a source-code constant set to **false**.
`--execute` returns `LIVE_EXECUTION_RELEASE_GATE_DISABLED` before private-file,
environment or network access. There is no environment variable or flag that can
override it. A future separately reviewed release is necessary before execution;
do not import the candidate library manually to bypass the CLI gate.

The prior operator attestation and read-only dry-run were reported successful by
the operator. Their scope is the original reviewed mapping, not proof of historical
byte identity or complete replay coverage. Retain these original private backups:

- Prepare plan: `/root/ipe-legacy-relink-backup-sP1sjG/plan.json`;
  SHA-256 `d89ee2bc6aa911e65a1262a190d60343401faeede6b044276ab44f8be0dffe77`.
- First-operator attestation:
  `/root/ipe-legacy-attestation-backup.9wIPDt/attestation.json`;
  SHA-256 `ed85c986a6abea8339dd0a523b5aa181d6a1d0c2814f40a4c041d7eaf836893b`.

The files themselves remain private on the deployment host; they were not copied
into the repository or used as test fixtures. Directory/file permissions remain
0700/0600. The original second-human review and live authorization are still
**pending**, not fabricated by code review or test fixtures.

## Entry point and records

Inert help (no database/R2 or private-file access):

```sh
node --import tsx scripts/execute-legacy-slip-reference-repair.ts --help
```

Both modes require exactly `--confirm-preview`, `--code-sha=FULL_SHA`, and four
distinct absolute private paths: `--plan=`, `--attestation=`, `--review=`,
`--authorization=`. Unknown, duplicate, missing or mixed mode flags fail closed.
The code SHA remains operator-declared metadata, not automatic deployment proof.
No target, plan-digest or database override is exposed to the operator.

The last two artifacts must be actual retained records, not templates filled with
invented names or booleans:

- `legacy-slip-independent-review/v1`: distinct human reviewer, actual review
  time, intent digest, exact first-attestation artifact digest, mapping confirmed.
- `legacy-slip-live-authorization/v1`: operation UUID, accountable authorizer,
  issue/expiry times, intent/attestation/review digests, explicit apply permission,
  and a separately established comprehensive maintenance/freeze assertion.

The source types in `legacySlipRepairWriter.ts` define the exact closed schemas.
Review digest is canonical JSON, while first-attestation digest is of the exact
artifact bytes. Never regenerate or edit retained operation records to retry a
failed or ambiguous execution. Private JSON fields record declarations; they do
not authenticate a human, inspect mapping evidence, grant organizational approval
or actually stop writers. Those controls require the real accountable operator
workflow outside this CLI.

The mapping review must follow the first attestation; authorization must follow
that review within 24 hours. Authorization and maintenance windows each last at
most 15 minutes. The execution flow validates all private records and current
freshness before constructing network clients. Its new preflight begins **before**
the first read and expires within 60 seconds and both authorization windows;
slow reads cannot be given a new completion-time freshness stamp. R2 readers close
before the writer acquires database locks.

## Future live window prerequisites

Before a separately authorized future execution:

1. Complete actual second-human mapping review. This AI's code review does not
   substitute for a second human examining the private payment/R2 mapping.
2. Obtain separate approval for the reviewed release and the specific live
   operation; verify the deployed exact code and original artifact digests.
3. Establish the external freeze across **all** payment/order/account-merge,
   wallet, backfill, migration, claim/evidence, shared R2 and DBA/DDL writers.
   Stopping only the Preview web app is insufficient.
4. Obtain DBA approval for the manual audit schema and verify table privileges.
   The DDL stays outside the migration journal and is never run by either CLI.
5. Verify direct metadata visibility: literal current-user `SHOW GRANTS` must
   prove `TRIGGER` or `ALL PRIVILEGES` on `ipenovel` or globally. Roles, table-only
   grants and wildcard database grants are deliberately not accepted. The code
   never grants permissions; an empty privilege-filtered trigger list cannot be
   accepted as proof that no trigger exists. Grant strings can contain credential
   hashes and must never be printed.
6. The writer checks InnoDB tables, dedicated unique audit indexes/columns and
   absence of payment/audit triggers before the transaction, then repeats those
   checks after all relevant locking reads hold table metadata locks, before its
   only URL update. No other payment, amount, status, OCR, evidence or claim is
   changed. Existing automatic `updatedAt` is the sole allowed companion change.
   An extra/unreviewed payment column also blocks execution rather than making an
   unsupported claim that its value or automatic-update behavior was preserved.

No manual SQL UPDATE, permission grant, forced old-plan regeneration, historical
coverage flag, or public-bucket change is a substitute for these gates.

## Recovery is separate and read-only

`--reconcile` is a supported read-only inspection mode using the same four
**original operation** artifacts and exact target. It is not useful before a live
operation exists, so do not fabricate its required review/authorization files now.
It may inspect expired records; it cannot renew them or call the writer. It makes
no R2 request, DML/DDL statement, approval or automatic retry.

The audit and current complete payment/order/related state are read in one InnoDB
REPEATABLE READ, READ ONLY consistent snapshot. See the primary MariaDB
[START TRANSACTION reference](https://mariadb.com/docs/server/reference/sql-statements/transactions/start-transaction).
Queries have a 5-second timeout and the check has a cooperative 30-second budget
checked before and after reads. The connection is always closed.

| Result                     | Meaning and next action                                                                                                                         |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `MATCHING_AUDIT_AND_STATE` | Exact original operation audit and complete permitted after-image match at the read snapshot. Independently verify before closing the incident. |
| `NO_COMMIT_EVIDENCE`       | No matching source audit exists in that snapshot. **Not** proof of rollback or permission to resend.                                            |
| `CONFLICT`                 | Original operation bindings or complete current state differ. Stop and investigate privately.                                                   |
| `UNKNOWN` / `BLOCKED`      | The inspection could not establish a trustworthy result. Preserve artifacts; no automatic retry.                                                |

Live writer acknowledgement loss likewise remains `UNKNOWN`, even if its immediate
read-only reconciliation finds matching commit evidence. A process crash or
expired grant must be investigated with retained original records, not a new
operation ID. Do not run the execute mode again after a changed URL; it requires
the original before-image and deliberately fails closed.

## Repeatable isolated verification

Run only on the local development machine with Docker Desktop available:

```powershell
powershell -NoProfile -File scripts/test-legacy-slip-repair-isolated.ps1
```

The runner creates uniquely labelled disposable Linux Node 22.11.0 and MariaDB
11.4.10 containers and a unique `ipe_repair_test_<12hex>` database. There are no
host-published database ports, production volumes, Docker socket mounts, private
plans, `.env`, application credentials or connections to Preview. Only allowlisted
source files are copied. Dependency installation uses the repository lockfile on
a temporary bridge connection; the runner disconnects that bridge before joining
the database's internal-only network. Cleanup checks exact resource ownership.

The dedicated Vitest project has no ordinary app/integration global setup or
migrator. It rejects Windows, ambient `DATABASE_URL`/`TEST_DATABASE_URL`, external
hosts, non-test database names and non-MariaDB 11.4 servers. Synthetic private-plan
pins are mocked **only inside the test harness**; the production CLI/library has
no pin override. Real SQL, transaction, metadata, lock and filesystem behavior is
exercised against an initially empty synthetic schema derived from Drizzle plus
the actual manual audit DDL, not the operator's database.

Verification results are recorded at handoff. A harness existing or a Windows
refusal is not evidence of a successful Linux/MariaDB run. Passing local tests
does not grant the pending second-human review or permission to run live.

### Verification performed on 2026-09-06

Tested the working-tree candidate based on `51e4fa2270643099646d5b4b7dabc8165e18a64e`;
this is not a claim that a new commit has been pushed or deployed.

- Real isolated MariaDB **11.4.10** / Node **22.11.0** on Linux: **42/42 passed,
  zero skips** (29 SQL/transaction cases and 13 real filesystem cases), repeated
  on a newly created empty synthetic database using the complete runner recipe.
- SQL gates include atomic reference+audit, preserving financial state, exact
  idempotency, actual 5-second lock timeout/release, shared-guard contention,
  rollback after late failures, injected acknowledgement loss after a real
  COMMIT, read-only reconciliation of expired original records, concurrent
  financial changes across a read snapshot, hidden-trigger low-privilege refusal,
  late trigger creation, and extra generated/auto-update payment columns.
- The acknowledgement-loss case injects a client error after the actual COMMIT;
  it is not a full network-proxy fault-injection test or proof of every outage.
- Windows regression: **26 suites, 1102 passed / 1 Linux-only test skipped**.
- Linux regression: **26 suites, 1101 passed / 2 non-Linux-only tests skipped**.
  The Linux-only POSIX publisher test passed on Linux; the two platform-refusal
  cases passed on Windows. No applicable case failed.
- Repository typecheck, strict targeted TypeScript check, formatting and diff
  checks passed. Independent code reviewer reran **260/260 targeted tests** and
  reported no blocking code finding; this was not a human mapping attestation.
- Reusable local-Docker endpoint override rejection passed. A complete fresh
  runner invocation passed all 42 gates and performed label-verified cleanup of
  only its containers, internal network and source staging directory.

Execution remains source-gated off. No Preview/Production connection or database
mutation, R2 read/write, live DDL, redeploy, financial approval or backfill occurred
during this implementation/verification work. The test-only database writes and
DDL used synthetic disposable local databases, not the operator's private plan.
