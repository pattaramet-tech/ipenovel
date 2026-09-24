# M19 — Production Soak Gate + Explicit Scope Expansion Transaction

## Purpose

M19 governs rollout growth after M18 controlled dual-run monitoring.

M18 answers:

- which exact row/chapter targets may use the candidate
- whether baseline/candidate decisions differ
- whether candidate behavior is more permissive or stricter

M19 adds:

- an explicit soak window
- linked operational error/latency telemetry
- deterministic sample/coverage/health criteria
- a fail-closed soak artifact
- a separate durable rollout-scope journal
- a fresh human authorization requirement for every scope expansion
- monotonic expansion only

A passing soak gate does not change production scope by itself.

## Operational telemetry

M18 monitoring records intentionally remain unchanged.

M19 adds a separate operational sample linked to the M18 scope and, for
successful dual-run requests, the exact M18 monitoring record fingerprint.

Each sample contains only bounded operational metadata:

- sample ID
- M18 scope ID/fingerprint
- row/chapter
- SUCCESS or ERROR
- total request duration in milliseconds
- M18 monitoring record ID/fingerprint for successful requests
- bounded error code for failed requests
- observation timestamp
- deterministic sample fingerprint

Raw source or translated novel text is not stored.

An ERROR sample cannot claim a monitoring-record linkage.

A SUCCESS sample must link to an M18 monitoring record.

## Runtime observation wrapper

`createNqaSoakObservedHandler()` wraps an existing M18 handler.

For in-scope traffic it:

1. records a monotonic start time
2. executes the existing handler
3. records duration
4. records SUCCESS only if M18 produced monitoring evidence
5. records ERROR if execution throws or an expected M18 monitoring record was
   not produced
6. rethrows the original runtime error

Out-of-scope traffic is passed through without M19 soak telemetry.

The wrapper records an error code, not the exception message, so runtime
details or content are not copied into the soak dataset.

## Explicit soak window

`evaluateNqaProductionSoak()` requires:

- current M17 registry state
- current M18 controlled rollout scope
- M18 dual-run monitoring records
- M19 operational samples
- explicit `windowStart`
- explicit `windowEnd`
- explicit soak criteria

Only monitoring and operational evidence whose `observedAt` falls inside the
window is evaluated.

Evidence outside the window is ignored.

The window itself is fingerprinted into the final soak artifact.

## Soak criteria

M19 does not silently choose operational thresholds.

The caller supplies explicit criteria:

- minimum window duration
- minimum operational samples
- minimum successful samples
- minimum target coverage
- maximum error rate
- maximum p95 latency
- whether REVIEW_REQUIRED must be zero
- whether BLOCK_EXPANSION must be zero

This keeps the operational policy visible and auditable.

## Metrics

The soak gate records:

- operational sample count
- successful sample count
- error sample count
- linked M18 monitoring record count
- number of monitored rollout targets
- target coverage
- error rate
- p95 latency
- M18 HEALTHY count
- M18 REVIEW_REQUIRED count
- M18 BLOCK_EXPANSION count

The p95 latency uses the deterministic nearest-rank value after sorting all
in-window operational sample durations.

## Fail-closed reasons

The gate can HOLD for:

- `SOAK_WINDOW_TOO_SHORT`
- `INSUFFICIENT_OPERATIONAL_SAMPLES`
- `INSUFFICIENT_SUCCESSFUL_SAMPLES`
- `INCOMPLETE_TARGET_COVERAGE`
- `ERROR_RATE_EXCEEDED`
- `LATENCY_EXCEEDED`
- `MISSING_MONITORING_LINKAGE`
- `REVIEW_REQUIRED`
- `BLOCK_EXPANSION`

A healthy gate returns:

`READY_FOR_SCOPE_EXPANSION_REVIEW`

This means only that a human may review an expansion proposal.

It does not expand scope automatically.

## Registry and evidence binding

Before soak evaluation, M19 requires the M18 scope to still match the exact
M17 registry state:

- registry revision
- registry-state fingerprint
- activation transaction ID
- candidate-policy fingerprint
- baseline rollback-policy fingerprint

