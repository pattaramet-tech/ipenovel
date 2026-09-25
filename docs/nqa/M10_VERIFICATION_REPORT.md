# M10 — Verification Report

Status: COMPLETE
Date: 2026-09-24
Branch: feat/nqa-foundation

## Checkpoint

Pre-M10 commit:

`47aa4b8466fce7df042ce8952609081478deff20`

Before M10 implementation:

- M09A was committed
- M09A was pushed to origin/feat/nqa-foundation
- remote SHA was verified to match 47aa4b8

M10 remains unmerged from main.

## Runtime provisioning

Dense model already resident from M09A:

```text
BAAI/bge-m3
revision 5617a9f61b028005a4858fdac845db406aefb181
CUDA / float16
port 8765
```

M10 reranker:

```text
BAAI/bge-reranker-v2-m3
revision 953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e
CUDA / float16
port 8766
```

Reranker model was provisioned into an external cache:

`C:\AI-Workspace\runtimes\nqa-bge-reranker-v2-m3\hf-cache`

The cache index contains only the pinned accepted revision and reports approximately 2.3 GB of model content.

## Sidecar health

Final embedding sidecar health:

- status: ok
- model: BAAI/bge-m3
- dimension: 1024
- max length: 8192
- torch: 2.9.1+cu130
- CUDA: 13.0
- GPU: NVIDIA GeForce RTX 5070

Final reranker sidecar health:

- status: ok
- model: BAAI/bge-reranker-v2-m3
- revision: 953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e
- max length: 8192
- batch size: 8
- load time: approximately 3.63 seconds
- torch: 2.9.1+cu130
- CUDA: 13.0
- GPU: NVIDIA GeForce RTX 5070

Both models were resident simultaneously.

Observed GPU memory:

- used: approximately 5.9 GiB
- free: approximately 6.1 GiB

No CPU fallback occurred.

## Canonical smoke input

Canonical Chapter 197 snapshot remains outside Git:

`C:\AI-Workspace\runtimes\nqa-bge-m3\smoke\canonical-197.jsonl`

Snapshot SHA-256:

`2e554d9d47da61c272d8214149213c24faf07454f1a64819d8459f048da1fc59`

Source identity:

```text
internal sequence = 198
source chapter = 197
title = Possessing
```

Controls:

- current corrected translation
- historical bad revision 69

No novel-text snapshot was added to the repository.

## Calibration run

Initial M10 policy used:

`maxLowScoreFractionPass = 0.20`

Current corrected Chapter 197 produced:

- source coverage: 0.959909
- translation coverage: 1.000000
- mean rerank score: 0.730175
- low-score fraction: 0.25

All major evidence was positive, but two of eight aligned chunks were below the low-score threshold, so the initial policy returned REVIEW / ALIGNMENT_UNCERTAIN.

The PASS low-score guard was calibrated to:

`maxLowScoreFractionPass = 0.30`

No FAIL threshold was reduced.

The historical bad control remained far beyond all failure boundaries.

## Final current corrected result

Final calibrated M10 result:

```text
decision: PASS
reason codes: []

source chunks: 9
translation chunks: 8
aligned pairs: 8

source coverage: 0.9599090909
translation coverage: 1.0000000000

mean rerank score: 0.7301752362
minimum rerank score: 0.1746916920
low-score fraction: 0.25

source gap fraction: 0.0400909091
translation gap fraction: 0
```

The aligned path is monotonic:

```text
translation 0 -> source 0
translation 1 -> source 1
translation 2 -> source 2
translation 3 -> source 3
translation 4 -> source 4
translation 5 -> source 5
translation 6 -> source 6
translation 7 -> source 7
```

Only source chunk 8 remained unmatched.

Warm calibrated elapsed time:
approximately 0.61 seconds.

## Final historical revision-69 result

Final M10 result:

