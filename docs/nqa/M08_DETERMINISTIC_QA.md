# M08 — Deterministic QA

Status: COMPLETE
Date: 2026-09-24
Branch: feat/nqa-foundation

## Objective

M08 adds the first executable QA decision layer after M07 chapter resolution/extraction.

It performs deterministic structural checks only.

M08 does not evaluate semantic translation fidelity.

Pipeline:

```text
M05 Google Intake
  -> M06 Intake Checker
  -> M07 Chapter Resolver + Extractor
  -> M08 Deterministic QA
  -> M09+ Semantic QA
```

A deterministic PASS means:
the chapter pair is structurally acceptable for semantic QA.

It does not mean:
the Thai translation is semantically correct.

## Versioned policy

Default policy version:

`nqa-deterministic-v1`

Conservative defaults:

- min chapter chars for review: 300
- max chapter chars for review: 100000
- translation/source length ratio review range: 0.25 to 4.0
- translation/source paragraph ratio review range: 0.25 to 4.0
- repeated paragraph minimum length: 40 chars
- repeated paragraph review threshold: 3 occurrences
- ending marker requirement: disabled by default
- default foreign-script marker rule: Devanagari U+0900-U+097F

All thresholds/rules are injectable through the policy contract.

Threshold changes must therefore be versioned and testable instead of silently changing QA behavior.

## Resolver gates

M08 consumes the M07 resolver status before content heuristics.

Mapping behavior:

- NOT_FOUND -> FAIL + MISSING_CHAPTER_ID
- REVIEW -> REVIEW + AMBIGUOUS_CHAPTER_MAPPING
- RESOLVED_WITH_VARIANTS -> REVIEW + DUPLICATE_CHAPTER_ID
- INTERNAL_SEQUENCE_DRIFT -> REVIEW

M08 does not create its own alternative chapter mapping.

It relies on M07 as the chapter-identity authority.

This prevents deterministic heuristics from accidentally comparing the wrong source/translation pair.

## Hard FAIL conditions

M08 hard-fails only high-confidence structural corruption/blockers:

- MISSING_CHAPTER_ID
- EMPTY_CHAPTER
- EXACT_DUPLICATE_CHAPTER
- MALFORMED_CONTENT

EXACT_DUPLICATE_CHAPTER means normalized source and translation text are byte-equivalent after the shared NQA normalization.

This is treated as a likely untranslated/source-copy condition.

MALFORMED_CONTENT currently detects:

- forbidden ASCII control characters
- Unicode replacement character U+FFFD

## REVIEW conditions

M08 sends suspicious but non-conclusive structure to REVIEW:

- SUSPICIOUSLY_SHORT_CHAPTER
- SUSPICIOUSLY_LONG_CHAPTER
- LENGTH_RATIO_OUTLIER
- PARAGRAPH_RATIO_OUTLIER
- DUPLICATE_CHAPTER_ID
- AMBIGUOUS_CHAPTER_MAPPING
- INTERNAL_SEQUENCE_DRIFT
- REPEATED_PARAGRAPH
- FOREIGN_TEXT_POLICY_VIOLATION
- MISSING_ENDING_MARKER when explicitly enabled

These checks are intentionally not semantic FAILs.

A large length mismatch, for example, can be suspicious but may still result from valid translation style, notes, formatting, or paragraph merging.

## Repeated paragraph detection

M08:

1. normalizes each paragraph with NFC
2. trims whitespace
3. collapses whitespace
4. ignores paragraphs shorter than the configured minimum
5. counts exact normalized paragraph repeats

Default review threshold:
3 occurrences of the same paragraph with at least 40 characters.

Only counts/metrics are stored in evidence.
Full repeated paragraph text is not copied into evidence summaries.

## Foreign-text marker policy

M08 includes deterministic foreign-script marker support.

Default V1 rule:

- Devanagari U+0900-U+097F

This directly covers the previously observed accidental marker characters:

- U+094B
- U+0939

A hit produces:
`FOREIGN_TEXT_POLICY_VIOLATION`
and REVIEW.

Evidence records only bounded script/code-point information such as:
`Devanagari:U+094B`

It does not copy the surrounding full novel text.

Important:
this marker check is structural/QC-style evidence.
It is not semantic fidelity analysis.

