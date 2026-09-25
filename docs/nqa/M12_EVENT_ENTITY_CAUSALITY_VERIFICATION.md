# M12 — Event / Entity / Causality Verification

Status: COMPLETE
Date: 2026-09-24
Branch: feat/nqa-foundation

## Objective

M12 adds bounded structured semantic verification after the M09-M11 semantic pipeline.

The stage verifies five explicit dimensions:

- EVENT
- ENTITY
- RELATIONSHIP
- CAUSALITY
- CHRONOLOGY

M12 remains READ-ONLY / SHADOW QA.

It does not edit Google Docs, Sheets, publication state, or production translation content.

## Final architecture

The accepted runtime does not ask the small LLM to make one opaque bilingual verdict.

Instead:

```text
bounded English source
    -> local fact extraction
                     \
                      -> deterministic structured comparison
                     /
bounded Thai translation
    -> Thai semantic canonicalization to English
    -> local fact extraction
```

The local Qwen model is used only for:

1. bounded Thai -> semantic-English canonicalization
2. compact fact extraction from one side at a time

The final MATCH / MISMATCH / INSUFFICIENT dimensions are produced by deterministic runtime code.

This replaces the rejected early design where Qwen compared both bilingual sides directly.
## Why the design changed

During live M12 smoke testing, direct pairwise bilingual prompting could ignore the Thai side and emit false strong mismatches for a faithful control.

The runtime therefore moved to separate fact extraction.

A faithful bounded example:

```text
Source:
Sabo entered the room, spoke to Kurama, and asked what had happened.

Thai:
ซาโบเดินเข้ามาในห้อง พูดกับคุรามะ และถามว่าเกิดอะไรขึ้น
```

The Thai canonicalizer produced a semantically equivalent English form and independent fact extraction recovered the same entities/events.

A divergent control involving Devon/laboratory/artificial-fruit content produced unrelated facts.

The deterministic matcher then separated the two cases without lowering thresholds.
## Runtime consistency

The Qwen sidecar now reports:

- structure_engine_version
- runtime_source_sha256

Health and startup output expose the same fingerprint.

Final accepted runtime:

`nqa-structure-runtime-v3`

This allows verification that the process listening on port 8767 is executing the exact source file currently on disk.

The final acceptance smoke verified:

`runtime_source_sha256 == disk SHA-256`

The Qwen HTTP server is serialized with a single-thread HTTPServer so model generation requests cannot execute concurrently inside the process.
## Bounded evidence

Default policy:

```text
maxItems = 4
maxCharsPerSide = 500
lowScoreItemLimit = 2
gapItemLimit = 2
```

Evidence inputs are selected from M10 alignment:

- lowest-score aligned pairs
- source gaps
- translation gaps

Each item includes only bounded text plus:

- hashes
- ranges
- rerank score
- evidence type

Full chapter text is not sent to the structure provider.
## Fact model

Each side can contain:

### Entities

```text
canonicalName
role
```

### Events

```text
eventId
actor
action
object
outcome
order
```

### Relationships

```text
subject
relation
object
```

### Causal links

```text
causeEventId
effectEventId
```

Collections are bounded and schema-validated.

Malformed or empty model output is retried.

If bounded non-empty text still cannot produce reliable facts after retries, the runtime returns an empty side and the comparison becomes INSUFFICIENT rather than manufacturing a mismatch.
## Deterministic comparison

M12 compares extracted facts in code.

Entity matching uses normalized lexical similarity and fuzzy matching.

Event matching compares:

- action
- actor
- object
- outcome

with action receiving the largest weight.

Relationship matching compares subject / relation / object.

Chronology verifies that matched events preserve monotonic order.

Causality compares explicit bounded causal structure only when enough causal facts exist.

Important safety rule:

```text
missing or unreliable fact extraction
    -> INSUFFICIENT
    -> never automatic MISMATCH
```

A strong mismatch therefore requires positive conflicting structured evidence, not merely a model failure.
## Structure policy

Policy version:

`nqa-structure-v1`

Final defaults:

```text
runOnPass = false
minMismatchConfidence = 0.85
minMatchConfidence = 0.75
minAssessedItems = 1
minStrongMatchDimensions = 3
minFailItems = 2
failStrongMismatchCount = 3
failEventPlusSupportingMismatch = true
allowStructuredPassUpgrade = false
```

M12 is therefore a conservative negative-evidence stage.

By default it does not run on an upstream PASS.

It runs for residual REVIEW cases when a structure provider and M10 alignment are available.

A single suspicious bounded pair can produce structured REVIEW evidence, but cannot by itself create a hard M12 FAIL because `minFailItems = 2`.

