# M14 Verification Report

## Milestone

M14 — Human Review + Ground-Truth Curation Workflow

## Delivered behavior

M14 adds an auditable curation layer over M13 without changing production
content or the machine QA result.

### Review queue

Verified:

- deterministic actionable-case selection
- DISPUTED before pending confirmation
- pending confirmation before machine REVIEW
- machine REVIEW before ordinary unlabeled cases
- deterministic row/chapter/case tie-breaking
- final confirmed/resolved cases excluded

### Review journal

Verified:

- PROPOSE
- CONFIRM
- DISPUTE
- RESOLVE
- contiguous sequence validation
- previous-action hash chain
- action payload hash validation
- duplicate action rejection
- stale M13 subject fingerprint rejection
- explicit reviewer evidence validation

### Human confirmation

Verified:

- M13 pending-human candidates can be confirmed directly
- CONFIRM must match the active proposal
- confirmed labels become HUMAN_CONFIRMED
- disputes remove the old label from final derived state
- RESOLVE restores a final HUMAN_CONFIRMED label
- curation returns a new record view
- M13 machine output remains unchanged
- no model rerun is involved in label promotion

### Evidence grounding

Verified action evidence may reference only:

- existing M13 evidence IDs
- exact M13 source hash
- exact M13 translation hash

Mismatched hashes and unknown evidence IDs fail closed.

### Curation export

Verified:

- deterministic across input order
- bounded M13 machine snapshot included
- complete review action provenance included
- final/unresolved counts included
- deterministic dataset fingerprint
- no raw source or translation chapter text

### Permission boundary

Added capabilities:

- `nqa.review.submit_action` — QA_OPERATE / QA_STATE_WRITE
- `nqa.review.export_curated` — READ / READ_ONLY

Existing `nqa.review.list` and `nqa.review.inspect` remain READ_ONLY.

## Targeted verification

M14 targeted tests plus control-plane tests:

```text
Test Files: 6 passed
Tests:      24 passed
```

Coverage includes:

- propose/confirm
- pending-candidate confirmation
- dispute/resolve
- mismatched confirmation rejection
- mismatched evidence rejection
- stale subject rejection
- tamper detection
- deterministic queue ordering
- deterministic export fingerprint
- immutable file journal
- control-plane permissions
- static isolation

## Safety boundary

M14 production sources are statically checked for absence of:

- Google Docs mutation
- Google Sheets mutation
- permission mutation
- application route/listener registration
- database/Drizzle imports
- raw `sourceText` / `translationText` persistence

The file journal uses create-only writes and exposes no update/delete API.

## Threshold boundary

M14 does not modify M08-M12 threshold policy files.

Human labels are collected for future calibration; thresholds are not tuned in
this milestone.

## Full regression

Final verification after formatting:

```text
Test Files: 57 passed
Tests:      304 passed
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

Pre-stage diff gate:

```text
git diff --check
PASS

NQA threshold policy files changed
NONE
```

The final staged gate additionally verifies the intended file set, secret/debug
scan, no threshold-policy file, and no unrelated `.tmp` artifacts before
commit.

## Next milestone

**M15 — Real-World Threshold Calibration + Promotion Gate**

M15 should consume deterministic M14 curated exports, measure false PASS/FAIL
and REVIEW trade-offs against human-confirmed labels, and define explicit
promotion criteria without mutating production content.
