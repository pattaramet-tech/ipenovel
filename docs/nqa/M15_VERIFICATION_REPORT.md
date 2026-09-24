# M15 Verification Report

## Milestone

M15 — Real-World Threshold Calibration + Promotion Gate

## Delivered behavior

M15 implements offline threshold replay and an auditable promotion gate over
M14 human-confirmed evidence.

No active threshold is modified.

## Calibration input gate

Verified:

- only settled `HUMAN_CONFIRMED` labels enter calibration
- unresolved/disputed cases are excluded
- non-human-confirmed labels are excluded
- incomplete M10 evidence is excluded
- policy/reranker version drift is excluded and counted
- eligible cases are deterministically ordered

## Replay correctness

Verified M10 alignment replay for:

- PASS
- REVIEW
- FAIL

Replay uses only M14-bounded metrics sufficient to reproduce M10.

Non-replayable settings such as `lowScoreThreshold`, chunk sizing, retrieval,
and model changes are intentionally not calibration knobs.

## Metrics

Verified:

- confusion matrix
- exact-match rate
- historical M10 replay agreement
- false-PASS rate
- false-FAIL rate
- PASS-against-non-PASS rate
- REVIEW rate
- case-level error lists
- deterministic profile fingerprints
- deterministic calibration dataset fingerprint

## Baseline provenance

Verified:

- calibration profiles in one run must share policy/reranker provenance
- a baseline that does not reproduce historical M10 decisions is detected
- tampered calibration profile fingerprints are rejected before promotion
- promotion returns `HOLD` with `BASELINE_REPLAY_MISMATCH`

## Promotion gate

Verified:

- explicit baseline and candidate selection
- insufficient labels => HOLD
- version mismatch => HOLD
- new false PASS => HOLD
- false-PASS count regression => HOLD
- candidate error/rate limits => HOLD
- safe candidate meeting all supplied criteria => PROMOTE
- repeated identical inputs produce identical promotion artifacts

The promotion artifact embeds:

- full baseline profile
- full candidate profile
- source/calibration dataset fingerprints
- criteria
- baseline/candidate metrics
- false-PASS deltas
- named failure reasons
- deterministic artifact fingerprint

## No-autotune boundary

Static isolation verifies that production M15 code contains no:

- Google Docs/Sheets mutation
- permission mutation
- application listener
- database/Drizzle dependency
- filesystem write API
- active M10 policy-module import
- active default-policy merge
- raw source/translation chapter text fields
- automatic threshold-apply API

The M15 control-plane capabilities are READ_ONLY.

## Targeted verification

Final targeted calibration/control-plane verification before full regression:

```text
Test Files: 5 passed
Tests:      23 passed
```

TypeScript:

```text
tsc --noEmit
PASS
```

## Full regression

Final verification after formatting:

```text
Test Files: 61 passed
Tests:      321 passed
```

TypeScript:

```text
tsc --noEmit
PASS
```

Formatting:

```text
Prettier
PASS
```

The remaining commit gate verifies the final intended staged file set,
`git diff --check`, no secret/debug markers, no unrelated `.tmp` artifacts,
and no active threshold-policy file changes.

## Threshold-policy boundary

M15 must not stage changes to:

- `server/nqa/deterministic/policy.ts`
- `server/nqa/semantic/policy.ts`
- `server/nqa/semantic/alignment/policy.ts`
- `server/nqa/semantic/adjudication/policy.ts`
- `server/nqa/semantic/structure/policy.ts`

The final commit gate verifies this explicitly.

## Real-world interpretation

A `PROMOTE` artifact means only that the explicitly supplied candidate passed
the configured evidence gate on the supplied M14 dataset.

It is not an activation action.

No new production threshold is activated in M15.

## Next milestone

**M16 — Candidate Policy Materialization + Controlled Shadow Revalidation**
