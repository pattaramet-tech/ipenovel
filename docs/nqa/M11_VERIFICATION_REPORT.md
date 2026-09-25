# M11 — Verification Report

Status: COMPLETE — CORE + LOCAL SMALL-LLM RUNTIME
Date: 2026-09-24
Branch: feat/nqa-foundation

## Checkpoint

Pre-M11 commit:

`a23ea3bfb7c8a5e145494afa15a8d479e56acb79`

Before M11 implementation:

- M10 was committed
- M10 was pushed to origin/feat/nqa-foundation
- remote SHA was verified to match a23ea3b

M11 remains unmerged from main.

## Jev contract verification

Current Jev documentation was verified during M11.

Confirmed:

- POST /v1/systemone
- Bearer authorization
- state + model + questions request shape
- Choice criteria map
- Score ordered criteria array
- Noul yes-probability output
- typed answers keyed by question ID
- application code owns thresholds/final actions

M11 implements:

- Choice route
- Noul evidence sufficiency
- Score semantic risk

Provider accepts approved HTTPS System One endpoints only.

Environment:

`JEV_API_KEY_PRESENT = false`

Therefore:

- no live Jev request was sent
- no secret was created or committed
- Jev behavior is covered by mocked HTTP contract tests
- live Jev calibration is deferred until an API key is explicitly provisioned

## Local Qwen provisioning

Model:

`Qwen/Qwen3-1.7B`

Pinned revision:

`70d244cc86ccca08cf5af4e1e306ecf908b1ad5e`

Runtime cache:

`C:\AI-Workspace\runtimes\nqa-qwen3-1.7b\hf-cache`

Cache index:

- one accepted Qwen revision
- approximately 4.1 GB indexed model content
- physical runtime footprint approximately 3.8 GiB

Hugging Face cache warnings observed by `hf cache ls --show-warnings` refer to helper files and Xet metadata:

- .agent_harnesses.json
- update-check marker files
- xet metadata directory

The model itself loads offline successfully and produces live inference.

## Local adjudicator health

Final sidecar:

```text
endpoint = http://127.0.0.1:8767/adjudicate
model = Qwen/Qwen3-1.7B
revision = 70d244cc86ccca08cf5af4e1e306ecf908b1ad5e
device = cuda
dtype = torch.float16
max input tokens = 8192
max new tokens = 256
load time ≈ 6.001 s
torch = 2.9.1+cu130
CUDA = 13.0
GPU = NVIDIA GeForce RTX 5070
```

## Three-model residency

All NQA local semantic models were resident concurrently:

```text
8765  BAAI/bge-m3
8766  BAAI/bge-reranker-v2-m3
8767  Qwen/Qwen3-1.7B
```

Observed GPU state:

```text
NVIDIA GeForce RTX 5070
memory used ≈ 9501 MiB
memory free ≈ 2444 MiB
```

No CPU fallback was observed.

This validates that the current 12 GB GPU can run M09A + M10 + M11 resident together under the tested configuration.

## Bounded synthetic live smoke

Live result path:

`C:\AI-Workspace\runtimes\nqa-qwen3-1.7b\m11-synthetic-smoke.json`

SHA-256:

`317a02379f8d34ddfeb32fcf72fdd183353acc9e689ad8fedb78581e62317ccc`

Result file remains outside Git.

### Faithful synthetic bounded pair

Local Qwen:

```text
decision = PASS
confidence = 1.0
reason codes = []
elapsed ≈ 3952.5 ms
```

Application:

```text
decision = PASS
route = LOCAL_LLM
```

### Divergent synthetic bounded pair

Local Qwen:

```text
decision = FAIL
confidence = 0.50
reason codes:
  MEANING_DIVERGENCE
  ENTITY_MISMATCH
  CONTRADICTION
elapsed ≈ 5978 ms
```

Application:

```text
decision = REVIEW
route = HUMAN_REVIEW
HUMAN_REVIEW_REQUIRED
```

This confirms the confidence gate works in live inference.

The application did not lower its 0.85 threshold to force an automated FAIL.

## Canonical Chapter 197

Canonical M10 outcomes remain:

```text
current corrected Chapter 197 = PASS
historical revision 69 = FAIL
```

