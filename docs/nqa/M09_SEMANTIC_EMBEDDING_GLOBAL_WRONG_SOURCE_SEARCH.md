# M09 — Semantic Embedding + Global Wrong-Source Search

Status: COMPLETE — CORE + LOCAL RUNTIME ADAPTER
Date: 2026-09-24
Branch: feat/nqa-foundation

## Objective

M09 adds the first semantic retrieval layer after M08 deterministic QA.

It answers a bounded question:

`Does the Thai chapter match the expected English source chapter better than the other source chapters in the same bundle?`

Pipeline:

```text
M05 Intake
  -> M06 Identity
  -> M07 Resolver + Extractor
  -> M08 Deterministic QA
  -> M09 Global Semantic Source Search
  -> M10 Cross-Encoder + Monotonic Alignment
```

M09 is not the final translation-fidelity judge.

A M09 PASS means the expected source chapter is the strongest sufficiently separated chapter-level embedding match under the current shadow policy.

## Embedding runtime boundary

Production semantic core depends on the interface:

`NqaEmbeddingProvider`

Contract:

- providerId
- modelVersion
- embed(texts[]) -> numeric vectors

The semantic ranking engine is independent of Python, Ollama, Transformers.js, or any specific deployment runtime.

M09 includes:

`LocalHttpEmbeddingProvider`

The adapter accepts only loopback hosts:

- 127.0.0.1
- localhost
- ::1

Protocol:

```json
{
  "model": "BAAI/bge-m3",
  "texts": ["...", "..."]
}
```

Response:

```json
{
  "vectors": [
    [0.1, 0.2],
    [0.3, 0.4]
  ]
}
```

The adapter validates:

- local host
- HTTP/HTTPS protocol
- response JSON shape
- vector count
- non-empty vectors
- finite numeric values
- consistent dimensions
- bounded request timeout

Provider response bodies are not surfaced in HTTP failure errors.

## Target local model

The planned local model remains:

`BAAI/bge-m3`

Its official FlagEmbedding documentation describes it as multilingual and supporting dense retrieval over long inputs up to 8192 tokens.

M09 uses only the dense-vector provider abstraction.

Sparse retrieval, multi-vector retrieval, and cross-encoder reranking are not required by the M09 core.

The core intentionally does not hardcode:

- model vector dimension
- Python package
- GPU device
- precision
- batching implementation

Those remain runtime concerns.

## Current machine runtime status

Pre-M09 runtime discovery found:

- Python command: unavailable on PATH
- FlagEmbedding: unavailable because Python runtime is absent
- sentence-transformers: unavailable because Python runtime is absent
- Ollama: not installed / not on PATH
- existing Node transformer/ONNX embedding package: none found

Therefore no real BGE-M3 process was started in M09.

Tests use an explicitly named fixture embedding provider only to validate ranking/policy behavior.

Fixture vectors are not presented as real semantic measurements.

## Semantic normalization

Before embedding, M09 reuses NQA text normalization and removes non-semantic routing/boilerplate:

- chapter heading line
- ความคิดเห็น
- โหวต
- จบตอน

The remaining chapter body is embedded.

Original M07 extraction remains unchanged and retains:

- document ID
- revision
- tab ID
- indexes
- full extracted text
- SHA-256

M09 evidence stores only ranking metadata/hashes and bounded summaries.

## Global candidate search

For one Thai chapter:

1. M07 resolves/extracts the selected translation chapter.
2. M09 enumerates every parsed source chapter inside the bundle range.
3. Translation body + all source bodies are embedded in one provider batch.
4. Cosine similarity is calculated locally in the NQA core.
5. All source chapters are ranked.
6. Expected source rank and alternate margins are evaluated.

Search is global within the configured bundle, not only expected ±1 chapter.

Returned evidence candidates are bounded by `maxCandidates`, while ranking is calculated over the full eligible bundle candidate set.

## Ranking evidence

M09 records:

- expectedChapter
- expectedRank
- expectedSimilarity
- bestCandidate
- bestAlternate
- expectedLeadOverAlternate
- marginOverExpected
- top bounded candidate list
- providerId
- modelVersion
- policyVersion

Source candidate evidence contains:

- source chapter
- internal sequence
- source title
- source tab ID
- source extraction SHA-256
- cosine similarity

Full source/translation text is not copied into semantic evidence.

## Shadow policy

Policy version:

`nqa-semantic-global-v1`

Initial uncalibrated shadow defaults:

