# M11 — Jev + Small-LLM Adjudication

Status: COMPLETE — CORE + LOCAL SMALL-LLM RUNTIME
Date: 2026-09-24
Branch: feat/nqa-foundation

## Objective

M11 adds a bounded adjudication layer after M08–M10.

Pipeline:

```text
M08 Deterministic QA
  -> M09 Whole-Chapter Semantic Retrieval
  -> M10 Cross-Encoder + Monotonic Alignment
  -> M11 Jev Routing + Local Small-LLM Adjudication
```

M11 is invoked only when upstream machine evidence remains REVIEW.

Upstream PASS or FAIL is final for this stage and does not trigger Jev or the local LLM.

M11 remains READ-ONLY / SHADOW QA.
It cannot edit source documents, translations, Sheets, publication state, or production records.

## Authority model

M11 intentionally separates three authorities.

### Machine QA

M08–M10 produce deterministic and model-backed evidence.

They remain the primary evidence source.

### Jev

Jev is a decision/routing model.

M11 uses it only for bounded triage:

- accept_machine
- escalate_local_llm
- human_review

By default:

`allowJevFinalDecision = false`

Therefore Jev cannot directly turn REVIEW into PASS or FAIL.

### Local small LLM

The local LLM can adjudicate bounded semantic snippets when machine evidence remains REVIEW.

A local LLM verdict is accepted only when:

- decision is PASS or FAIL
- confidence reaches the application threshold
- the decision type is allowed by policy

Otherwise:

- REVIEW
- HUMAN_REVIEW_REQUIRED

Application code owns all thresholds and final routing.

## Jev contract

Provider:

`JevHttpDecisionProvider`

Current official Jev API contract was re-verified before M11 finalization.

Request:

- POST /v1/systemone
- Bearer API key
- state
- model
- typed questions

Question types used by M11:

- Choice for route
- Noul for evidence sufficiency
- Score for semantic risk

Jev receives a text-free NQA state.

It does not receive source or translation snippet text.

State includes only:

- upstream decision
- upstream reason codes
- global search metrics
- alignment metrics
- snippet kinds
- rerank scores
- source/translation hashes

Approved endpoints:

- api.typesafe.ai
- thejevai.com

Both must use HTTPS and the exact /v1/systemone path.

No Jev API call was executed during M11 because JEV_API_KEY is not configured on Makelleley.

The provider contract is verified by mocked typed-response tests.

## Bounded evidence pack

Evidence contract:

`nqa-adjudication-evidence-v1`

Default limits:

- maxSnippets = 8
- maxSnippetCharsPerSide = 700
- lowScoreSnippetLimit = 4
- gapSnippetLimit = 4

Snippet types:

- ALIGNED_PAIR
- SOURCE_GAP
- TRANSLATION_GAP

Each snippet may contain:

- bounded English source text
- bounded Thai translation text
- hashes
- ranges
- rerank score

The evidence pack never includes the complete chapter by design.

Low-score aligned pairs are prioritized first.

Gap evidence is included afterward within the global snippet cap.

## Local small-LLM runtime

Model:

`Qwen/Qwen3-1.7B`

Pinned revision:

`70d244cc86ccca08cf5af4e1e306ecf908b1ad5e`

Endpoint:

`http://127.0.0.1:8767/adjudicate`

Runtime:

- local CUDA
- float16
- loopback only
- Hugging Face offline normal startup after pre-cache
- deterministic generation: do_sample=false
- max input tokens: 8192
- max new tokens: 256
- bounded JSON response schema

Allowed model decisions:

- PASS
- REVIEW
- FAIL

Allowed reason codes are constrained to the existing NQA reason-code vocabulary.

Unknown reason codes, invalid confidence, malformed JSON, unbounded rationale, HTTP errors, or model failures fail closed to REVIEW / HUMAN_REVIEW_REQUIRED.

## Local LLM policy

Policy version:

`nqa-adjudication-v1`

Default:

