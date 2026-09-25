# M07 — Chapter Resolver + Extractor

Status: COMPLETE
Date: 2026-09-24
Branch: feat/nqa-foundation

## Objective

M07 resolves chapter identity independently from Sheet row, Google Docs tab position, and active/deep-linked tab.

It adds:

- source chapter heading parser
- translation chapter heading parser
- source/translation chapter boundaries
- internal-sequence vs source-chapter distinction
- duplicate translation variants
- deterministic extraction with SHA-256
- read-only Google Docs body reader
- MCP handlers for chapter resolve/extract

M07 remains read-only with respect to production content.

## Canonical identity rule

Source headings use:

`บท <internal sequence>: <source chapter>. <source title>`

Example revalidated from the live English source:

`บท 198: 197. Possessing`

Therefore:

- internal sequence = 198
- source chapter = 197
- source title = Possessing

These are stored as separate fields.

The resolver never assumes:
`internal sequence == source chapter`

An expected internal-sequence mismatch produces:
`INTERNAL_SEQUENCE_DRIFT`
and forces REVIEW rather than silently remapping the chapter.

## Translation identity rule

Translation headings use content text such as:

`บทที่ 197 การสิงร่าง(แปลใหม่)`

The current historical Thai document was re-read during M07.

Observed current tabs:

- tab t.t7mcm92c2amf: content heading บทที่ 196 ค้นหาและช่วยเหลือ
- tab t.bf525hytchcg: content heading บทที่ 197 การสิงร่าง(แปลใหม่)
- tab t.ex2hwmuwtf9y: content heading บทที่ 198 มือใหม่

Current tab 197 index:
16

The chapter remains 197 because the content heading says 197.
The tab index is retained only as evidence.

Active/deep-linked tab and tab position are never chapter identity.

## Source boundaries

Source boundaries are created from source heading paragraphs.

For each source chapter:

- start paragraph = parsed source heading
- end paragraph = paragraph immediately before the next parsed source heading
- startIndex = heading start index
- endIndex = last paragraph end index

Canonical source Chapter 197 live evidence:

- source document: 1wXZBYJ9Eu586XajNw4R-Q768quKzHsJsIlK-KuWTB0Q
- tab: t.0
- internal sequence: 198
- source chapter: 197
- title: Possessing
- start index: 181957
- end index: 193006

This matches the M02 canonical range.

## Translation boundaries and variants

Translation boundaries are parsed from content headings inside each tab.

Default variant classification:

- heading/tab contains แปลใหม่ / แก้ไข / corrected / retranslated => corrected_candidate
- heading/tab contains ร่าง / draft => draft
- otherwise => production_original

Callers may explicitly override a tab as:

- historical_revision
- production_original
- corrected_candidate
- draft

This permits historical revision fixtures to preserve provenance without changing chapter identity.

## Duplicate chapters

Multiple translation tabs may claim the same chapter.

M07 never silently replaces one with another.

Rules:

- one candidate => RESOLVED
- multiple candidates with exactly one production_original =>
  RESOLVED_WITH_VARIANTS, select production original and expose every variant
- multiple candidates without one unique production_original =>
  REVIEW + DUPLICATE_CHAPTER_ID + TRANSLATION_CHAPTER_AMBIGUOUS

A corrected candidate therefore cannot silently overwrite the logical production mapping in resolver policy.

## Missing and ambiguous mappings

Reason codes:

- SOURCE_CHAPTER_MISSING
- SOURCE_CHAPTER_AMBIGUOUS
- TRANSLATION_CHAPTER_MISSING
- TRANSLATION_CHAPTER_AMBIGUOUS
- DUPLICATE_CHAPTER_ID
- INTERNAL_SEQUENCE_DRIFT

Resolver statuses:

- RESOLVED
- RESOLVED_WITH_VARIANTS
- REVIEW
- NOT_FOUND

Semantic QA must not treat REVIEW/NOT_FOUND as a clean chapter pair.

## Extraction

Extraction occurs only from a resolved boundary.

Output includes:

- document ID
- revision ID
- tab ID
- chapter
- source internal sequence when applicable
- title
- translation variant when applicable
- paragraph count
- start/end indexes
- exact chapter text
- normalized SHA-256

The extractor uses the existing NQA_FIXTURE_V1 normalization/hash behavior.

## Google Docs chapter reader

M05 reads metadata only.

M07 adds a separate chapter reader because chapter resolution requires document body text.

The reader:

- uses Google Docs API GET only
- uses includeTabsContent=true
- preserves tab IDs and paragraph indexes
- supports tabbed Docs
- supports legacy body fallback
- uses the existing documents.readonly OAuth requirement
- accepts injected access-token provider
- never stores credentials in source

Retry policy:

- retry HTTP 429
- retry HTTP 5xx
- retry transport failure
- bounded attempts
- exponential delay hook
- do not retry 401/403/404
- provider response body is not leaked in safe errors

No mutation endpoint exists.

## MCP capabilities

M07 implements the existing READ capabilities:

- nqa.chapter.resolve
- nqa.chapter.extract

Required target:

- row
- chapter

Flow:

```text
authenticated READ gateway
  -> M05 bounded row read
  -> C/K document IDs
  -> M07 read-only document snapshots
  -> chapter resolver
  -> optional extractor
```

If Source Contract is invalid, handler returns CONTRACT_INVALID.

If resolver has no unique source/translation mapping, chapter.extract returns extraction = null rather than forcing a pair.

Both capabilities remain READ_ONLY and require no idempotency key.

## Canonical Chapter 197 behavior

Regression coverage locks:

Source:

- internal sequence 198
- chapter 197
- title Possessing

Translation current corrected candidate:

- tab t.bf525hytchcg
- chapter 197
- heading การสิงร่าง(แปลใหม่)
- variant corrected_candidate

Synthetic duplicate regressions prove:

- production_original + corrected_candidate keeps both variants
- exactly one production original may be selected while duplicate reason is retained
- multiple corrected candidates without unique production original require REVIEW

Historical revision 69 can be explicitly tagged historical_revision without changing chapter number.

## Files

Production:

- server/nqa/chapter/contracts.ts
- server/nqa/chapter/parser.ts
- server/nqa/chapter/resolver.ts
- server/nqa/chapter/extractor.ts
- server/nqa/chapter/googleReader.ts
- server/nqa/chapter/handlers.ts
- server/nqa/chapter/index.ts
- server/nqa/index.ts

Tests:

- server/nqa/chapter/parser.test.ts
- server/nqa/chapter/resolver.test.ts
- server/nqa/chapter/extractor.test.ts
- server/nqa/chapter/googleReader.test.ts
- server/nqa/chapter/handlers.test.ts
- server/nqa/chapter/isolation.static.test.ts

## Isolation boundary

M07 does not modify:

- client/*
- server/routers.ts
- server/workspace/*
- Drizzle schema
- migrations
- package.json
- pnpm-lock.yaml

It contains no Google mutation method and no production network listener.

## Next boundary

M08 will consume resolved/extracted chapter pairs for Deterministic QA:

- structural checks
- length/paragraph ratios
- duplicate/repeated content
- foreign-text policy markers
- resolver hard gates
- immutable evidence/reason codes

M07 is complete.