M11 policy intentionally skips adjudication for both because upstream decisions are already final.

Tests verify no Jev/small-LLM call occurs for upstream PASS or FAIL.

This prevents the probabilistic adjudicator from weakening stronger upstream evidence.

## Evidence privacy/bounding

Tests verify:

- max bounded snippet length
- max snippet count
- Jev state contains no sourceText
- Jev state contains no translationText
- Jev receives metrics/hash signals only
- local LLM receives only bounded snippet evidence
- result evidence remains bounded
- malformed or unknown local-model reason codes are rejected

No full novel chapter is sent to Jev or returned in adjudication result evidence.

## Targeted verification

M11 targeted core/runtime/handler suite:

```text
7 test files
40 tests
40 passed
0 failed
```

Coverage includes:

- upstream PASS/FAIL skip
- Jev human-review route
- Jev accept-machine route with final authority disabled
- local high-confidence PASS
- local high-confidence FAIL
- low-confidence human fallback
- local model error fallback
- Jev endpoint whitelist
- typed Choice/Noul/Score request
- typed answer parsing
- no response-body leak on errors
- local sidecar loopback enforcement
- local response schema
- unknown reason-code rejection
- evidence snippet bounding
- Jev state text removal
- runtime model pin
- offline startup
- handler integration

## Final full regression

Final runtime/repository gate:

```text
Python Qwen sidecar py_compile
PASS

PowerShell adjudicator scripts parse
PASS

pip check
No broken requirements found.

Full NQA regression
42 test files / 245 tests PASS
0 failed

pnpm check / tsc --noEmit
PASS

git diff --check
PASS
```

This includes all M02-M10 regression tests.

## Production safety

M11 does not:

- mutate Google Sheets
- mutate Google Docs
- change Drive permissions
- publish/delete/move novel content
- register application production listeners
- modify shared IpeNovel UI/router/database layers
- call paid general-purpose LLM APIs
- expose REMEDIATION
- expose PRODUCTION_MUTATION

External boundary:

- only approved Jev System One endpoint
- text-free state only
- no live call without explicit server-side API key

Local generative boundary:

- loopback only
- pinned model revision
- offline normal startup
- bounded request
- bounded generation
- typed response validation
- fail closed to human review

## Files

Core adjudication:

- server/nqa/semantic/adjudication/contracts.ts
- server/nqa/semantic/adjudication/policy.ts
- server/nqa/semantic/adjudication/evidence.ts
- server/nqa/semantic/adjudication/jev.ts
- server/nqa/semantic/adjudication/smallLlm.ts
- server/nqa/semantic/adjudication/engine.ts
- server/nqa/semantic/adjudication/index.ts

Tests:

- server/nqa/semantic/adjudication/engine.test.ts
- server/nqa/semantic/adjudication/evidence.test.ts
- server/nqa/semantic/adjudication/jev.test.ts
- server/nqa/semantic/adjudication/smallLlm.test.ts
- server/nqa/semantic/adjudication/isolation.static.test.ts

Runtime:

- server/nqa/semantic/runtime/qwen_adjudicator_sidecar.py
- server/nqa/semantic/runtime/provision-adjudicator.ps1
- server/nqa/semantic/runtime/start-adjudicator.ps1
- server/nqa/semantic/runtime/m11-smoke.ts
- server/nqa/semantic/runtime/m11-runtime.static.test.ts

Integration:

- server/nqa/semantic/contracts.ts
- server/nqa/semantic/handlers.ts
- server/nqa/semantic/handlers.test.ts
- server/nqa/semantic/index.ts

Docs:

- docs/nqa/M11_JEV_SMALL_LLM_ADJUDICATION.md
- docs/nqa/M11_VERIFICATION_REPORT.md

## Acceptance

M11 is accepted at the code and local-runtime level.

Known limitation:

`JEV_API_KEY` is not provisioned, so Jev production API behavior has not been live-smoke-tested.

This does not block the local M11 adjudication path.

Until a Jev key is explicitly provisioned:

- Jev provider remains optional
- local small LLM can adjudicate REVIEW evidence
- failures/low confidence still fail closed to human review

Next planned milestone:

**M12 — Event / Entity / Causality Verification**