- localLlmFinalConfidenceThreshold = 0.85
- allowLocalLlmPass = true
- allowLocalLlmFail = true
- allowJevFinalDecision = false
- jevRouteConfidenceThreshold = 0.90
- jevEvidenceSufficientThreshold = 0.90

The Qwen confidence field is model-reported and is not assumed to be statistically calibrated.

The threshold is therefore a safety gate, not a probability guarantee.

Low-confidence PASS or FAIL stays REVIEW and requires human review.

## Local live smoke

M11 includes a bounded synthetic smoke that exercises the real local Qwen sidecar through the production TypeScript adjudication core.

### Faithful bounded pair

Source:
a short English event involving Sabo and Kurama.

Translation:
a bounded Thai sentence representing the same event.

Result:

```text
local decision = PASS
local confidence = 1.0
final decision = PASS
route = LOCAL_LLM
elapsed ≈ 3.95 s
```

### Divergent bounded pair

Source:
the same short Sabo/Kurama source event.

Translation:
a bounded unrelated Devon/laboratory/artificial-fruit event.

Qwen result:

```text
local decision = FAIL
reason codes:
  MEANING_DIVERGENCE
  ENTITY_MISMATCH
  CONTRADICTION
local confidence = 0.50
```

Application result:

```text
final decision = REVIEW
route = HUMAN_REVIEW
HUMAN_REVIEW_REQUIRED
elapsed ≈ 5.98 s
```

M11 intentionally did not lower the 0.85 threshold to force this divergent case into FAIL.

The low-confidence local verdict remained human-review evidence.

## Canonical Chapter 197 behavior

M10 already produced decisive canonical results:

- corrected current Chapter 197 -> PASS
- historical bad revision 69 -> FAIL

M11 therefore does not call Jev or Qwen for those two canonical controls.

This is intentional.

The adjudicator exists for residual REVIEW cases, not to re-litigate upstream decisive evidence.

Unit tests explicitly verify that upstream PASS/FAIL skips all adjudication providers.

## MCP integration

M11 extends the existing capability:

`nqa.qa.run_semantic`

No new production capability is introduced.

Permission remains:

`QA_OPERATE`

Effect remains:

`QA_STATE_WRITE`

Existing idempotency behavior remains unchanged.

Execution behavior:

```text
pre-adjudication PASS/FAIL
  -> return immediately

pre-adjudication REVIEW
  -> build bounded evidence
  -> optional Jev route
  -> optional local LLM
  -> PASS / FAIL / REVIEW-HUMAN
```

## Runtime footprint

All three local models were resident simultaneously on RTX 5070 12 GB:

- BAAI/bge-m3
- BAAI/bge-reranker-v2-m3
- Qwen/Qwen3-1.7B

Observed:

```text
GPU memory used ≈ 9501 MiB
GPU memory free ≈ 2444 MiB
```

Qwen sidecar health:

```text
device = cuda
dtype = float16
max input = 8192
max new tokens = 256
load time ≈ 6.0 s
```

The Qwen cache contains only pinned revision:

`70d244cc86ccca08cf5af4e1e306ecf908b1ad5e`

Hugging Face cache-index helper/Xet metadata warnings are non-model entries and do not prevent offline model load or live inference.

## Safety boundary

M11 does not:

- send novel text to Jev
- send full chapters to the local LLM
- call OpenAI, Anthropic, Gemini, Cohere, or another paid generative endpoint
- mutate Google Sheets or Docs
- publish/delete/move novel content
- change Drive permissions
- modify shared IpeNovel UI/router/database layers
- expose remediation or production mutation

Jev is the only allowed external decision endpoint in the M11 core.

It receives only text-free machine state.

The local small LLM is loopback-only.

## M11 / M12 boundary

M11 adjudicates residual uncertainty from existing semantic evidence.

M12 will introduce dedicated structured verification for:

- events
- entities
- relationships
- causality
- chronology

Those signals should be extracted and compared explicitly rather than asking the small LLM to infer every dimension from generic snippets.

M11 is complete at the code/runtime level.
Jev live-provider verification remains blocked only by the absence of JEV_API_KEY.
