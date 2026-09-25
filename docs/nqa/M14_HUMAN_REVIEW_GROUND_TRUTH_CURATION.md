# M14 — Human Review + Ground-Truth Curation Workflow

## Purpose

M14 turns M13 shadow-evaluation records into an auditable human-review and
ground-truth curation workflow.

M14 does not alter the machine QA result. It layers human review state over the
immutable M13 record and produces a deterministic curated dataset for later
calibration.

The core goals are:

- deterministic selection of cases needing review
- explicit human evidence for every review action
- append-only provenance
- reproducible state derivation
- safe disagreement and resolution handling
- deterministic curated exports for M15

## Safety boundary

M14 is QA-state only.

It must not:

- edit source or translation Google Docs
- update or append production Google Sheets
- change publication state
- change M08-M12 model thresholds
- rerun or overwrite the M13 machine result during label promotion
- introduce an application listener
- introduce a production database dependency

Review mutation is exposed as a QA-state capability:

`nqa.review.submit_action`

It requires `QA_OPERATE`.

Curation export remains read-only:

`nqa.review.export_curated`

It requires `READ`.

Existing review discovery capabilities remain:

- `nqa.review.list`
- `nqa.review.inspect`

## Architecture

```text
M13 shadow record
  machine result (immutable)
  hashes / scores / stage results / bounded evidence
                |
                v
        M14 review subject fingerprint
                |
        +-------+--------+
        |                |
        v                v
 deterministic      append-only
 review queue       review journal
                         |
              PROPOSE / CONFIRM
              DISPUTE / RESOLVE
                         |
                         v
                deterministic reducer
                         |
              +----------+----------+
              |                     |
              v                     v
        review state          curated label
        pending/etc.          HUMAN_CONFIRMED
              |                     |
              +----------+----------+
                         v
                 curation export
                         |
                         v
                    M15 input
```

## Implementation

M14 lives under:

`server/nqa/review/`

Modules:

- `contracts.ts` — action, evidence, state, queue and export contracts
- `workflow.ts` — subject fingerprints, journal validation, state reducer and label promotion
- `queue.ts` — deterministic actionable-case queue
- `store.ts` — in-memory and immutable JSON-file journal stores
- `export.ts` — deterministic bounded curation dataset export
- `index.ts` — exports

`server/nqa/index.ts` exports the M14 review module.

## Review subject fingerprint

Every human action is bound to the exact M13 machine subject.

The subject fingerprint covers:

- run ID
- batch fingerprint
- case ID
- row
- chapter
- input fingerprint
- baseline M13 ground-truth/candidate state
- complete bounded M13 machine snapshot

This means a review action created for one machine result cannot silently be
reapplied after the machine output changes.

A stale subject fingerprint fails closed.

## Explicit reviewer evidence

Every M14 action requires at least one evidence reference.

Supported evidence references:

### M13_EVIDENCE

References an existing bounded M13 evidence ID.

The ID must exist in the target M13 machine record.

### SOURCE_HASH

References the M13 source SHA-256.

The hash must exactly match the M13 record.

### TRANSLATION_HASH

References the M13 translation SHA-256.

The hash must exactly match the M13 record.

An arbitrary hash or unknown evidence ID is rejected.

Raw chapter text is not stored in the review journal.

## Review actions

M14 uses four append-only action types.

### PROPOSE

Creates or updates a pending candidate label.

Valid from:

- PENDING
- PROPOSED

Result:

- PROPOSED

### CONFIRM

Signs off the active proposal.

Requirements:

- current state is PROPOSED
- confirmed decision/reason codes match the active proposal
- reviewer evidence is present

Result:

- CONFIRMED
- final ground truth becomes HUMAN_CONFIRMED

An existing M13 `CANDIDATE_PENDING_HUMAN_SIGNOFF` label is treated as an
active proposal and can be confirmed directly.

### DISPUTE

Challenges an existing proposal or final human label.

Valid from:

- PROPOSED
- CONFIRMED
- RESOLVED

Result:

- DISPUTED
- prior final label is no longer considered final in the derived state
- the dispute action carries the competing label

### RESOLVE

Adjudicates a disputed case.

