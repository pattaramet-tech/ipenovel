# M07 — Verification Report

Status: COMPLETE
Date: 2026-09-24
Branch: feat/nqa-foundation

## Checkpoint

Pre-M07 commit:
`b61a680c2c5c80f0ae4103430eaf02014d48a88a`

Before M07 implementation:

- local HEAD was verified
- M06 was pushed to origin/feat/nqa-foundation
- remote SHA matched local M06

M07 remains unmerged from main.

## Live read-only evidence

The prepared English source was re-read through connected Google tooling.

Observed:

- source document ID: 1wXZBYJ9Eu586XajNw4R-Q768quKzHsJsIlK-KuWTB0Q
- revision token unchanged from M02
- source tab: t.0
- heading: บท 197: 196. Search and Rescue
- heading: บท 198: 197. Possessing
- Chapter 197 start index: 181957

Current historical Thai document was also re-read.

Observed:

- revision token corresponds to current corrected state
- tab t.t7mcm92c2amf content begins with บทที่ 196 ค้นหาและช่วยเหลือ
- tab t.bf525hytchcg content begins with บทที่ 197 การสิงร่าง(แปลใหม่)
- tab t.ex2hwmuwtf9y content begins with บทที่ 198 มือใหม่
- current tab 197 index = 16

These reads were read-only.

## Targeted M07 tests

Coverage verifies:

- source heading parser separates internal sequence and source chapter
- Thai heading parser
- canonical source Chapter 197 range
- corrected-candidate classification
- tab position is evidence only
- explicit historical variant override
- source/translation extraction
- deterministic chapter SHA-256
- canonical internal 198 -> chapter 197 resolution
- internal sequence drift forces REVIEW
- duplicate translation variants
- no unique production original => REVIEW
- missing source
- missing translation
- duplicate source chapter ambiguity
- Google Docs tab/body parser
- legacy body fallback
- missing credential fail closed
- bounded retry after 429
- 403 not retried and response body not leaked
- authenticated MCP resolve
- authenticated MCP extraction
- no extraction on ambiguous mapping
- READ-only capabilities require no idempotency
- static isolation/read-only constraints

Final targeted result:

- 6 test files passed
- 28 tests passed
- 0 failures

## Full NQA regression

Final full-suite result after Google-reader hardening:

- 22 test files passed
- 123 tests passed
- 0 failures
- TypeScript no-emit check passed
- git diff --check passed
- staged scope contains only server/nqa/* and docs/nqa/*
- secret scan returned no matches
- production chapter source scan returned no router/workspace/database/client/mutation/listener matches
- Google chapter reader uses GET only
- no client/router/workspace/Drizzle/migration/package files changed
- canonical Chapter 197 fixture files were unchanged

This includes all M02-M06 tests.

## Production safety

M07 does not:

- update Google Sheets
- update Google Docs
- publish/delete/move content
- change Drive permissions
- register a production network listener
- modify shared IpeNovel router/UI/database layers
- expose REMEDIATION
- expose PRODUCTION_MUTATION

Chapter Google transport uses GET only.

No package dependency was added.

Canonical Chapter 197 fixture files remain unchanged.

## Resolver policy verification

Canonical source mapping:

- internal sequence 198
- source chapter 197
- source title Possessing

Translation identity is parsed from content heading rather than tab index.

Duplicate translation policy preserves all variants.

Internal-sequence disagreement does not silently remap the chapter; it emits INTERNAL_SEQUENCE_DRIFT and REVIEW.

Extraction is withheld when mapping is missing or ambiguous.

## Deferred work

Deferred to M08 and later:

- deterministic QA policy
- length/paragraph ratio thresholds
- duplicate/repeated paragraph detection
- foreign-text marker policy
- semantic embeddings
- wrong-source global search
- cross-encoder alignment
- persistent chapter manifest/cache
- persistent result/evidence stores
- admin UI/shared router integration
- remediation/write-back

## Acceptance result

M07 satisfies the isolated Chapter Resolver + Extractor milestone.

Next recommended milestone:
**M08 — Deterministic QA**
