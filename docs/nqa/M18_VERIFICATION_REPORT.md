# M18 Verification Report

## Milestone

M18 — Controlled Production Activation + Dual-Run Monitoring

## Delivered behavior

M18 adds:

- an explicit <=100 target rollout scope
- exact binding to one M17 activation registry state
- registry-backed runtime policy resolution
- global candidate suppression when no scope exists
- baseline fallback outside scope
- candidate primary execution inside scope
- full semantic baseline/candidate dual-run inside scope
- bounded append-only monitoring evidence
- conservative expansion health classification
- deterministic manual expansion gate
- immediate baseline behavior after M17 rollback

## Controlled activation checks

Verified:

- activated candidate is not globally selected without an M18 scope
- candidate is selected only for exact approved row/chapter targets
- out-of-scope requests use baseline
- scope target order is deterministic
- duplicate targets are collapsed during scope construction
- scope is bound to exact registry revision/state/candidate/baseline
- validly rehashed scope from another registry state is rejected

## Rollback checks

Verified:

- M17 rollback restores the exact previous policy
- an old M18 scope remaining in memory does not reactivate the candidate
- resolver returns `ROLLED_BACK_BASELINE`
- dual-run stops after rollback

## Dual-run integration

Verified using the real semantic handler pipeline:

- in-scope request executes baseline semantic QA
- in-scope request executes candidate semantic QA
- candidate result is returned as primary
- a monitoring record is appended
- reranker executes twice in scope
- document reader executes twice per pipeline, four reads total in the test
- out-of-scope request runs only one baseline pipeline
- out-of-scope request appends no monitoring record

## Monitoring safety

Verified:

- candidate more permissive than baseline -> `BLOCK_EXPANSION`
- incomplete scope coverage -> `HOLD`
- complete healthy scope coverage ->
  `READY_FOR_MANUAL_EXPANSION_REVIEW`
- no automatic scope expansion occurs

## Durable monitoring

Verified:

- JSON monitoring record is create-only
- reopening/listing reproduces the same record
- duplicate durable record write fails
- duplicate in-memory record ID fails

## Bounded evidence

Monitoring records contain only:

- identities/fingerprints
- decisions/reasons
- bounded alignment metrics
- provider/model/policy versions
- health/comparison flags

No raw novel text is persisted.

## Isolation

Static tests verify M18 production source has no:

- Google Docs mutation
- Google Sheets mutation
- Google permission mutation
- HTTP listener/router mutation
- production DB/Drizzle dependency
- raw sourceText/translationText persistence
- call to M17 activation
- call to M17 rollback
- automatic rollout target growth

## Targeted verification

Final targeted verification after formatting:

```text
Test Files: 9 passed
Tests:      51 passed
```

This includes M18 rollout, M17 activation, control-plane and MCP gateway boundary tests.

TypeScript:

```text
tsc --noEmit
PASS
```

## Full regression

Final NQA verification:

```text
Test Files: 72 passed
Tests:      368 passed
```

Formatting:

```text
Prettier
PASS
```

The final commit gate additionally verifies the intended staged file set,
`git diff --cached --check`, no secret/debug markers, no unrelated `.tmp`
artifacts, no active threshold-policy edits, and no change that enables
`PRODUCTION_MUTATION` by default.

## Production status

M18 provides the controlled runtime activation path and dual-run monitoring
mechanism but does not alter the default enabled production permission tiers and
does not execute a live production activation during milestone verification.

## Next milestone

**M19 — Production Soak Gate + Explicit Scope Expansion Transaction**