Requirement:

- current state is DISPUTED

Result:

- RESOLVED
- the resolution label becomes HUMAN_CONFIRMED

## Append-only journal

Each review action contains:

- action ID
- run ID / case ID
- subject fingerprint
- sequence
- previous action hash
- action hash
- action type
- reviewer ID
- proposed/confirmed label
- bounded evidence references
- optional bounded note
- timestamp

The action hash covers the complete action payload except the hash itself.

The journal validator requires:

- contiguous sequence numbers
- exact previous-hash chaining
- valid action hashes
- unique action IDs
- matching M13 target
- matching subject fingerprint
- valid bounded evidence references

Any tampering or stale target invalidates the journal.

## File-backed immutable journal

`JsonFileNqaReviewJournalStore` writes each action as a new create-only file:

```text
<qa-root>/
  <runId>/
    review/
      <caseId>/
        actions/
          000001-<actionHash>.json
          000002-<actionHash>.json
          ...
```

Files are opened with create-only semantics (`wx`).

There is no update/delete API in the journal store.

A correction is represented as a new review action, not an overwrite.

## Deterministic review queue

The queue only includes actionable cases.

Priority order:

1. DISPUTED_LABEL — priority 400
2. PENDING_CONFIRMATION — priority 300
3. MACHINE_REVIEW — priority 200
4. UNLABELED — priority 100

Final CONFIRMED/RESOLVED cases are excluded.

Tie-breaking is deterministic:

1. priority descending
2. row ascending
3. chapter ascending
4. case ID lexical order

Queue input must belong to a single M13 run/batch and case IDs must be unique.

The queue exposes only bounded M13 evidence summaries.

## Ground-truth promotion

M14 derives final ground truth from:

- the original M13 candidate/final label, if present
- the validated append-only M14 journal

Promotion to `HUMAN_CONFIRMED` occurs only through:

- CONFIRM
- RESOLVE

`curateNqaShadowRecord()` returns a new record view.

It does not mutate the original M13 record.

The machine result is cloned unchanged.

No model call occurs during promotion.

## Disagreement behavior

A dispute intentionally removes the disputed label from final-ground-truth
status in the derived M14 state.

The case returns to the top of the review queue.

A final label is restored only through explicit RESOLVE evidence.

This prevents a disputed label from entering M15 calibration as if it were
settled.

## Deterministic curation export

M14 exports one bounded dataset per M13 run/batch.

Each curated case contains:

- row / chapter / case ID
- input fingerprint
- review subject fingerprint
- baseline M13 ground-truth/candidate metadata
- active candidate label
- full bounded M13 machine snapshot
  - decision/reasons
  - stage decisions
  - scores
  - source/translation hashes
  - provider/model versions
  - policy versions
  - bounded evidence summaries
- derived review status
- final ground truth when settled
- complete append-only review action trail

The export also includes:

- total case count
- final-label count
- unresolved count
- deterministic dataset fingerprint

No export timestamp is added because it would make identical inputs produce a
different dataset fingerprint.

Cases are sorted by:

1. row
2. chapter
3. case ID

Therefore identical M13 records + identical review journals yield the same
curation export and dataset fingerprint regardless of input array ordering.

## Relationship to M13

M13 remains the machine-evaluation source of truth.

M14 does not rewrite:

- machine decision
- machine reason codes
- alignment scores
- structure verification
- provider/model versions
- policy versions

Human curation is an independent provenance layer.

## Relationship to M15

M15 — Threshold Calibration should consume only M14 exports with appropriate
human-confirmed coverage.

M14 provides M15 with:

- stable machine fingerprints
- stable human labels
- unresolved/disputed exclusion signals
- reason-code provenance
- model/policy version provenance
- deterministic dataset fingerprints

M15 must not treat unresolved cases as confirmed calibration truth.

## Scope intentionally deferred

M14 does not implement:

- a visual review UI
- reviewer authentication backend
- multi-user locking
- reviewer quality scoring
- automatic threshold tuning
- production scheduler activation
- remediation/write-back
- publication gating

Recommended next milestone:

**M15 — Real-World Threshold Calibration + Promotion Gate**