Additional scripts can be added through versioned policy after false-positive calibration.

## Ending marker policy

The accepted translation ending-marker list currently includes:
`จบตอน`

However:

`requireTranslationEndingMarker = false`

by default.

Reason:
existing valid translations may omit or normalize the ending marker.

A deployment may explicitly enable the requirement.

When enabled and absent:

- MISSING_ENDING_MARKER
- REVIEW

It is not a hard semantic failure.

## Metrics

Each deterministic result reports:

- sourceChars
- translationChars
- lengthRatio
- sourceParagraphs
- translationParagraphs
- paragraphRatio
- exactDuplicate
- repeatedParagraph groups/counts
- foreign-text hits
- malformed-source flag
- malformed-translation flag
- ending-marker presence

No overall similarity score is introduced.

## Canonical Chapter 197 calibration

M02 frozen metrics:

English source Chapter 197:

- chars: 11049
- paragraphs: 88

Historical known-bad Thai Chapter 197:

- chars: 10189
- paragraphs: 107
- length ratio: approximately 0.922
- paragraph ratio: approximately 1.216

Corrected Thai Chapter 197:

- chars: 9962
- paragraphs: 86
- length ratio: approximately 0.902
- paragraph ratio: approximately 0.977

Both Thai versions fall comfortably inside the conservative deterministic ratio ranges.

This is intentional and important.

The known-bad historical Chapter 197 is semantically wrong despite looking structurally plausible.

Therefore:
M08 must not manufacture a deterministic FAIL for this incident.

M09+ semantic analysis remains responsible for detecting:

- MEANING_DIVERGENCE
- EVENT_MISMATCH
- WRONG_CHAPTER / SOURCE_DRIFT
- FABRICATION
- semantic omission/addition

## Evidence model

M08 reuses the M02 bounded `QaEvidenceRef` contract.

It may store:

- source range/indexes + hash
- translation range/indexes + hash
- bounded policy summary

It does not store full chapter text in result evidence.

Evidence summaries are bounded to at most 1000 characters by contract.

The tests also assert that unique long chapter text is not reproduced in evidence.

## Reason-code additions

M08 extends the shared NQA reason-code contract with:

- SUSPICIOUSLY_SHORT_CHAPTER
- SUSPICIOUSLY_LONG_CHAPTER
- PARAGRAPH_RATIO_OUTLIER
- EXACT_DUPLICATE_CHAPTER
- REPEATED_PARAGRAPH
- MISSING_ENDING_MARKER
- MALFORMED_CONTENT

Existing codes reused:

- EMPTY_CHAPTER
- LENGTH_RATIO_OUTLIER
- FOREIGN_TEXT_POLICY_VIOLATION
- DUPLICATE_CHAPTER_ID
- AMBIGUOUS_CHAPTER_MAPPING
- INTERNAL_SEQUENCE_DRIFT
- MISSING_CHAPTER_ID

## MCP capability

M08 implements the existing capability:

`nqa.qa.run_deterministic`

Permission:
`QA_OPERATE`

Effect:
`QA_STATE_WRITE`

Therefore the M04 gateway requires an idempotency key before the handler executes.

Repeated completed request:

- returns REUSED
- does not re-read/re-execute the chapter handler

READ-only principals cannot run deterministic QA.

The M08 handler:

1. reads the configured row through M05
2. reads C/K chapter documents through M07
3. resolves the requested chapter through M07
4. extracts only uniquely selected chapter boundaries
5. runs deterministic policy
6. returns metrics + bounded evidence

It does not mutate production Google content.

## Isolation boundary

Production code is contained under:

- server/nqa/deterministic/*
- shared reason-code additions in server/nqa/contracts.ts
- server/nqa/index.ts export

M08 does not modify:

- client/*
- server/routers.ts
- server/workspace/*
- Drizzle schema
- migrations
- package.json
- pnpm-lock.yaml

M08 contains:

- no Google write method
- no network listener
- no embedding model
- no cross-encoder
- no OpenAI/Anthropic/Gemini API
- no semantic-model execution

## M08 / M09 boundary

M08 answers:
`Is this resolved chapter pair structurally safe enough for semantic QA?`

M09 will answer:
`Does this Thai chapter appear to match the expected English source chapter semantically, or does another source chapter match better?`

M08 is complete.
