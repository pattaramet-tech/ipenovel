# M15 — Real-World Threshold Calibration + Promotion Gate

## Purpose

M15 adds an offline, reproducible calibration layer between M14 human curation
and any future threshold change.

The milestone answers two separate questions:

1. How would a candidate set of replayable M10 alignment thresholds behave on
   real human-confirmed cases?
2. Is there enough compatible evidence to permit that candidate to move forward
   for an explicit policy-change review?

A M15 `PROMOTE` decision is an evidence artifact only. It does not edit or
activate any NQA threshold.

## Safety boundary

M15 is read-only with respect to active NQA behavior.

It must not:

- mutate M08-M12 policy files
- write to Google Docs or Google Sheets
- modify M13 machine results
- modify M14 review journals or human labels
- persist raw novel text
- automatically choose and apply a threshold
- start a production listener or scheduler
- write to a production database

The control-plane capabilities are therefore read-only:

- `nqa.calibration.evaluate`
- `nqa.calibration.promotion_gate`

A future policy mutation must be a separate explicitly reviewed milestone.

## Why M15 calibrates M10 first

The M14 curation export stores bounded M10 metrics sufficient to replay the M10
alignment decision:

- mean rerank score
- source coverage
- translation coverage
- low-score fraction
- source gap fraction
- translation gap fraction
- historical M10 alignment decision
- M10 policy version
- reranker/model version

This is enough to replay these thresholds exactly:

- `minPassMeanScore`
- `minPassTranslationCoverage`
- `minPassSourceCoverage`
- `minReviewMeanScore`
- `minReviewTranslationCoverage`
- `minReviewSourceCoverage`
- `majorGapFraction`
- `maxLowScoreFractionPass`

M15 intentionally does **not** calibrate `lowScoreThreshold`.

That value was already used when M10 produced `lowScoreFraction`. Replaying a
different `lowScoreThreshold` would require the original per-pair rerank
scores, not the aggregated M14 metric.

The same restriction applies to chunking, dense retrieval, reranker model, and
other non-replayable M10 settings.

This prevents threshold calibration from pretending to evaluate changes for
which the stored evidence is insufficient.

## Input

M15 consumes `NqaCurationExport` from M14.

Only a case satisfying all of the following enters the calibration dataset:

1. review status is `CONFIRMED` or `RESOLVED`
2. final ground truth status is exactly `HUMAN_CONFIRMED`
3. M10 alignment decision exists
4. every M10 metric needed for replay exists
5. M10 policy version matches the calibration profile provenance
6. reranker version matches the calibration profile provenance

Other cases are counted but excluded.

Exclusion groups:

- `unresolvedOrUnsettled`
- `nonHumanConfirmed`
- `missingAlignmentEvidence`
- `versionMismatch`

Canonical incidents or machine-generated candidates are not silently treated as
human-confirmed calibration truth.

## Threshold profile

A calibration profile contains:

- profile ID
- source M10 policy version
- reranker version
- replayable threshold values

Threshold ordering is validated:

- review mean-score threshold cannot exceed pass mean-score threshold
- review translation-coverage threshold cannot exceed pass threshold
- review source-coverage threshold cannot exceed pass threshold

All profiles in one calibration run must use the same source policy version and
reranker version.

The profile describes an offline counterfactual replay. It is not an active
policy.

## Calibration dataset fingerprint

M15 builds a deterministic calibration dataset fingerprint from:

- M14 dataset fingerprint
- required M10 policy version
- required reranker version
- ordered eligible case identity
- M14 review subject fingerprint
- human-confirmed decision
- historical M10 alignment decision
- bounded M10 score snapshot

Eligible cases are sorted by row, chapter, and case ID.

Identical evidence therefore produces the same calibration dataset fingerprint
regardless of caller array ordering.

## Exact M10 decision replay

The evaluator mirrors the M10 alignment decision boundary.

### PASS

A replay is PASS when all are true:

- mean rerank score >= pass threshold
- translation coverage >= pass threshold
- source coverage >= pass threshold
- low-score fraction <= pass maximum

### FAIL

If PASS does not apply, FAIL occurs when any is true:

- source gap >= major-gap threshold
- translation gap >= major-gap threshold
- mean rerank score < review threshold
- translation coverage < review threshold
- source coverage < review threshold

### REVIEW

If neither PASS nor FAIL applies, the replay is REVIEW.

This matches the replayable M10 decision logic without rerunning the reranker.

## Baseline historical replay check

For every profile M15 also measures agreement between:

- the replayed M10 decision
- the historical M10 alignment decision stored by M13/M14

The baseline profile used for promotion must reproduce the historical decisions
at 100% when the default promotion criterion is enabled.

If it does not, the promotion gate returns:

`BASELINE_REPLAY_MISMATCH`

This prevents a wrong or stale threshold profile from being called the
baseline.

## Calibration metrics

Each profile receives:

- evaluated case count
- truth PASS / REVIEW / FAIL counts
- replay PASS / REVIEW / FAIL counts
- full confusion matrix
- exact-match count/rate
- historical-alignment replay count/rate
- false PASS count/rate
- false FAIL count/rate
- PASS-against-non-PASS count/rate
- REVIEW count/rate
- per-case replay result
- false-PASS case IDs
- false-FAIL case IDs
- PASS-against-non-PASS case IDs
- REVIEW case IDs
- deterministic profile fingerprint

### False PASS

`truth = FAIL && replay = PASS`

This is treated as the primary safety regression.

### False FAIL

`truth = PASS && replay = FAIL`

This captures overly aggressive failure behavior.

### PASS against non-PASS

`truth != PASS && replay = PASS`

This additionally includes human `REVIEW` truth and is a conservative signal
that a candidate may be passing cases humans did not label as PASS.

## Promotion gate

The promotion gate compares one explicitly selected baseline profile with one
explicitly selected candidate profile from the same calibration report.

It never selects the candidate itself and never edits the active policy.

The artifact is self-contained and records:

- M14 source dataset fingerprint
- M15 calibration dataset fingerprint
- complete baseline threshold profile
- complete candidate threshold profile
- profile fingerprints
- promotion criteria
- baseline metrics
- candidate metrics
- newly introduced false-PASS case IDs
- resolved false-PASS case IDs
- failure reasons
- `PROMOTE` or `HOLD`
- deterministic artifact fingerprint

## Default promotion criteria

The implementation includes conservative engineering defaults:

- minimum eligible human-confirmed cases: 50
- minimum human PASS cases: 15
- minimum human FAIL cases: 10
- zero compatible-case version mismatches
- baseline historical replay agreement: 100%
- candidate false-PASS rate <= 2%
- candidate PASS-against-non-PASS rate <= 5%
- false-PASS count increase over baseline: 0
- no newly introduced false-PASS case
- candidate false-FAIL rate <= 10%
- false-FAIL count increase over baseline: 0
- candidate REVIEW rate <= 35%
- candidate exact-match rate >= 70%

These are gate defaults, not claims that the values are empirically optimal.
They can be overridden explicitly for an evaluation, but M15 never changes
active NQA thresholds.

## Fail-closed behavior

A promotion artifact is `HOLD` when any configured criterion fails.

Named reasons include:

- `INSUFFICIENT_ELIGIBLE_CASES`
- `INSUFFICIENT_PASS_TRUTH_CASES`
- `INSUFFICIENT_FAIL_TRUTH_CASES`
- `VERSION_MISMATCH_CASES_PRESENT`
- `BASELINE_REPLAY_MISMATCH`
- `CANDIDATE_FALSE_PASS_RATE_EXCEEDED`
- `CANDIDATE_PASS_AGAINST_NON_PASS_RATE_EXCEEDED`
- `FALSE_PASS_COUNT_REGRESSION`
- `NEW_FALSE_PASS_CASE_INTRODUCED`
- `CANDIDATE_FALSE_FAIL_RATE_EXCEEDED`
- `FALSE_FAIL_COUNT_REGRESSION`
- `CANDIDATE_REVIEW_RATE_EXCEEDED`
- `CANDIDATE_EXACT_MATCH_RATE_BELOW_MINIMUM`

A missing required rate also fails the applicable maximum/minimum check rather
than being interpreted as success.

## Implementation

M15 lives under:

`server/nqa/calibration/`

Modules:

- `contracts.ts` — calibration/profile/metrics/promotion contracts
- `profile.ts` — snapshot replayable fields from an explicit M10 policy value
- `evaluator.ts` — human-confirmed filtering, exact replay and metrics
- `promotion.ts` — fail-closed baseline/candidate promotion gate
- `index.ts` — public exports

The module is exported through `server/nqa/index.ts`.

## Relationship to M14

M14 remains the authority for curated human evidence.

M15 does not create or modify human labels.

Unresolved and disputed cases cannot become calibration truth merely because a
machine score exists.

## Relationship to active M10 policy

M15 does not import the active `semantic/alignment/policy.ts` module in its
production calibration code.

A caller may explicitly snapshot an M10 policy object with
`buildNqaAlignmentThresholdProfile()`, but M15 does not read, overwrite, or
merge the active default policy on its own.

This preserves the separation:

```text
M14 evidence
    |
    v
M15 offline calibration
    |
    v
M15 PROMOTE / HOLD artifact
    |
    v
explicit future policy-change review
```

## Real-world promotion state after this milestone

M15 provides the machinery and safety gate for real-world calibration.

It does **not** claim that a new threshold has been promoted. A real promotion
requires an M14 export with enough compatible `HUMAN_CONFIRMED` labels and an
explicit candidate profile that passes the gate.

No M08-M12 threshold is changed by M15.

## Next milestone

Recommended next step:

**M16 — Candidate Policy Materialization + Controlled Shadow Revalidation**

M16 should consume an explicit M15 `PROMOTE` artifact, materialize the
candidate as a new versioned policy without overwriting the current default,
rerun controlled shadow verification, and require a separate activation gate.