M18 records inside the window must carry the same registry/scope/policy
linkage.

Operational samples must belong to the same scope.

Successful operational samples must point to an existing in-window M18 record
with matching row/chapter identity.

This prevents mixing old soak evidence with a different activation or rollout.

## Human expansion authorization

Every expansion requires a new
`NqaScopeExpansionAuthorization`.

It contains:

- authorization ID
- authorizer ID
- fixed action `EXPAND_SCOPE`
- fixed statement `I_APPROVE_NQA_SCOPE_EXPANSION`
- expected M17 registry revision/state fingerprint
- activation transaction ID
- source M18 scope ID/fingerprint
- source M19 soak artifact fingerprint
- candidate/baseline policy fingerprints
- proposed new scope ID
- proposed target-set fingerprint
- approval timestamp
- validity deadline
- authorization fingerprint

The authorization is an integrity/intent artifact. It is not a cryptographic
identity signature; authenticated operator identity remains a control-plane
responsibility.

## Scope expansion transaction

`expandNqaControlledRolloutScope()` performs the transaction.

It requires all of the following:

1. soak artifact is fingerprint-valid
2. soak decision is `READY_FOR_SCOPE_EXPANSION_REVIEW`
3. current M17 registry still matches the source M18 scope
4. current scope journal state still equals the authorization source scope
5. authorization is fingerprint-valid
6. commit time is inside the authorization window
7. authorization is bound to the exact registry/scope/soak/policies
8. proposed target-set fingerprint matches
9. next scope preserves every existing target
10. at least one new target is added
11. candidate/baseline/registry linkage is unchanged
12. M18 hard scope bound is preserved

The M18 scope schema limits a scope to 100 explicit row/chapter targets, so
M19 expansion cannot exceed that bound.

## Independent scope journal

M19 does not write another M17 policy activation event.

Policy activation and rollout expansion are separate concerns.

M19 keeps an independent scope state:

- revision
- current scope
- last expansion transaction ID
- deterministic state fingerprint

Expansion events contain:

- transaction ID
- human authorization
- source scope
- source soak gate
- exact newly added targets
- previous revision/state fingerprint
- resulting scope state
- commit timestamp
- event fingerprint

The journal uses compare-and-append semantics.

The JSON implementation:

- writes a create-only genesis
- uses a transaction lock
- writes one create-only event per revision
- replays and validates the complete chain on read

The in-memory implementation follows the same transition validation for tests.

## Idempotency

Reusing the same expansion transaction ID with the same authorization and
proposed scope/target set returns the existing event.

Reusing the transaction ID with different intent fails closed.

## Rollback compatibility

M19 never changes the M17 policy registry.

If M17 rolls back after soak evidence was produced, the current registry no
longer matches the old M18 scope.

Expansion therefore fails closed before changing the scope journal.

The M18 resolver then follows its existing immediate
`ROLLED_BACK_BASELINE` behavior.

## Control-plane boundary

M19 declares:

- `nqa.rollout.evaluate_soak`
  - permission: `READ`
  - effect: `READ_ONLY`
- `nqa.rollout.expand_scope`
  - permission: `PRODUCTION_MUTATION`
  - effect: `PRODUCTION_MUTATION`

The default enabled tiers remain:

- `READ`
- `QA_OPERATE`

Therefore scope expansion remains disabled by default until the production
mutation tier is explicitly enabled.

## Isolation

M19 does not:

- activate a policy
- rollback a policy
- automatically enlarge scope
- schedule periodic expansion
- write Google Docs
- write Google Sheets
- mutate novel/source/translation content
- expose raw novel text in telemetry
- register an HTTP listener
- import a production database/ORM

Durable writes are limited to QA-owned operational samples and rollout scope
journal artifacts.

## Recommended next milestone

**M20 — Graduated Rollout Completion + Candidate Finalization Gate**

M20 should define how repeated successful M19 soak/expansion cycles reach a
terminal rollout state, require final broad-scope evidence, and explicitly
decide whether the candidate can become the new baseline for a future policy
cycle without silently deleting rollback/audit history.
