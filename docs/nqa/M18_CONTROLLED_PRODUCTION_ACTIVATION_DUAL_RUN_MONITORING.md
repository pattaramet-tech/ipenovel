# M18 — Controlled Production Activation + Dual-Run Monitoring

## Purpose

M18 connects the M17 active-policy registry to semantic QA runtime policy
selection without allowing an activated candidate to become global by default.

The runtime rule is:

- no approved rollout scope -> baseline only
- approved target outside scope -> baseline only
- approved target inside scope -> candidate is primary and baseline/candidate
  are both executed for monitoring
- M17 rollback -> restored baseline immediately
- stale/incompatible scope -> fail closed

M18 does not automatically enlarge rollout scope.

## Controlled rollout scope

A rollout scope is an explicit deterministic artifact bound to one exact M17
activation state.

It contains:

- scope ID
- approving operator ID
- fixed approval statement:
  `I_APPROVE_NQA_CONTROLLED_ROLLOUT_SCOPE`
- approval timestamp
- source M17 activation transaction ID
- expected registry revision
- expected registry-state fingerprint
- candidate-policy fingerprint
- baseline-policy fingerprint
- explicit row/chapter targets
- scope fingerprint

Targets are normalized, deduplicated and sorted.

A scope may contain at most 100 explicit row/chapter targets.

This is intentionally not a percentage rollout or wildcard rule. Expansion
requires another explicit scope artifact.

The approval artifact records intent/integrity. It is not a cryptographic
identity signature; authenticated operator identity remains an application/
control-plane responsibility.

## Runtime resolver

`resolveNqaRuntimeAlignmentPolicy()` reads the current M17 registry state.

### No scope

If M17 has an activated candidate but no M18 scope is supplied, runtime uses
the preserved M17 rollback policy as the baseline.

The candidate remains suppressed.

### In scope

The resolver requires exact matches for:

- registry revision
- registry state fingerprint
- source activation transaction ID
- candidate fingerprint
- baseline rollback-target fingerprint

If the row/chapter target is explicitly present, the resolver returns:

- mode = `CONTROLLED_CANDIDATE`
- primary = candidate
- baseline = previous policy
- dualRun = true

### Out of scope

The same valid scope can be present, but any target not listed in the scope is
resolved to:

- mode = `BASELINE_ONLY`
- primary = baseline
- dualRun = false

Therefore a candidate activated in M17 cannot leak into unrelated QA traffic.

## Rollback behavior

M17 rollback increments the registry revision, restores the exact previous
policy and clears the rollback target.

If an old M18 scope object remains configured after rollback, the resolver
recognizes the restored baseline fingerprint at a later registry revision and
returns:

- mode = `ROLLED_BACK_BASELINE`
- primary = restored baseline
- dualRun = false

This makes rollback effective immediately without first requiring rollout
scope cleanup.

A different incompatible registry change fails closed.

## Semantic dual-run

M18 deliberately wraps the existing stable
`createNqaSemanticQaHandlers()` implementation rather than modifying its
internal QA stages.

For an in-scope request:

1. run the existing semantic pipeline with the baseline alignment policy
2. run the existing semantic pipeline with the candidate alignment policy
3. candidate result is the primary response
4. append a bounded dual-run monitoring record

For an out-of-scope request:

1. run the existing semantic pipeline once with baseline
2. return baseline
3. create no monitoring record

The duplicated work exists only for the explicitly bounded rollout scope.

## Monitoring evidence

Monitoring records persist only bounded metadata:

- row/chapter
- scope ID/fingerprint
- registry revision/state fingerprint
- source activation transaction ID
- baseline/candidate policy fingerprints
- baseline final decision/reason codes
- candidate final decision/reason codes
- bounded alignment decisions/reason codes
- alignment metrics
- provider/model/policy versions
- comparison flags
- health classification
- observation timestamp
- deterministic record fingerprint

Raw source or translated novel text is not persisted.

## Health classification

Decision severity is:

`PASS < REVIEW < FAIL`

The comparison rules are intentionally conservative:

- same final decision -> `HEALTHY`
- candidate is stricter than baseline -> `REVIEW_REQUIRED`
- candidate is more permissive than baseline -> `BLOCK_EXPANSION`

A candidate becoming more permissive is treated as the stronger safety signal
because it can turn a baseline review/failure into a pass.

## Monitoring store

M18 provides:

- `InMemoryNqaDualRunMonitoringStore`
- `JsonFileNqaDualRunMonitoringStore`

The JSON store writes one create-only file per record using `wx`.

It does not overwrite an existing monitoring record.

## Manual expansion gate

`evaluateNqaRolloutMonitoring()` returns:

- `HOLD`
- `READY_FOR_MANUAL_EXPANSION_REVIEW`

Readiness requires:

- every explicit scope target has at least one monitoring record
- zero `REVIEW_REQUIRED`
- zero `BLOCK_EXPANSION`

Even when this gate returns
`READY_FOR_MANUAL_EXPANSION_REVIEW`, M18 performs no automatic scope
expansion.

A human/operator must explicitly create the next scope.

## Failure behavior

M18 fails closed when:

- scope fingerprint is invalid
- scope contains duplicate targets after parsing
- current M17 registry revision does not match
- current registry-state fingerprint does not match
- activation transaction linkage does not match
- candidate or baseline fingerprint does not match
- monitoring record fingerprint is invalid
- a monitoring record belongs to another scope/candidate/baseline
- candidate dual-run unexpectedly lacks alignment evidence
- append-only monitoring persistence fails

## Isolation

M18 does not:

- call M17 activation transactions
- call M17 rollback transactions
- automatically modify rollout targets
- write Google Docs
- write Google Sheets
- mutate novel/source/translation content
- register HTTP routes/listeners
- import a production database/ORM

Its durable writes are limited to QA-owned monitoring evidence.

## Production-tier boundary

M18 does not change
`NQA_V1_ENABLED_PERMISSION_TIERS`.

The M17 `PRODUCTION_MUTATION` capabilities therefore remain disabled by
default.

M18 tests activate candidates only in isolated in-memory fixtures to verify
runtime behavior. They do not perform a live production activation.

## Operational cost

In-scope dual-run intentionally executes the stable semantic pipeline twice.

That means model/provider cost is approximately doubled only for the bounded
scope.

Out-of-scope traffic runs only baseline once.

This tradeoff keeps M18 isolated from the existing semantic implementation and
makes policy differences directly comparable during the controlled soak.

## Relationship to M19

Recommended next milestone:

**M19 — Production Soak Gate + Explicit Scope Expansion Transaction**

M19 should consume durable M18 monitoring evidence over a defined soak window,
require minimum sample/coverage criteria, add operational error/latency health,
and allow a new larger scope only through another explicit human-authorized
transaction.
