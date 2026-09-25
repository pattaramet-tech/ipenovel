# M13 — Real-World Batch Shadow Evaluation + Labeled Evidence Collection

## Purpose

M13 turns the completed NQA M08-M12 QA chain into a bounded batch-evaluation
workflow suitable for real novel rows and chapters without enabling production
content mutation.

M13 is a shadow layer. It does not replace deterministic QA, semantic search,
cross-encoder alignment, M11 adjudication, or M12 structured verification.
Instead, it evaluates many cases through the existing pipeline, persists only
QA-owned evidence metadata, supports checkpoint/resume, and measures behavior
against human/canonical labels.

## Safety boundary

M13 remains read-only with respect to production novel content.

It must not:

- edit Google Docs
- update or append Google Sheets values
- change publication state
- alter source/translation content
- register a production HTTP listener
- introduce a production database dependency
- lower M08-M12 thresholds to improve benchmark numbers

M13 may write QA-owned shadow state through an explicitly injected
`NqaShadowStore`.

The provided file-backed store writes only below the caller-supplied shadow
root directory.

## Architecture

```text
real-world case manifest
    |
    v
M13 bounded batch runner
    |
    +--> existing semantic evaluator
    |      M08 deterministic
    |      M09 global wrong-source search
    |      M10 alignment/reranker
    |      M11 adjudication when applicable
    |      M12 event/entity/relationship/causality/chronology verification
    |
    +--> bounded machine evidence record
    |      hashes
    |      scores
    |      stage decisions
    |      provider/model versions
    |      policy versions
    |      bounded summaries
    |
    +--> QA-owned shadow store
    |      checkpoint.json
    |      records/<caseId>.json
    |      metrics.json
    |
    +--> human/canonical ground truth
           PASS / REVIEW / FAIL
           existing NQA reason-code taxonomy
           label status/provenance
```

## Implementation

M13 production code lives under:

`server/nqa/shadow/`

Modules:

- `contracts.ts` — bounded batch, label, checkpoint, evidence and metric contracts
- `evidence.ts` — converts the existing M08-M12 semantic result into bounded shadow evidence
- `runner.ts` — bounded execution, checkpoint/resume and label refresh
- `store.ts` — in-memory and JSON-file QA-state stores
- `metrics.ts` — confusion matrix and operational error/review metrics
- `index.ts` — module exports

`server/nqa/index.ts` exports the shadow module.

## Case contract

A shadow case is identified by:

- `caseId`
- Sheet row
- chapter
- optional input fingerprint

Optional metadata:

- tags
- ground-truth label

The batch fingerprint is derived from case identity only:

```text
caseId + row + chapter + inputFingerprint
```

Ground-truth labels and tags are deliberately excluded from the batch
fingerprint.

This permits a human reviewer to add or correct labels later without forcing
another model execution.

## Ground truth

Ground truth reuses the core NQA decision and reason-code contracts.

Decision:

- PASS
- REVIEW
- FAIL

Label status:

- CANONICAL_INCIDENT
- HUMAN_CONFIRMED
- CANDIDATE_PENDING_HUMAN_SIGNOFF

Only canonical/human-confirmed labels participate in final error-rate
calculations.

Pending human labels remain visible as collection backlog but do not distort
false PASS / false FAIL metrics.

## Bounded evidence policy

M13 does not persist raw novel chapter text.

Persisted machine evidence contains:

- final decision
- reason codes
- stage decisions
- expected source rank/similarity/lead
- alignment coverage and reranker scores
- gap fractions
- M12 strong match/mismatch counts
- source/translation SHA-256 values when available
- provider/model versions
- policy versions
- bounded evidence summaries

The persisted contracts contain no `sourceText` or `translationText` field.

## Checkpoint and resume

Every successful case is persisted before its case ID is added to the
checkpoint.

A checkpoint contains:

- run ID
- batch fingerprint
- completed case IDs
- update timestamp

If evaluation fails on a later case, already completed records remain durable.

On resume:

1. the batch fingerprint must match
2. every completed checkpoint case must have a stored record
3. completed cases are not reevaluated
4. changed labels/tags are refreshed on the stored record
5. only incomplete cases are sent to the evaluator

This makes repeated invocations idempotent for machine evaluation.

## Batch bounds

M13 enforces:

- 1-500 cases in one logical batch
- 1-100 new model evaluations per invocation
- default 20 new evaluations per invocation

A large real-world collection is therefore expected to advance through
multiple resumable invocations rather than one unbounded job.

## Metrics

M13 produces:

- machine PASS / REVIEW / FAIL counts
- number of final labeled cases
- pending-human-label count
- exact decision match rate
- false PASS count/rate
- false FAIL count/rate
- overall REVIEW rate
- REVIEW-on-final-label rate
- machine reason-code frequency
- PASS/REVIEW/FAIL confusion matrix

Definitions:

### False PASS

Machine decision is PASS while final ground truth is FAIL.

Denominator:

all final ground-truth FAIL cases.

### False FAIL

Machine decision is FAIL while final ground truth is PASS.

Denominator:

all final ground-truth PASS cases.

### REVIEW rate

All machine REVIEW results divided by all completed cases.

### REVIEW-on-final-label rate

Machine REVIEW results divided by cases that already have canonical or
human-confirmed ground truth.

These metrics are dataset measurements. M13 does not automatically alter any
threshold from them.

## Real-world evaluator integration

The runner depends on the small `NqaShadowEvaluator` interface.

The normal production-side adapter should invoke the existing semantic QA
flow and pass its `NqaSemanticQaStageResult` through
`semanticShadowEvaluator()`.

This keeps M13 independent from Google transport, local model process
management, MCP transport, and application routing.

The real-world caller is responsible for choosing rows/chapters and supplying
the same providers already used by M08-M12.

## Persistence layout

For `JsonFileNqaShadowStore(root)`:

```text
<root>/
  <runId>/
    checkpoint.json
    metrics.json
    records/
      <caseId>.json
```

The root is injected by the caller and is QA-owned state.

Novel text snapshots are not stored by M13.

## Label collection workflow

Recommended workflow:

1. create a bounded case set from real production row/chapter identities
2. run M13 in shadow mode
3. inspect machine evidence
4. attach canonical/human labels
5. rerun the same M13 run ID
6. completed cases are reused and only label metadata is refreshed
7. export aggregate metrics for later calibration analysis

A label refresh does not call the model again.

## Relationship to M15

M09 already marks its semantic thresholds as provisional and reserves M15 for
real labeled calibration.

M13 provides the dataset mechanics required by that future calibration:

- stable case identity
- revision/input fingerprint support
- stage/model/policy provenance
- labeled decisions
- reason-code distribution
- confusion/error metrics

M13 itself does not tune thresholds.

## Scope intentionally deferred

M13 does not implement:

- a human review UI
- automatic label assignment
- threshold optimization
- production scheduler activation
- Google write-back
- remediation
- publication gating

Recommended next milestone:

**M14 — Human Review + Ground-Truth Curation Workflow**

M15 can then consume M13/M14 labeled evidence for threshold calibration and
promotion-gate design.
