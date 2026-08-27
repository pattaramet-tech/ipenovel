# Runbook: Legacy Slip Claim Backfill (IPE-004 hotfix)

This is the operator runbook for `scripts/backfill-slip-claims.mjs`, the tool
that populates `paymentSlipClaims`, `paymentSlipLegacyCollisions`, and
`paymentSlipLegacyUnknown` from already-approved historical order payments
and wallet top-ups, and that gates the durable "backfill complete" switch
(`server/services/slipBackfillStateService.ts`).

Read this before running the tool anywhere other than your own local dev
database.

## What the backfill does

For every historical `approved` order payment and wallet top-up, the tool
classifies the row into exactly one of three durable buckets:

- **protected** - a `paymentSlipClaims` row exists (or is inserted/enriched)
  with every exact identifier this row genuinely carries. A row whose file
  bytes are gone but whose exact reference and/or QR IS known is still
  protected *on those axes* - the known identifiers are always claimed, and
  only the missing file axis is separately recorded as unknown. reference and
  QR are UNIQUE columns exactly like fileHash, so a same-source claim missing
  a sibling identifier is enriched in place (never a second claim, never a
  "collision" against nothing), with a re-read to confirm and a duplicate-key
  rejection treated as a real collision.
- **collision** - two or more historical rows share the same exact identifier.
  Recorded in `paymentSlipLegacyCollisions`, one row per member, under the
  identifier's (kind, hash). **No winner is ever picked** among the colliding
  historical rows, and no financial/audit record is modified. Note the
  backfill still writes an ordinary claim for the first member it sees; the
  live approval path checks the collision registry *before* that singleton
  claim, so a colliding identifier always surfaces as `known_collision` (no
  winner, manual review), never as a proven duplicate owned by that first row.
- **unknown** - the row's file identity could not be established this run.
  Recorded in `paymentSlipLegacyUnknown` for operator visibility. **Never
  consulted to block or approve anything.** Two sub-cases:
  - `no_slip_image_url` - the row has no slip image URL at all, so its bytes
    are permanently gone. **Proven permanent**: recording it is what lets the
    backfill be marked complete despite it.
  - `file_hash_recovery_failed` - a signed-URL / storage / network / timeout /
    oversize failure. **NOT permanent**: it may succeed on a later run. Any
    nonzero count of these keeps `--mark-complete` refused until the row is
    resolved (or an operator justifies a permanent classification explicitly).

Once every historical row has landed in one of these three buckets with no
processing failures - and every "unknown" is the proven-permanent
`no_slip_image_url` kind - the run is "clean" and `--mark-complete` may
succeed. Completion durably disables the old O(N) historical scan
(`legacySlipCompatibilityService.ts`) in the live approval path; from then on,
every approval and detail view uses indexed lookups against the three durable
tables only.

**Completion does NOT require zero unresolved rows or zero collisions.**
Both are permanent facts about historical data - a row with no slip image can
never be recovered no matter how many times you re-run this tool. What
`--mark-complete` actually requires is that every one of them has been
durably, explicitly classified, with no write failures, and that no
still-recoverable row is sitting behind a transient failure. See
`scripts/lib/backfillCompletionGate.mjs` for the exact rule.

## Step 1: Dry-run first, always

Dry-run is the default - `--live` is required to write anything.

```
pnpm backfill:slip-claims -- --dry-run
```

Or with an explicit page size (bounds memory per page, never total rows
scanned):

```
pnpm backfill:slip-claims -- --dry-run --page-size 500
```

Point `DATABASE_URL` at a **local or staging/preview database** for this
step. The tool refuses to run at all against a URL that looks like
production (contains `prod` and none of `preview`/`staging`/`test`/`local`)
unless you pass `--i-understand-this-is-not-production`, which you should
never need for a dry run.

A dry run makes **zero writes**. It is always safe to run repeatedly.

## Step 2: Review the dry-run output before going anywhere near `--live`

The summary block reports, among other things:

```
scanned approved records : <N>
already represented      : <N>
UNRESOLVED (no exact fileHash coverage): <N>
would insert             : <N>
collisions REPORTED      : <N>
would record collision members       : <N>
would record unresolved rows as unknown : <N>
failures                 : <N>
```

Before considering a live run, confirm:

- `failures` is **0**. Any non-zero value is a real infrastructure/query
  problem (bad connection, unexpected schema, etc.) - fix the root cause
  before proceeding, never just re-run and hope.
- `alias inconsistencies` is **0**, or every listed one has been reviewed by
  a human. This is the one category the tool will never auto-resolve for
  you - see the `LEGACY_ALIAS_INCONSISTENCY` block in the output.
- `stale claims still uncovered` is **0** (or will become 0 on the live run -
  these are self-repairing, but confirm the count trends toward zero across
  dry runs, not away from it).
- The `COLLISIONS` and `UNRESOLVED` sections are ones you have actually
  looked at, even briefly. A collision is a real fact about your financial
  history (two approved records sharing one bank reference or one exact slip
  image) - it is not an error in this tool, but it deserves a human's eyes at
  least once before you accept "durably recorded as known collision, no
  winner picked" as the permanent state for it.
- The unresolved-row count and reasons look like what you expect for your
  data's age and completeness (e.g. mostly `no_slip_image_url` for records
  that predate slip image storage). A sudden, unexplained spike in
  `file_hash_recovery_failed` (as opposed to `no_slip_image_url`) may indicate
  a transient infrastructure problem (storage access, network) worth fixing
  before you accept it as permanent - that reason, unlike `no_slip_image_url`,
  can resolve itself on a later re-run once the underlying access problem is
  fixed.

If any of the above looks wrong, stop. Fix the underlying issue (or escalate
for review) and dry-run again. Do not skip straight to `--live` because the
exit code was non-zero - a non-zero exit on a dry run with findings is
expected and is the signal to review, not a bug.

