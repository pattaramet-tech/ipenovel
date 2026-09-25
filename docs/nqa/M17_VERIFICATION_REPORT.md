# M17 Verification Report

## Milestone

M17 — Explicit Candidate Activation Transaction + Rollback Contract

## Delivered behavior

M17 adds an explicit, transactional policy-switching contract after M16.

It supports:

- M16-ready candidate verification
- explicit bounded human activation authorization
- compare-and-swap activation
- exact previous-policy rollback target preservation
- explicit bounded human rollback authorization
- compare-and-swap rollback
- append-only transaction audit journal
- deterministic registry/event/authorization fingerprints
- idempotent transaction replay

The default runtime production-mutation tier remains disabled.

## M16 readiness gate

Verified:

- valid M16 readiness accepted
- HOLD/not-ready evidence rejected
- candidate/readiness fingerprint linkage required
- candidate version linkage required
- fixed M16 safety guards required

## Human authorization

Verified:

- fixed ACTIVATE/ROLLBACK approval statements
- authorization binds registry revision
- authorization binds current active-policy fingerprint
- authorization binds exact target policy
- ACTIVATE authorization binds M16 readiness
- ROLLBACK authorization binds source activation transaction
- expired authorization rejected
- deterministic authorization fingerprint validation

Authorization fingerprints are integrity artifacts, not identity signatures.
Actor authentication remains a control-plane responsibility.

## Activation transaction

Verified:

- active state must equal M16 candidate base policy
- candidate becomes the resulting active policy
- previous policy is copied exactly into rollback target
- resulting revision increments exactly once
- transaction ID is recorded
- exact repeated transaction is idempotent
- different concurrent/stale intent cannot also commit

## Rollback transaction

Verified:

- rollback requires separate human authorization
- source activation transaction must match
- exact previous policy is restored
- revision increments
- rollback target is cleared after commit
- repeated exact rollback is idempotent
- unrelated second rollback is rejected

## Compare-and-swap

Verified:

- expected registry revision checked
- expected registry-state fingerprint checked
- current active-policy fingerprint checked through authorization
- racing activation intents from the same initial state yield only one commit

## Append-only journal

Verified:

- durable registry genesis is create-only
- transaction events are create-only
- state is reconstructed from genesis + ordered journal
- event chain verifies previous revision/state/active policy
- event fingerprints are validated
- semantic ACTIVATE/ROLLBACK transition rules are validated
- a forged event with a newly recomputed valid hash but invalid transition is rejected

## Durable rollback

Verified with the JSON-file store:

1. open registry with base policy
2. activate candidate
3. persist activation event
4. create rollback authorization
5. rollback
6. reopen the store
7. reconstruct revision 2
8. verify exact base policy restored

The reopened registry contains two immutable events:

- ACTIVATE
- ROLLBACK

## Genesis safety

Reopening an existing durable registry with a different initial policy is
rejected.

This prevents a caller from silently reinterpreting an existing transaction
journal under another genesis policy.

## Control-plane safety interlock

M17 declares:

- `nqa.policy.activate_candidate`
- `nqa.policy.rollback`

Both require `PRODUCTION_MUTATION`.

The default `NQA_V1_ENABLED_PERMISSION_TIERS` remains only:

- READ
- QA_OPERATE

Verified:

- production mutation is denied with `TIER_DISABLED` by default
- the capability becomes authorizable only when the caller explicitly enables
  the production tier and the actor has that permission

## Isolation

Static tests verify no M17 production source contains:

- Google Docs mutation
- Google Sheets mutation
- Google permission mutation
- HTTP route/listener registration
- database/Drizzle import
- raw source/translation novel-text fields
- import/use of the static active M10 policy module

Filesystem writes are limited to the dedicated activation registry store.

## Targeted verification

Final targeted verification after formatting and final hardening:

```text
Test Files: 5 passed
Tests:      39 passed
```

TypeScript:

```text
tsc --noEmit
PASS
```

## Full regression

Final NQA verification:

```text
Test Files: 68 passed
Tests:      356 passed
```

Formatting:

```text
Prettier
PASS
```

The final commit gate additionally verifies the intended staged file set,
`git diff --cached --check`, no secret/debug markers, no unrelated `.tmp`
artifacts, and no active threshold-policy source-file changes.

## Active policy file boundary

The final staged gate must show no changes to:

- `server/nqa/deterministic/policy.ts`
- `server/nqa/semantic/policy.ts`
- `server/nqa/semantic/alignment/policy.ts`
- `server/nqa/semantic/adjudication/policy.ts`
- `server/nqa/semantic/structure/policy.ts`

M17 activates through the transaction registry contract, not by modifying those
static source files.

## Production status

M17 provides the activation/rollback mechanism but does not enable the
`PRODUCTION_MUTATION` tier by default and does not perform a real production
activation during this milestone.

## Next milestone

**M18 — Controlled Production Activation + Dual-Run Monitoring**
