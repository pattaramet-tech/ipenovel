# M20 — Graduated Rollout Completion + Candidate Finalization Gate

## Purpose

M20 closes one controlled NQA rollout cycle after M17 activation, M18 scoped
dual-run monitoring, and one or more M19 soak/expansion cycles.

It answers two separate questions:

1. Has the candidate completed enough healthy graduated rollout to be eligible
   for finalization review?
2. Has an explicitly authorized human committed the candidate as the next
   baseline?

These are deliberately separate operations.

A passing completion gate does not finalize anything.

## Lifecycle

The intended lifecycle is:

1. M17 activates an M16-ready candidate and preserves the prior policy as an
   immediate rollback target.
2. M18 exposes the candidate only to an explicit bounded row/chapter scope and
   dual-runs candidate vs baseline.
3. M19 requires healthy soak evidence before every monotonic scope expansion.
4. M20 requires the full ordered M19 history plus a healthy final soak for the
   terminal scope.
5. M20 completion may return
   `READY_FOR_CANDIDATE_FINALIZATION_REVIEW`.
6. A new human authorization is required.
7. A separate finalization transaction appends the candidate to the baseline
   lineage as the baseline for the next policy cycle.

M20 does not erase or rewrite M17–M19 evidence.

## Explicit rollout universe

Completion is measured against an explicit rollout universe of row/chapter
targets.

The universe:

- is normalized
- is deduplicated
- is deterministic
- uses the same explicit-target model as M18
- is bounded to 100 targets
- has a deterministic fingerprint

M20 never infers a hidden percentage rollout universe.

The caller must say what complete rollout means for the cycle being finalized.

## Completion criteria

The completion caller supplies:

- `minExpansionCycles`
- `minTerminalTargets`
- `minTerminalCoverage`

Safety conditions are not optional criteria.

M20 always requires:

- ordered valid M19 transition history
- every expansion event's M19 soak gate to be ready
- a separate ready M19 soak gate for the final scope
- final scope/soak linkage to the exact current M17 registry state
- candidate/baseline fingerprints to remain unchanged
- current M17 state to still contain the original rollback target

## Final soak requirement

Each M19 expansion event carries the healthy soak gate that authorized that
expansion.

That means the final scope has not yet been proven healthy merely because the
last expansion transaction succeeded.

M20 therefore requires an additional M19 soak gate for the terminal scope.

The complete final soak artifact is embedded in the M20 completion artifact,
not only its fingerprint.

This makes the completion evidence self-contained enough to retain the terminal
health proof in the finalization audit chain.

## Ordered M19 journal replay

M20 does not trust expansion event hashes alone.

It reuses the same M19 semantic transition validator used by the scope
expansion store.

Starting from the exact initial M18 scope, M20 reconstructs the M19 scope state
revision by revision.

The replay validates:

- source scope
- previous revision/state fingerprint
- human expansion authorization
- M19 soak linkage
- candidate/baseline linkage
- proposed target-set fingerprint
- exact added targets
- monotonic superset behavior
- resulting scope state

Input event order must already be correct.

M20 does not sort malformed/reordered evidence into a passing history.

## Completion gate outputs

The gate returns only:

- `HOLD`
- `READY_FOR_CANDIDATE_FINALIZATION_REVIEW`

It records:

- source M17 activation transaction
- current registry revision/state fingerprint
- baseline/candidate fingerprints
- initial scope
- current M19 expansion state
- ordered expansion event fingerprints
- complete final M19 soak gate
- rollout universe and its fingerprint
- completion criteria
- expansion-cycle count
- passing expansion-soak count
- terminal target count
- universe target count
- terminal coverage
- failure reasons
- history fingerprint
- artifact fingerprint

## Completion failure reasons

M20 can hold for:

- `INSUFFICIENT_EXPANSION_CYCLES`
- `TERMINAL_TARGET_COUNT_INSUFFICIENT`
- `TERMINAL_COVERAGE_INSUFFICIENT`
- `EXPANSION_HISTORY_MISMATCH`
- `EXPANSION_SOAK_NOT_READY`
- `FINAL_SOAK_NOT_READY`
- `FINAL_SCOPE_MISMATCH`
- `REGISTRY_MISMATCH`

## Completion artifact integrity

Verification recomputes and checks:

- initial M18 scope integrity
- current M19 expansion-state integrity
- final M19 soak artifact integrity
- final-soak fingerprint linkage
- rollout-universe fingerprint
- rollout-history fingerprint
- READY/HOLD semantics
- outer completion-artifact fingerprint

A completion artifact cannot be made acceptable merely by changing a nested
state field and recomputing only the outer hash.

## Human finalization authorization

Candidate finalization requires a new
`NqaCandidateFinalizationAuthorization`.

The fixed action is:

`FINALIZE_CANDIDATE_BASELINE`

The fixed approval statement is:

`I_APPROVE_NQA_CANDIDATE_FINALIZATION`

Authorization binds:

- authorization ID
- authorizer ID
- current M17 registry revision
- current M17 registry-state fingerprint
- original M17 activation transaction ID
- current M19 expansion revision
- current M19 expansion-state fingerprint
- M20 completion artifact fingerprint
- candidate-policy fingerprint
- predecessor baseline-policy fingerprint
- approval timestamp
- validity deadline
- authorization fingerprint

As in M17/M19, the fingerprint is an integrity and intent binding. It is not a
cryptographic identity signature; actor authentication belongs to the
surrounding control plane.

## Baseline lineage

M20 introduces an append-only baseline lineage.

The lineage state contains:

- revision
- current baseline policy/version/fingerprint
- predecessor baseline policy/version/fingerprint
- source finalization transaction ID
- source completion artifact fingerprint
- deterministic state fingerprint

Before finalization, lineage genesis is the predecessor baseline that M17
preserved as its rollback target.

After finalization:

- current lineage baseline = exact active candidate policy
- predecessor lineage baseline = exact previous baseline
- both full policy artifacts remain available in history

This defines which policy is the baseline for a future policy cycle.

## Important rollback distinction

M20 does **not** clear the M17 rollback target.

The M17 active-policy registry remains unchanged by finalization.

Therefore immediately after M20:

- baseline lineage says the candidate is the finalized baseline for the next
  cycle
- M17 still retains the previous baseline as the current cycle's rollback
  target
- M17 rollback remains available
- M18/M19 journals remain intact

This avoids making rollout completion synonymous with deleting rollback
capability.

Retiring an old rollback path, if ever desired, requires a separate explicit
operational decision outside M20.

## Finalization transaction

`finalizeNqaCandidateBaseline()` verifies:

1. completion artifact integrity
2. completion decision is READY with zero failure reasons
3. human finalization authorization integrity
4. authorization validity window
5. exact current M17 registry state
6. exact original M17 activation transaction
7. exact current M19 expansion state
8. exact ordered M19 expansion event fingerprints
9. exact candidate fingerprint
10. exact predecessor baseline fingerprint
11. lineage genesis/current baseline equals the M17 rollback baseline
12. compare-and-swap lineage state

The event records:

- human authorization
- complete completion gate
- source M17 activation event fingerprint
- complete current M19 expansion state
- complete ordered M19 expansion events
- previous lineage state
- resulting lineage state
- commit timestamp
- event fingerprint

## Durable baseline lineage store

M20 provides:

- `InMemoryNqaBaselineLineageStore`
- `JsonFileNqaBaselineLineageStore`

The durable implementation uses:

- create-only genesis
- exclusive transaction lock
- create-only revision events
- full replay and integrity validation

Reopening with a different predecessor baseline is rejected.

## Idempotency

The same finalization transaction ID with the same authorization and candidate
returns the already committed event.

Reusing the same transaction ID for different intent fails closed.

## Stale and rollback behavior

If M17 rolls back after completion evidence or finalization authorization was
created, finalization fails closed because:

- current registry revision/state fingerprint changed
- active candidate no longer matches
- rollback-target assumptions no longer match

Similarly, a changed M19 expansion state invalidates an older finalization
authorization/completion chain.

## Control-plane boundary

M20 adds:

- `nqa.rollout.evaluate_completion`
  - permission: `READ`
  - effect: `READ_ONLY`
- `nqa.rollout.finalize_candidate`
  - permission: `PRODUCTION_MUTATION`
  - effect: `PRODUCTION_MUTATION`

The default enabled tiers remain:

- `READ`
- `QA_OPERATE`

Therefore candidate finalization is disabled by default until the
`PRODUCTION_MUTATION` tier is explicitly enabled.

## Isolation

M20 production code does not:

- activate an M17 candidate
- call M17 rollback
- expand M19 scope
- delete M17 rollback history
- delete M18 monitoring history
- delete M19 soak/expansion history
- mutate Google Docs/Sheets
- mutate novel/source/translation content
- store raw novel text
- register HTTP listeners
- import production DB/Drizzle
- schedule automatic finalization

Durable writes are limited to the M20 baseline-lineage journal.

## Production status

M20 implements completion and finalization machinery.

Milestone verification does not perform a live production finalization and
does not enable `PRODUCTION_MUTATION` by default.

## Recommended next milestone

**M21 — Finalized Baseline Runtime Adoption + Release/Closure Gate**

M21 should make future NQA policy cycles resolve their baseline from the M20
baseline lineage, verify restart/recovery behavior, define post-finalization
operational closure, and complete the final release/push gate without deleting
historical rollback or audit evidence.