## Step 3: Live run (staging/preview first, always)

Once the dry-run output looks correct and reviewed:

```
pnpm backfill:slip-claims -- --live --page-size 500
```

This writes `paymentSlipClaims` rows, `paymentSlipLegacyCollisions` rows, and
`paymentSlipLegacyUnknown` rows. It does **not** modify any payment/top-up's
financial status, amount, or approval metadata - it only ever inserts into
these three tables (plus, in the next step, one `settings` row).

The tool does not hold one transaction across the whole run - it commits
page by page. A crash mid-run leaves the backfill state incomplete, which
means the legacy scan stays enabled (the safe direction) until you re-run.

**Idempotency**: it is always safe to run this exact command again. A row
that was already claimed, already recorded as a collision member, or already
recorded as unknown, is left untouched (the underlying tables use `INSERT`
guarded by `UNIQUE` constraints, and a duplicate insert attempt is a no-op,
not an error). Re-running does not create duplicate claims or duplicate
collision/unknown records.

Review the summary again. It should now report `claims INSERTED`,
`collision members RECORDED (durable)`, and `unresolved rows RECORDED as
unknown (durable)` instead of the "would ..." counters.

## Step 4: What "safe to run live" requires

Before running `--live` against a real (non-toy) database, confirm:

1. You have already dry-run against that same database (or one with
   equivalent data) and reviewed the output per Step 2.
2. `failures` was 0 in the dry run.
3. Any `LEGACY_ALIAS_INCONSISTENCY` findings have been resolved by a human,
   or you understand they will continue to block `--mark-complete` (they do
   not block the plain `--live` write step, only completion).
4. You are running against a database you are authorized to write to for
   this purpose - **never production** unless this has been explicitly
   authorized through your organization's change process, and never with
   `--i-understand-this-is-not-production` unless you have independently
   verified the target is not actually production.

## Step 5: What "safe to mark complete" requires

`--mark-complete` requires `--live`, and only takes effect after a run the
tool itself judges "clean" (see `scripts/lib/backfillCompletionGate.mjs`):

- Zero processing failures.
- Full alias coverage (every legacy-uppercase-only row's claim carries its
  advisory alias) and zero alias inconsistencies.
- Full exact-fileHash coverage (every *represented* row's claim carries its
  exact file hash where one exists - a row whose bytes are permanently gone
  is classified `unknown` on the file axis instead, never counted as
  represented-but-missing).
- Full reference/QR sibling coverage: `strongIdUncovered == 0` - every known
  reference/QR identifier that belonged on a same-source claim was actually
  enriched onto it.
- Zero stale legacy claims left unrepaired. A duplicate-key conflict on the
  fileHash half of a stale-claim migration must still end with the obsolete
  lossy `referenceHash` cleared (the tool retries with a fileHash-free patch)
  - otherwise that row stays `staleClaimsUncovered` and blocks completion.
- **Zero FAILED durable writes** for collision members or unknown rows -
  not zero collisions or zero unresolved rows. A collision or an unresolved
  row that was successfully, durably recorded does not block completion.
- **Zero TRANSIENT unknowns** (`unknownRowsTransient == 0`): every `unknown`
  row is the proven-permanent `no_slip_image_url` kind, not a
  `file_hash_recovery_failed` that might recover on a later run.
- Both source tables (`payments`, `walletTopups`) were scanned to EOF.

```
pnpm backfill:slip-claims -- --live --mark-complete
```

If the gate refuses, it prints exactly which of the above failed
(`gate.reasons`) and does **not** write the completion record. Resolve the
listed findings and re-run - re-running `--live --mark-complete` is always
safe (idempotent) even after a prior refusal.

Once marked complete, the live approval path stops paging through history
entirely: `evaluateSlipConflict` (`server/services/slipConflictEvaluator.ts`)
relies on indexed lookups against `paymentSlipClaims` (exact
reference/file/QR ownership and the advisory legacy-case alias) and
`paymentSlipLegacyCollisions` (known collisions) - and, for one narrow case,
`paymentSlipLegacyUnknown` too (IPE-004-C03): a current submission whose ONLY
strong evidence is a fileHash cannot be proven clean on the file axis while
ANY row in `paymentSlipLegacyUnknown` exists, since it could be a
byte-identical replay of one - a single bounded, indexed `LIMIT 1` read,
never a scan. A submission that also carries a reference or QR is unaffected;
those axes are fully covered by `paymentSlipClaims`/`paymentSlipLegacyCollisions`
and this check never runs for them. Outside that one case,
`paymentSlipLegacyUnknown` rows exist for operator/audit visibility, in the
admin detail views and this tool's own output.

To re-enable the historical scan later (e.g. if a completed backfill is later
found to be incomplete for some reason), an operator can call
`clearSlipBackfillComplete()` (`server/services/slipBackfillStateService.ts`)
directly, or write `{"complete": false}` to the `paymentSlipClaims.backfillState`
settings key. This is a manual, deliberate action - there is no automated
path back to "scan required" once completion has been marked.

## What this tool will never do

- Never picks a winner among two or more historical rows that share a strong
  identifier (a "collision"). Both/all members are recorded; none is deleted,
  rewritten, or preferred.
- Never deletes or rewrites a historical financial or audit record.
- Never calls an LLM or any external OCR provider - only the local parser is
  re-run against already-stored OCR text, and file hashes are recomputed only
  from bytes already stored at the row's own `slipImageUrl`.
- Never modifies payment/top-up status, amount, or approval metadata.
- Never runs with plain `node` - it dynamically imports TypeScript
  application modules and must be run through `tsx` (`pnpm backfill:slip-claims`
  already does this correctly).
