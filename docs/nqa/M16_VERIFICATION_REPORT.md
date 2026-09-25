# M16 Verification Report

## Milestone

M16 — Candidate Policy Materialization + Controlled Shadow Revalidation

## Delivered behavior

M16 adds a pure-artifact safety stage after M15.

It can:

- verify an M15 `PROMOTE` artifact
- bind it to the exact full source M10 policy
- materialize a new versioned `INACTIVE` candidate policy
- verify M14 curation-export integrity
- replay candidate thresholds over controlled human-confirmed shadow evidence
- run the unchanged M15 promotion criteria on the shadow dataset
- emit fail-closed activation-readiness evidence

It cannot activate policy.

## Materialization verification

Verified:

- valid M15 `PROMOTE` accepted
- M15 `HOLD` rejected
- tampered M15 artifact rejected
- mismatched base policy version rejected
- mismatched base replayable thresholds rejected
- candidate version must differ from base version
- non-calibrated M10 fields are inherited unchanged
- candidate state is always `INACTIVE`
- materialized policy and artifact are frozen after validation
- policy/materialization fingerprints are deterministic

## Shadow revalidation verification

Verified:

- M14 curation-export fingerprint is recomputed before replay
- candidate profile is rebuilt from the materialized full policy
- rebuilt candidate fingerprint must equal the M15 promoted profile
- the same M15 criteria are reused without an override
- a compatible distinct shadow can produce shadow `PROMOTE`
- same-dataset replay is identified explicitly as non-distinct
- regression evidence produces shadow `HOLD`
- tampered M14 export is rejected
- mutated materialized policy is rejected

## Readiness verification

The M16 activation-readiness gate has fixed, non-disableable guards:

- distinct shadow dataset required
- shadow `PROMOTE` required
- candidate must remain `INACTIVE`

Verified:

- fresh passing shadow => `READY_FOR_EXPLICIT_ACTIVATION_REVIEW`
- same original M15 dataset => `HOLD`
- distinct shadow with gate regression => `HOLD`
- internally valid but cross-linked shadow artifact => `HOLD`

Readiness never activates the policy.

## Control-plane boundary

The following capabilities require only READ permission and have READ_ONLY
effect:

- `nqa.candidate_policy.materialize`
- `nqa.candidate_policy.shadow_revalidate`
- `nqa.candidate_policy.activation_readiness`

## Isolation

Static verification checks M16 production sources for absence of:

- Google Docs/Sheets content mutation
- permission mutation
- application listeners/routes
- filesystem write APIs
- database/Drizzle imports
- active M10 policy-module import
- default-policy merge
- production activation/apply APIs
- caller overrides capable of disabling readiness guards

## Targeted verification

Final targeted verification after formatting and final hardening:

```text
Test Files: 5 passed
Tests:      27 passed
```

TypeScript:

```text
tsc --noEmit
PASS
```

## Full regression

Final NQA verification:

```text
Test Files: 65 passed
Tests:      341 passed
```

Formatting:

```text
Prettier
PASS
```

The final commit gate additionally verifies the intended staged file set,
`git diff --cached --check`, no secret/debug markers, no `.tmp` artifacts,
and no active threshold-policy file changes.

## Active-policy boundary

The final staged gate must show no changes to:

- `server/nqa/deterministic/policy.ts`
- `server/nqa/semantic/policy.ts`
- `server/nqa/semantic/alignment/policy.ts`
- `server/nqa/semantic/adjudication/policy.ts`
- `server/nqa/semantic/structure/policy.ts`

No production threshold activation belongs in M16.

## Real-world interpretation

M16 validates the machinery required to move a promoted threshold candidate
toward an explicit activation review.

It does not claim that a real candidate has completed independent shadow
revalidation in production.

No active NQA threshold is changed or activated by this milestone.

## Next milestone

**M17 — Explicit Candidate Activation Transaction + Rollback Contract**
