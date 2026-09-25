# M21 — Finalized Baseline Runtime Adoption + Release/Closure Gate

## Purpose

M21 closes the NQA policy-rollout implementation cycle after M20.

M20 proves that a candidate completed a controlled graduated rollout and records
that candidate as the baseline for the next policy cycle.

M21 makes that finalized baseline usable by runtime construction and defines the
last fail-closed release gate before any push or pull request.

M21 does not push, create a pull request, merge, activate a new candidate,
retire rollback history, or enable production mutation by default.

## Finalized baseline runtime source

The authoritative next-cycle baseline source is the M20 baseline-lineage
journal.

M21 does not copy M20 thresholds into
`DEFAULT_NQA_ALIGNMENT_POLICY`.

The runtime resolver:

`resolveNqaFinalizedBaselineRuntime()`

requires a valid M20 lineage with:

- lineage revision greater than zero
- source finalization transaction ID
- source completion artifact fingerprint
- predecessor baseline fingerprint
- exact source M20 finalization event

Genesis-only lineage is not considered finalized and fails closed.

## Provenance verification

For the current M20 lineage state, M21 verifies the source finalization event
and requires exact linkage across:

- finalization transaction ID
- resulting lineage-state fingerprint
- finalized baseline policy fingerprint
- predecessor baseline policy fingerprint
- M20 completion artifact fingerprint
- human authorization candidate fingerprint

The runtime resolution records:

- lineage revision
- lineage state fingerprint
- finalized baseline policy/version/fingerprint
- predecessor baseline fingerprint
- source finalization transaction ID
- source finalization event fingerprint
- source completion artifact fingerprint
- deterministic provenance fingerprint

If the latest source finalization event is missing, stale, tampered, or
incompatible with the current lineage state, runtime adoption fails closed.

## Semantic runtime adoption

`createNqaSemanticQaHandlers()` now supports an optional asynchronous
`alignmentPolicyResolver`.

When configured, one alignment policy is resolved for the semantic run and is
used consistently by:

- M10 alignment
- M11 adjudication evidence construction
- M12 structured evidence construction

This allows a lineage-backed M21 resolver to supply the finalized baseline
without changing the static default policy.

Callers that do not configure an asynchronous resolver keep their previous
static override/default behavior.

## Next-cycle M17 genesis

The primary M21 cycle-adoption boundary is M17 registry genesis.

M21 provides:

- `createNqaNextCycleInMemoryActivationStore()`
- `createNqaNextCycleJsonActivationStore()`

Both functions first resolve and verify the M20 finalized baseline, then create
a new M17 activation store with that exact policy as revision-zero active
policy.

Therefore the next policy cycle starts with:

- active policy = M20 finalized baseline
- revision = 0
- rollback target = null
- last transaction ID = null

When the next candidate is later activated through M17, its rollback target will
therefore be the exact baseline finalized by M20.

The previous cycle's M17 registry and rollback history are not mutated.

## Restart and recovery

M21 verifies two durable restart boundaries.

### M20 lineage restart

A reopened `JsonFileNqaBaselineLineageStore` must reproduce the exact same:

- finalized baseline
- lineage revision
- lineage state fingerprint
- source finalization event
- completion provenance
- runtime provenance fingerprint

### Next-cycle M17 restart

A reopened `JsonFileNqaPolicyActivationStore` initialized through the M21
factory must reproduce the exact same revision-zero active policy and state.

The activation-store genesis remains create-only and rejects an incompatible
initial policy.

## Fail-closed behavior

M21 does not silently fall back to a static default when a caller explicitly
requests finalized-lineage runtime adoption.

It rejects:

- unfinalized lineage/genesis-only lineage
- missing source finalization event
- tampered finalization event
- incompatible current lineage/event provenance
- incompatible durable activation genesis

Static/default policy behavior remains available only to callers that
deliberately do not configure M21 lineage-backed resolution.

## Release/Closure Gate

M21 adds a deterministic
`buildNqaReleaseClosureGate()`.

The gate emits only:

- `HOLD`
- `READY_FOR_PUSH_PR_REVIEW`

The gate requires positive evidence for:

- branch is `feat/nqa-foundation`
- boundary regression passes with zero failures
- full NQA regression passes with zero failures
- TypeScript typecheck passes
- formatting check passes
- runtime adoption is verified
- restart/recovery is verified
- isolation checks pass
- staged diff check passes
- secret scan passes
- debug-marker scan passes
- post-commit index is clean
- only explicitly allowed untracked artifacts remain
- active threshold-policy files were not changed
- M17 activation/rollback history source was not changed
- production mutation default remains disabled
- no push has occurred
- no PR has been created for this closure action
- no merge has occurred

The artifact has a deterministic fingerprint and
`verifyNqaReleaseClosureGate()` rejects a modified decision, failure list, or
fingerprint.

## Release gate is non-operative

The closure gate evaluates supplied evidence only.

It does not:

- invoke git
- push commits
- query/create a PR
- merge a branch
- enable production permissions

Repository commands are run separately during the milestone verification and
their results are reported as release evidence.

This keeps the gate itself deterministic and side-effect free.

## Repository policy for M21 closure

Before M21 commit:

- stage only intended M21 files
- exclude `.tmp/`
- require `git diff --cached --check`
- scan for secrets/debug markers
- verify no active threshold policy file is staged
- verify no M17 activation/rollback source is staged

After M21 commit:

- index must be empty
- source worktree changes must be empty
- only known unrelated `.tmp/` Full QA artifacts may remain untracked
- branch may remain ahead of origin
- no push/PR/merge is performed until the user receives the closure report

## Production mutation boundary

M21 does not change
`NQA_V1_ENABLED_PERMISSION_TIERS`.

The default remains:

- READ
- QA_OPERATE

PRODUCTION_MUTATION remains disabled by default.

M21 also does not alter the M17 rollback target from the completed rollout
cycle.

## Release outcome

A passing M21 closure means the local NQA branch is ready for a separate
Push / PR Gate.

It does not mean the branch has been pushed, reviewed, or merged.

Those actions remain explicit later steps.
