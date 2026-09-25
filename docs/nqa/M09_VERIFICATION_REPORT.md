# M09 — Verification Report

Status: COMPLETE — CORE + LOCAL RUNTIME ADAPTER
Date: 2026-09-24
Branch: feat/nqa-foundation

## Checkpoint

Pre-M09 commit:
`364cf76450a2888fe87f8deb6877529671665792`

Before M09 implementation:

- local HEAD was verified
- M08 was pushed to origin/feat/nqa-foundation
- remote SHA was verified to match local M08

M09 remains unmerged from main.

## Runtime discovery

The machine was checked before selecting the runtime path.

Observed:

- Python executable not available on PATH
- Python package discovery could not run
- Ollama command unavailable
- no existing @xenova/transformers package
- no existing @huggingface/transformers package
- no existing ONNX/transformer embedding runtime found in package.json/pnpm-lock.yaml
- Node.js v24.19.0 available

No machine-level runtime was installed automatically.

M09 therefore ships a loopback-only embedding-provider adapter and validates semantic ranking with deterministic fixture vectors.

No live BGE-M3 similarity score is claimed.

## External model verification

Current official FlagEmbedding documentation was checked during M09.

It confirms BGE-M3 supports:

- multilingual retrieval
- dense embeddings
- long input up to 8192 tokens
- dense/sparse/multi-vector modes

M09 uses only the generic dense-provider boundary.

The model runtime itself is not vendored or downloaded into the repository.

## Targeted M09 coverage

Embedding tests verify:

- cosine similarity
- invalid vector rejection
- non-loopback endpoint rejection
- localhost POST protocol
- vector shape validation
- mixed dimension rejection
- provider error body is not leaked

Global-search tests verify:

- heading/boilerplate normalization
- expected chapter top-1 + sufficient lead => PASS
- close top-1 => REVIEW/LOW_CONFIDENCE
- strong nearby alternate => FAIL/WRONG_CHAPTER
- strong distant alternate => FAIL/WRONG_CHAPTER + SOURCE_DRIFT
- expected chapter absent => REVIEW/INSUFFICIENT_EVIDENCE
- empty candidate corpus avoids provider call
- bounded candidate evidence
- invalid provider vector count fails closed
- full translation text is excluded from evidence

## Gateway/orchestration coverage

Handler tests verify:

- QA_STATE_WRITE requires idempotency key
- missing key prevents document/model execution
- deterministic PASS + expected semantic top-1 => PASS
- strong distant wrong-source => FAIL
- deterministic hard FAIL skips embedding provider
- completed semantic request is REUSED
- reused request does not rerun embedding provider
- READ-only principal is denied
- invalid Source Contract prevents document/model reads

Static isolation tests verify:

- no shared router/workspace/database/client imports
- no Google mutation/listener surface
- no OpenAI endpoint
- no Anthropic endpoint
- no Gemini endpoint
- no Cohere endpoint
- local embedding adapter contains loopback enforcement
- full source/translation text is not directly assigned to evidence summaries

Final targeted result:

- 4 test files passed
- 28 tests passed
- 0 failures
- TypeScript no-emit check passed

## Full NQA regression

Final full-suite result after M09 implementation:

- 29 test files passed
- 177 tests passed
- 0 failures
- TypeScript no-emit check passed
- git diff --check passed
- staged scope contains only server/nqa/* and docs/nqa/*
- secret scan returned no matches
- production semantic source scan returned no router/workspace/database/client/mutation/listener matches
- no external paid-model endpoints were found
- the only POST surface is the loopback-guarded local embedding adapter
- no client/router/workspace/Drizzle/migration/package files changed
- canonical Chapter 197 fixture files were unchanged

This includes all M02-M08 regression tests.

## Policy behavior verified

PASS requires:

- expected source rank within configured pass rank
- expected similarity threshold
- expected lead over alternate threshold

REVIEW occurs for:

- close/uncertain ranking
- missing/empty evidence

FAIL requires:

- alternate source wins
- alternate similarity threshold
- alternate margin threshold

Distant strong alternate additionally emits:

- SOURCE_DRIFT

M09 stage decisions remain shadow QA evidence.
Thresholds are not declared calibrated.

## Production safety

M09 does not:

- modify Google Sheets
- modify Google Docs
- change Drive permissions
- publish/delete/move content
- register production HTTP/MCP routes
- modify shared IpeNovel router/UI/database layers
- call paid LLM APIs
- install machine-level Python/Ollama/runtime packages
- expose REMEDIATION
- expose PRODUCTION_MUTATION

No package dependency was added.

Canonical Chapter 197 fixture files remain unchanged.

## Live semantic limitation

The real BGE-M3 runtime is not currently provisioned on Makelleley.

Therefore this milestone has not executed:

- a real BGE-M3 embedding batch
- a live Chapter 197 global ranking
- a measured expected rank/similarity
- a measured alternate source chapter
- GPU/CPU latency benchmark

These are environmental/runtime validation tasks, not silently substituted with fixture vectors.

The fixture provider validates orchestration, vector ranking, thresholds, evidence, and safety behavior only.

## Deferred work

Environment/runtime prerequisite:

- provision approved local embedding runtime
- serve BAAI/bge-m3 through loopback provider protocol
- run a live shadow smoke on canonical Chapter 197
- record latency/device/model metadata

Deferred to M10 and later:

- semantic chunking
- cross-encoder reranking
- monotonic alignment
- source/translation coverage
- omission/addition gaps
- event/entity/causality analysis
- persistent embedding cache
- persistent evidence/result store
- admin UI/shared router integration
- remediation/write-back

## Acceptance result

M09 semantic core, global wrong-source ranking, MCP orchestration, and secure local embedding adapter satisfy the code-level milestone.

The only unexecuted acceptance item is a live BGE-M3 runtime smoke because no compatible local model runtime is currently installed.

Next recommended engineering milestone after runtime smoke:
**M10 — Cross-Encoder + Monotonic Alignment**