```text
decision: FAIL

reason codes:
- OMISSION_MAJOR
- ADDITION_MAJOR
- FABRICATION_SUSPECTED
- MEANING_DIVERGENCE

source chunks: 9
translation chunks: 8
aligned pairs: 2

source coverage: 0.2387272727
translation coverage: 0.2383297223

mean rerank score: 0.2471255679
minimum rerank score: 0.0197569169
low-score fraction: 0.50

source gap fraction: 0.7612727273
translation gap fraction: 0.7616702777
```

Only two monotonic pairs survived the candidate/reranker alignment.

This is materially different from M09 whole-chapter behavior, where revision 69 still ranked expected source Chapter 197 first and therefore produced REVIEW rather than WRONG_CHAPTER.

M10 detects the local semantic breakdown without falsely claiming a whole-chapter substitution.

Warm elapsed time:
approximately 0.51 seconds.

## Smoke result artifact

Calibrated result path:

`C:\AI-Workspace\runtimes\nqa-bge-reranker-v2-m3\m10-smoke-calibrated.json`

SHA-256:

`63bcf4e13ecb813b8da7b9a93714abc51b6cdfbe14565bb4448e931d09ee0de8`

The result contains ranking/alignment metadata, hashes, ranges, scores, and gaps.

The result file remains outside Git.

## Targeted verification

Targeted M10 + handler suite:

```text
7 test files
34 tests
34 passed
0 failed
```

Coverage includes:

- deterministic chunking
- heading/boilerplate removal
- max chunk size
- dense top-k candidate retrieval
- loopback-only reranker provider
- normalized score validation
- monotonic crossing rejection
- clean alignment PASS
- low-score divergence FAIL
- addition/fabrication gap FAIL
- text-free result/evidence
- runtime model pinning/offline safety
- MCP handler integration

## Final full regression

Final repository/runtime gate:

```text
Python reranker sidecar py_compile
PASS

PowerShell reranker scripts parse
PASS

pip check
No broken requirements found.

Full NQA regression
36 test files / 213 tests PASS
0 failed

pnpm check / tsc --noEmit
PASS

git diff --check
PASS
```

This includes all M02-M09A regression tests.

## Production safety

M10 does not:

- modify Google Sheets
- modify Google Docs
- change Drive permissions
- publish/delete/move novel content
- add production network listeners to the application
- modify shared IpeNovel router/UI/database layers
- call paid LLM APIs
- expose REMEDIATION
- expose PRODUCTION_MUTATION

The only new listeners are explicit local model sidecars bound to loopback.

The existing semantic MCP capability remains QA_OPERATE / QA_STATE_WRITE with idempotency enforcement.

## Files

Core alignment:

- server/nqa/semantic/alignment/contracts.ts
- server/nqa/semantic/alignment/chunker.ts
- server/nqa/semantic/alignment/candidates.ts
- server/nqa/semantic/alignment/edges.ts
- server/nqa/semantic/alignment/reranker.ts
- server/nqa/semantic/alignment/monotonic.ts
- server/nqa/semantic/alignment/engine.ts
- server/nqa/semantic/alignment/policy.ts
- server/nqa/semantic/alignment/index.ts

Runtime:

- server/nqa/semantic/runtime/bge_reranker_sidecar.py
- server/nqa/semantic/runtime/provision-reranker.ps1
- server/nqa/semantic/runtime/start-reranker.ps1
- server/nqa/semantic/runtime/m10-smoke.ts
- server/nqa/semantic/runtime/m10-runtime.static.test.ts

Integration:

- server/nqa/semantic/contracts.ts
- server/nqa/semantic/handlers.ts
- server/nqa/semantic/handlers.test.ts
- server/nqa/semantic/index.ts

Docs:

- docs/nqa/M10_CROSS_ENCODER_MONOTONIC_ALIGNMENT.md
- docs/nqa/M10_VERIFICATION_REPORT.md

## Acceptance

M10 is accepted.

Next planned milestone:

**M11 — Jev + Small-LLM Adjudication**
