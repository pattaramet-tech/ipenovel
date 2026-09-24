# M13 Verification Report

## Milestone

M13 — Real-World Batch Shadow Evaluation + Labeled Evidence Collection

## Result

M13 implementation is accepted. The final staged-diff gate is clean before commit.

The implementation adds a read-only production-content shadow orchestration
layer and QA-owned evidence persistence.

## Delivered behavior

### Bounded batch runner

`runNqaShadowBatch()`:

- accepts 1-500 logical cases
- processes at most 1-100 new cases per invocation
- defaults to 20 new evaluations per invocation
- preserves case order
- checkpoints after each successful case
- fails closed on batch fingerprint mismatch

### Resume and idempotency

Verified behavior:

- completed cases are not reevaluated
- partial progress survives a later evaluator failure
- a checkpoint cannot reference a missing record
- changing row/chapter/input identity under the same run ID is rejected
- human labels/tags may change without changing the batch fingerprint
- label refresh reuses existing machine output

### Labeled evidence

Ground truth records:

- PASS / REVIEW / FAIL
- existing NQA reason codes
- CANONICAL_INCIDENT / HUMAN_CONFIRMED / CANDIDATE_PENDING_HUMAN_SIGNOFF
- optional reviewer identity/timestamp/notes

Only final canonical/human labels count toward final error metrics.

### Bounded machine evidence

Collected metadata includes:

- final and per-stage decisions
- M09 expected rank/similarity/lead
- M10 coverage/rerank/gap metrics
- M12 strong match/mismatch metrics
- source/translation hashes
- provider/model versions
- policy versions
- bounded evidence summaries

No raw source/translation chapter text is part of the M13 persisted contract.

### Metrics

Verified metric implementation includes:

- decision counts
- final-label count
- pending-label count
- exact-match rate
- false PASS rate
- false FAIL rate
- REVIEW rate
- REVIEW-on-final-label rate
- reason-code counts
- PASS/REVIEW/FAIL confusion matrix

## Persistence

Two stores are provided:

- `InMemoryNqaShadowStore`
- `JsonFileNqaShadowStore`

The JSON store persists only below the caller-supplied QA shadow root.

Windows overwrite behavior was explicitly tested by writing the same record
and checkpoint twice.

## Safety and isolation

Static M13 isolation tests reject:

- Google Docs batch mutation
- Google Sheets update/append/batch mutation
- permission mutation
- application route/listener registration
- Drizzle/database imports

The persisted M13 contracts do not include raw `sourceText` or
`translationText` fields.

No existing NQA threshold policy file was modified.

Unrelated `.tmp/nqa-fullqa/*` work remains untracked and is outside M13
commit scope.

## Verification evidence

### M13 targeted suite

```text
Test Files: 5 passed
Tests:      10 passed
```

Coverage includes:

- bounded checkpoint/resume
- no reevaluation of completed cases
- label-only refresh
- fingerprint mismatch rejection
- partial failure recovery
- confusion/error metrics
- bounded evidence extraction
- JSON file persistence
- Windows overwrite
- read-only/isolation rules

### Full NQA regression

```text
Test Files: 52 passed
Tests:      285 passed
```

### TypeScript

```text
tsc --noEmit
PASS
```

### Diff/threshold gate

```text
git diff --check
PASS

NQA threshold policy files changed
NONE
```

## Calibration boundary

M13 collects measurements but does not interpret them as production
thresholds.

No M08-M12 threshold was reduced or changed.

M15 remains responsible for calibration against a sufficiently sized,
human-confirmed real-world dataset.

## Live data note

M13 provides the durable batch/evidence layer that can be driven by the
existing semantic evaluator against real row/chapter identities.

Implementation verification deliberately does not mutate production Google
content and does not import the unrelated active `.tmp/nqa-fullqa/*`
artifacts into Git.

## Next milestone

Recommended:

**M14 — Human Review + Ground-Truth Curation Workflow**

M14 should make pending labels reviewable/reproducible while keeping content
mutation disabled. M15 can then consume the confirmed M13/M14 dataset for
calibration.
