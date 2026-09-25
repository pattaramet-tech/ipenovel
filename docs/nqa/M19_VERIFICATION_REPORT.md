# M19 Verification Report

## Milestone

M19 — Production Soak Gate + Explicit Scope Expansion Transaction

## Delivered

M19 adds:

- separate bounded operational telemetry linked to M18
- explicit soak-window evaluation
- sample/success/coverage/error/p95 latency metrics
- deterministic HOLD / READY_FOR_SCOPE_EXPANSION_REVIEW artifact
- human expansion authorization with validity window
- monotonic scope expansion transaction
- independent CAS scope journal
- in-memory and durable JSON stores
- control-plane capability boundaries

## Soak-window verification

Verified:

- evidence inside the requested window is evaluated
- evidence outside the window is ignored
- insufficient samples hold
- insufficient successful samples hold
- incomplete target coverage holds
- excessive error rate holds
- excessive p95 latency holds
- M18 REVIEW_REQUIRED can hold
- M18 BLOCK_EXPANSION can hold
- tampered operational evidence fails fingerprint verification
- successful telemetry linked to the wrong M18 record is rejected
- a fingerprint-valid M18 record whose row/chapter is outside the approved scope is rejected
- healthy complete evidence becomes READY_FOR_SCOPE_EXPANSION_REVIEW

## Operational wrapper verification

Verified:

- in-scope successful requests emit SUCCESS telemetry
- duration is captured from an injectable monotonic clock
- M18 monitoring record ID/fingerprint is linked
- runtime failures emit bounded ERROR telemetry
- exception message content is not stored
- original runtime error is rethrown
- out-of-scope requests emit no soak telemetry

## Expansion transaction verification

Verified:

- fresh human authorization is required
- authorization is bound to M17 registry revision/state
- authorization is bound to activation transaction
- authorization is bound to source scope
- authorization is bound to soak artifact
- authorization is bound to candidate/baseline fingerprints
- authorization is bound to proposed scope ID/target set
- expired authorization is rejected
- tampered authorization is rejected
- HOLD soak artifact cannot expand
- target removal is rejected
- expansion must add at least one target
- candidate/baseline linkage cannot change
- > 100 target expansion is rejected by the M18 hard bound
- rollbacked/stale M17 state rejects old soak/authorization
- identical transaction retry is idempotent

## Durable replay verification

Verified:

- operational JSON samples are create-only
- duplicate sample write fails
- scope journal genesis is deterministic
- expansion event is create-only
- reopening the expansion store replays to the exact resulting state
- event listing reproduces the committed event

## Control-plane verification

M19 declares:

- `nqa.rollout.evaluate_soak` as READ / READ_ONLY
- `nqa.rollout.expand_scope` as PRODUCTION_MUTATION

The default enabled tiers remain READ + QA_OPERATE only.

Scope expansion therefore remains disabled by default.

## Isolation verification

Static checks verify M19 production code contains no:

- Google Docs mutation
- Google Sheets mutation
- permission mutation
- HTTP route/listener
- production DB/Drizzle dependency
- raw sourceText/translationText persistence
- M17 activation call
- M17 rollback call
- automatic timer-driven expansion

## Targeted verification

Final targeted M17–M19 boundary verification after formatting:

```text
Test Files: 14 passed
Tests:      72 passed
```

This includes M19 soak/expansion, M18 rollout, M17 activation, control-plane
and MCP gateway boundary tests.

TypeScript:

```text
tsc --noEmit
PASS
```

## Full regression

Final NQA verification:

```text
Test Files: 77 passed
Tests:      389 passed
```

Formatting:

```text
Prettier
PASS
```

The final commit gate additionally verifies the exact staged file set,
`git diff --cached --check`, no secret/debug markers, no unrelated `.tmp`
artifacts, no active threshold-policy edits, and no change to the default
`NQA_V1_ENABLED_PERMISSION_TIERS` value.

## Production status

M19 implements the production soak and explicit expansion mechanisms but does
not execute a live production expansion during milestone verification.

No production Google/content mutation is enabled.

## Next milestone

**M20 — Graduated Rollout Completion + Candidate Finalization Gate**
