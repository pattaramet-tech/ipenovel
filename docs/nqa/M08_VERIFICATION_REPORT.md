# M08 — Verification Report

Status: COMPLETE
Date: 2026-09-24
Branch: feat/nqa-foundation

## Checkpoint

Pre-M08 commit:
`ff2d24a128aef89f2378981af8d4fe7380c34e0e`

Before M08 implementation:

- local HEAD was verified
- M07 was pushed to origin/feat/nqa-foundation
- remote SHA was verified to match local M07

M08 remains unmerged from main.

## Targeted M08 coverage

Deterministic engine tests verify:

- structurally plausible pair => PASS
- structurally plausible unrelated content does not become semantic FAIL
- resolver NOT_FOUND => FAIL
- resolver ambiguity => REVIEW
- duplicate variants => REVIEW
- empty chapter => FAIL
- suspicious short => REVIEW
- configured suspicious long => REVIEW
- length ratio outlier => REVIEW
- paragraph ratio outlier => REVIEW
- exact source copy => FAIL
- repeated paragraph => REVIEW
- Devanagari U+094B/U+0939 => REVIEW
- malformed replacement/control content => FAIL
- ending marker can be required by policy
- ending marker remains optional by default
- evidence is bounded and excludes full chapter text
  Gateway/handler tests verify:
- QA_STATE_WRITE requires idempotency key
- missing key blocks handler execution
- QA_OPERATE + valid key executes deterministic QA
- completed identical request is REUSED
- reused request does not re-read chapter documents
- invalid Source Contract returns bounded contract error result
- ambiguous chapter mapping returns deterministic REVIEW
- READ-only principal is denied deterministic QA

Static isolation tests verify:

- no shared router/workspace/database/client imports
- no production mutation method
- no production network listener
- no embedding/cross-encoder/LLM API execution
- full chapter text is not assigned directly into evidence summaries

Final targeted result:

- 3 test files passed
- 26 tests passed
- 0 failures
- TypeScript no-emit check passed

## Full NQA regression

Final full-suite result after M08 implementation:

- 25 test files passed
- 149 tests passed
- 0 failures
- TypeScript no-emit check passed
- git diff --check passed
- staged scope contains only server/nqa/* and docs/nqa/*
- secret scan returned no matches
- production deterministic source scan returned no router/workspace/database/client/mutation/listener matches
- semantic-model surface scan returned no matches
- no client/router/workspace/Drizzle/migration/package files changed
- canonical Chapter 197 fixture files were unchanged

This includes all M02-M07 regression tests.

## Canonical calibration

Frozen M02 canonical dimensions demonstrate why M08 must remain structural.

Source Chapter 197:

- 11049 chars
- 88 paragraphs

Historical known-bad Thai 197:

- 10189 chars
- 107 paragraphs
- length ratio ≈ 0.922
- paragraph ratio ≈ 1.216

Corrected Thai 197:

- 9962 chars
- 86 paragraphs
- length ratio ≈ 0.902
- paragraph ratio ≈ 0.977

Both are within default M08 ratio policy.

Therefore the historical semantic failure is expected to remain structurally plausible and proceed to semantic QA unless another deterministic marker is present.

This is correct behavior, not a false negative in M08's declared scope.

## Production safety

M08 does not:

- modify Google Sheets
- modify Google Docs
- publish/delete/move novel content
- change Drive permissions
- register production HTTP/MCP routes
- modify shared IpeNovel router/UI/database layers
- call semantic models
- expose REMEDIATION
- expose PRODUCTION_MUTATION

No package dependency was added.

The canonical Chapter 197 fixture files remain unchanged.

## Policy safety

Default hard FAIL reasons are intentionally narrow:

- missing chapter mapping
- empty chapter body
- exact source/translation duplicate
- malformed control/replacement content

Potentially noisy heuristics are REVIEW only:

- short/long
- length ratio
- paragraph ratio
- repeated paragraph
- foreign-script marker
- optional ending marker
- duplicate/ambiguous resolver conditions

This reduces the risk that deterministic heuristics incorrectly declare semantic translation failure.

## Deferred work

Deferred to M09 and later:

- multilingual embeddings
- global expected-vs-alternate source search
- wrong-source candidate ranking
- semantic meaning comparison
- semantic coverage
- cross-encoder reranking
- monotonic alignment
- entity/event/causality verification
- persistent evidence/result store
- human review UI
- shared router integration
- remediation/write-back

## Acceptance result

M08 satisfies the isolated Deterministic QA milestone.

Next recommended milestone:
**M09 — Semantic Embedding + Global Wrong-Source Search**
