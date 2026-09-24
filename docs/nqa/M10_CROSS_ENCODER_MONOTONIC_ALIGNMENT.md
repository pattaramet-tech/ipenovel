# M10 — Cross-Encoder + Monotonic Alignment

Status: COMPLETE
Date: 2026-09-24
Branch: feat/nqa-foundation

## Objective

M10 adds local chunk-level semantic verification after M09 whole-chapter retrieval.

Pipeline:

```text
M07 Chapter Resolver + Extractor
  -> M08 Deterministic QA
  -> M09 Whole-Chapter BGE-M3 Global Search
  -> M10 Chunking
  -> Dense Top-K Chunk Retrieval
  -> bge-reranker-v2-m3 Cross-Encoder
  -> Monotonic Dynamic-Programming Alignment
  -> Coverage / Gap Policy
```

M10 remains READ-ONLY / SHADOW QA.
It never edits Google Docs, Sheets, publication state, or production translation content.

## Why M10 exists

M09A proved that the historical bad Chapter 197 still ranked the expected source chapter first at whole-chapter level.

Historical revision 69:

- expected chapter rank: 1
- expected similarity: approximately 0.711915
- expected lead over alternate: approximately 0.011415
- M09 decision: REVIEW / LOW_CONFIDENCE

The defect is therefore not a clean whole-chapter substitution.

M10 looks inside the expected chapter and measures whether local translated spans can be placed into a coherent forward-moving alignment against source spans.

## Chunking

Default policy:

- targetChunkChars = 1200
- maxChunkChars = 1800
- paragraph-preserving where possible
- heading removed
- known boilerplate removed
- oversized individual paragraphs split deterministically
- no overlap in V1

Every chunk keeps:

- chunk index
- paragraph range
- document index range
- char count
- SHA-256
- text only during model execution

Returned alignment results use text-free chunk references.

## Dense candidate retrieval

For each translation chunk:

1. embed all translation/source chunks with the existing local BGE-M3 provider
2. calculate cosine similarity
3. retain top K source chunks

Default:

`denseTopK = 4`

This bounds expensive cross-encoder work while preserving alternate local candidates.

Maximum reranker pairs in V1:

`maxRerankPairs = 160`

## Cross-encoder

Model:

`BAAI/bge-reranker-v2-m3`

Pinned revision:

`953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e`

Runtime:

- local CUDA
- float16
- loopback-only HTTP sidecar
- offline normal startup after model pre-cache
- sequence-classification logits normalized with sigmoid into [0,1]

Endpoint:

`http://127.0.0.1:8766/rerank`

No external paid model endpoint is used.

## Monotonic alignment

After reranking, M10 selects a strictly increasing path:

```text
translation chunk index increases
AND
source chunk index increases
```

The dynamic-programming objective maximizes cumulative reranker score.

This prevents high-scoring but chronologically crossing matches from producing a valid alignment.

The resulting path yields:

- aligned pair count
- source coverage
- translation coverage
- mean reranker score
- minimum reranker score
- low-score fraction
- source gap fraction
- translation gap fraction

Unmatched source chunks become omission evidence.

Unmatched translation chunks become addition/fabrication-risk evidence.

## Policy

Policy version:

`nqa-alignment-v1`

Current shadow defaults:

- minPassMeanScore = 0.70
- minPassTranslationCoverage = 0.85
- minPassSourceCoverage = 0.80
- lowScoreThreshold = 0.45
- maxLowScoreFractionPass = 0.30
- minReviewMeanScore = 0.45
- minReviewTranslationCoverage = 0.60
- minReviewSourceCoverage = 0.55
- majorGapFraction = 0.30

The low-score PASS fraction was calibrated from the canonical corrected Chapter 197 control.

The corrected control had two low-score chunks out of eight aligned chunks (25%) while retaining high coverage and mean score. The initial 20% limit therefore produced REVIEW. V1 uses 30%.

No FAIL threshold was weakened during this calibration.

## Decisions

PASS requires all of:

- mean rerank score reaches pass threshold
- translation coverage reaches pass threshold
- source coverage reaches pass threshold
- low-score fraction is within pass guard

FAIL is emitted when major alignment evidence is strong enough, including:

- major source gap / low source coverage -> OMISSION_MAJOR
- major translation gap / low translation coverage -> ADDITION_MAJOR + FABRICATION_SUSPECTED
- mean rerank score below review floor -> MEANING_DIVERGENCE

Otherwise:

- REVIEW + ALIGNMENT_UNCERTAIN

M10 never emits FABRICATION_DEFINITE.

## MCP integration

Existing capability remains:

`nqa.qa.run_semantic`

Permission remains:

`QA_OPERATE`

M10 is backward-compatible:

- no reranker injected -> M09 behavior
- reranker injected -> M09 + M10 alignment

Overall precedence:

`FAIL > REVIEW > PASS`

Completed idempotent requests remain reusable through the existing gateway.

## Canonical Chapter 197 live result

Input evidence uses the same external canonical snapshot as M09A.

Snapshot SHA-256:

`2e554d9d47da61c272d8214149213c24faf07454f1a64819d8459f048da1fc59`

### Current corrected translation

Final calibrated M10 result:

```text
decision = PASS
source chunks = 9
translation chunks = 8
aligned pairs = 8
source coverage = 0.959909
translation coverage = 1.000000
mean rerank score = 0.730175
minimum rerank score = 0.174692
low-score fraction = 0.25
source gap fraction = 0.040091
translation gap fraction = 0
```

The only source gap is the final 441-character source chunk.

### Historical bad revision 69

Final M10 result:

```text
decision = FAIL
reason codes:
  OMISSION_MAJOR
  ADDITION_MAJOR
  FABRICATION_SUSPECTED
  MEANING_DIVERGENCE

source chunks = 9
translation chunks = 8
aligned pairs = 2
source coverage = 0.238727
translation coverage = 0.238330
mean rerank score = 0.247126
minimum rerank score = 0.019757
low-score fraction = 0.50
source gap fraction = 0.761273
translation gap fraction = 0.761670
```

This converts the M09 REVIEW into strong local alignment failure without manufacturing a wrong-chapter claim.

## Runtime performance

Both local models run concurrently on the RTX 5070.

Observed while both sidecars were resident:

- GPU memory used: approximately 5.9 GiB
- GPU memory free: approximately 6.1 GiB
- BGE-M3 sidecar port: 8765
- reranker sidecar port: 8766

Warm calibrated M10 smoke:

- corrected case: approximately 0.61 s
- historical case: approximately 0.51 s

These are canonical smoke measurements, not throughput guarantees.

## Evidence safety

M10 result/evidence stores:

- hashes
- ranges
- chunk indexes
- numeric scores
- bounded summaries

It does not return full chunk text in alignment results.

Canonical snapshot, model caches, and smoke-result files remain outside Git.

## M10 / M11 boundary

M10 detects structural semantic divergence at chunk alignment level.

M11 remains responsible for uncertain adjudication using:

- Jev
- small local LLM
- bounded evidence only

M11 must not replace deterministic/reranker evidence; it consumes it when policy remains uncertain.