- minExpectedSimilarityPass = 0.60
- minExpectedLeadPass = 0.02
- minWrongSourceSimilarityFail = 0.72
- minWrongSourceMarginFail = 0.08
- maxExpectedRankPass = 1
- nearbyChapterDistance = 2
- maxCandidates = 10

These values are provisional engineering defaults.

M15 calibration must tune/validate them against real labeled embeddings before any production interpretation.

## PASS policy

M09 stage PASS requires:

- expected chapter exists in candidate set
- expected chapter ranks within maxExpectedRankPass
- expected similarity reaches minExpectedSimilarityPass
- expected chapter leads best alternate by at least minExpectedLeadPass

A close top-1 result does not PASS.

It becomes:

`REVIEW + LOW_CONFIDENCE`

This prevents tiny embedding differences from being treated as strong evidence.

## FAIL policy

M09 stage FAIL requires:

- best candidate is not expected chapter
- best similarity reaches minWrongSourceSimilarityFail
- best candidate beats expected by minWrongSourceMarginFail

Reason:

`WRONG_CHAPTER`

If the best alternative is farther than nearbyChapterDistance:

`SOURCE_DRIFT`

is added.

This is QA-only shadow evidence and does not modify translation content.

## REVIEW policy

M09 returns REVIEW when:

- expected candidate is missing
- evidence is empty
- expected is top-ranked but similarity/lead is insufficient
- alternate outranks expected but not strongly enough for FAIL

Reason codes:

- INSUFFICIENT_EVIDENCE
- LOW_CONFIDENCE

M09 does not force a semantic verdict from weak ranking evidence.

## M08 gate

`nqa.qa.run_semantic` runs M08 deterministic QA first.

If M08 hard FAILs:

- M09 embedding provider is not called
- globalSearch = null
- the deterministic FAIL is returned

If a translation extraction does not exist:

- embedding provider is not called

This prevents model cost/work on invalid chapter pairs.

## MCP capability

Capability:

`nqa.qa.run_semantic`

Permission:
`QA_OPERATE`

Effect:
`QA_STATE_WRITE`

M04 gateway therefore requires an idempotency key.

Completed duplicate requests:

- return REUSED
- do not re-read documents
- do not rerun embeddings

READ-only principals are denied.

The capability remains QA-state-only.
It does not mutate production Sheets/Docs.

## Security boundary

M09 production source contains:

- no OpenAI endpoint
- no Anthropic endpoint
- no Gemini endpoint
- no Cohere endpoint
- no production network listener
- no shared router/UI/DB integration
- no Google mutation operation

The only model transport is an injected provider; the shipped HTTP provider enforces loopback.

## Canonical Chapter 197 role

M09 is designed to address the failure that M08 cannot detect:

Historical bad Thai 197 has normal-looking:

- length ratio
- paragraph ratio
- valid heading
- readable prose

M09 should eventually embed the Thai historical Chapter 197 against every English source chapter in bundle 181-230.

The expected source is:

- internal sequence 198
- source chapter 197
- title Possessing

The future live BGE-M3 smoke/calibration must measure:

- expected rank
- expected similarity
- best alternate chapter
- margin over expected

M09 does not fabricate those values while the local model runtime is absent.

Synthetic fixture vectors validate the algorithmic wrong-source path only.

## Files

Production:

- server/nqa/semantic/contracts.ts
- server/nqa/semantic/embedding.ts
- server/nqa/semantic/policy.ts
- server/nqa/semantic/search.ts
- server/nqa/semantic/handlers.ts
- server/nqa/semantic/index.ts
- server/nqa/index.ts

Tests:

- server/nqa/semantic/embedding.test.ts
- server/nqa/semantic/search.test.ts
- server/nqa/semantic/handlers.test.ts
- server/nqa/semantic/isolation.static.test.ts

## Isolation boundary

M09 does not modify:

- client/*
- server/routers.ts
- server/workspace/*
- Drizzle schema
- migrations
- package.json
- pnpm-lock.yaml

No package dependency is added.

## M09 / M10 boundary

M09 performs chapter-level dense retrieval/ranking.

M10 will take top-k candidates/chunks and add:

- cross-encoder reranking
- semantic chunking
- monotonic alignment
- source/translation coverage
- omission/addition gap evidence

M09 core and runtime adapter are complete.
Real local BGE-M3 runtime provisioning/smoke verification remains an environment prerequisite for live semantic scores.