A structured PASS also cannot upgrade an upstream REVIEW unless explicitly enabled by policy.
## Handler integration

M12 extends the existing semantic capability:

`nqa.qa.run_semantic`

No new production capability is introduced.

Permission remains QA_OPERATE.

Default flow:

```text
M08-M11 final PASS
    -> M12 skipped

M08-M11 final FAIL
    -> M12 skipped

M08-M11 residual REVIEW
    -> bounded M12 structured verification
```

If explicitly configured with `runOnPass=true`, M12 may also probe PASS cases in shadow/calibration runs.

Verdict fusion remains conservative:

- M12 FAIL can demote the current result to FAIL
- M12 REVIEW keeps REVIEW; if run explicitly on PASS it can demote PASS to REVIEW
- M12 PASS does not upgrade REVIEW by default
## UTF-8 transport requirement

A diagnostic PowerShell smoke using Invoke-RestMethod produced empty Thai-side extraction while the same runtime/source fingerprint worked correctly through:

- UTF-8 JSON file + curl --data-binary
- production TypeScript fetch
- direct Python execution

Final acceptance therefore uses explicit UTF-8 transport.

The production TypeScript provider serializes JSON through fetch and is not affected by the PowerShell diagnostic transport issue.

This finding is part of the verification evidence because Thai text transport must not silently degrade into false structured results.

## Closure verification — 2026-09-24

### Runtime provenance

The closure run was asked to re-verify an earlier runtime fingerprint beginning with `39d254...`.

That prefix does not resolve to a Git commit in this worktree, does not occur in the current repository content, and does not appear in the available Git reflog. It is therefore not used as the canonical M12 revision identifier. It is treated as an intermediate live runtime/source fingerprint from the preceding M12 iteration that was superseded by subsequent sidecar changes.

The accepted runtime is:

```text
structure_engine_version = nqa-structure-runtime-v3
runtime_source_sha256 = bdeeb0ad1d0f59027463a801d9f9bff9f315183e303766c9b67509f1efa7344c
```

The SHA-256 independently calculated from `server/nqa/semantic/runtime/qwen_adjudicator_sidecar.py` is exactly the same value as `/health` on port 8767. Runtime and disk source are therefore byte-identical for the closure run.

Git HEAD before the M12 commit remains the M11 commit:

`addcaeb4da5a5783c2fd0d256b40838beb7ba1a7`

### Canonical Chapter 197 closure smoke

Input snapshot remains outside Git:

`C:\AI-Workspace\runtimes\nqa-bge-m3\smoke\canonical-197.jsonl`

Current corrected Chapter 197:

```text
M10 alignment = PASS
selected rerank score = 0.9648551345
M12 decision = REVIEW / INSUFFICIENT_EVIDENCE
strongMismatchCount = 0
strongMismatchItemCount = 0
EVENT = INSUFFICIENT
ENTITY = INSUFFICIENT
RELATIONSHIP = INSUFFICIENT
CAUSALITY = INSUFFICIENT
CHRONOLOGY = INSUFFICIENT
```

The corrected control therefore produces no false structured mismatch and no false FAIL.

Historical revision 69:

```text
M10 alignment = FAIL
selected rerank score = 0.0197569169
M12 decision = REVIEW
reasonCodes = EVENT_MISMATCH, ENTITY_MISMATCH
strongMismatchCount = 2
strongMismatchItemCount = 1
EVENT = MISMATCH 0.95
ENTITY = MISMATCH 0.95
RELATIONSHIP = INSUFFICIENT
CAUSALITY = INSUFFICIENT
CHRONOLOGY = INSUFFICIENT
```

The M12 stage intentionally stays REVIEW for this one bounded item because `minFailItems = 2`; it still emits strong structured negative evidence while the upstream M10 alignment already classifies the historical control as FAIL.

The canonical smoke was repeated and preserved the same conclusions.

### Regression and safety gates

Closure gates:

```text
M12 targeted regression: 6 test files / 39 tests PASS
Full server/nqa regression: 47 test files / 275 tests PASS
tsc --noEmit: PASS
python -m py_compile qwen_adjudicator_sidecar.py: PASS
git diff --check: PASS
structure isolation tests: PASS
credential-pattern scan: no real credential material found
```

No M12 threshold was reduced during closure. The policy remains `nqa-structure-v1` with `minMismatchConfidence = 0.85`, `minMatchConfidence = 0.75`, `minFailItems = 2`, and `failStrongMismatchCount = 3`.

Unrelated `.tmp/nqa-fullqa/*` artifacts present in the shared worktree are explicitly outside the M12 commit scope and must not be staged.
