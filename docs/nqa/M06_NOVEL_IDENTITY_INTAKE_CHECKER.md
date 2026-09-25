# M06 — Novel Identity + Intake Checker

Status: COMPLETE
Date: 2026-09-24
Branch: feat/nqa-foundation

## Objective

M06 converts M05 read-only row snapshots into stable NQA novel/bundle identities and a deterministic intake decision:

- INTAKE_PASS
- INTAKE_REVIEW
- INTAKE_FAIL

M06 remains read-only with respect to production Google content.

It does not write identity decisions back to Sheets or Docs.

## Identity model

NQA keeps three identity levels separate:

```text
Novel
  ↓
Bundle
  ↓
Chapter
```

M06 implements Novel + Bundle identity.

Chapter identity remains the responsibility of M07.

A Sheet row is a mutable locator and is never the primary novel or bundle identity.

## Stable novel identity

For a genuinely new structured title, M06 derives:

`novel_<16 hex>`

from the normalized canonical story title.

Normalization reuses the M02 rules:

- Unicode NFC
- trim surrounding whitespace
- collapse whitespace
- normalize spacing around colon punctuation
- locale-aware lowercasing

The chapter-range suffix is removed before novel identity is created.

Therefore bundles such as:

```text
เรื่องเดียวกัน 001 - 030
เรื่องเดียวกัน 031 - 080
เรื่องเดียวกัน 081 - 130
```

produce the same structured candidate novel ID.

Once a novel is in the injected catalog, its existing novel ID is authoritative and may be resolved through exact title, alias, or known document identity.

## Stable bundle identity

Bundle ID remains the M02 deterministic form:

`bundle_<novel token>_<rangeStart>_<rangeEnd>`

The ID does not contain:

- row number
- Sheet position
- current tab position

This allows a known logical bundle to move to another row without becoming a new bundle.

The bundle record still carries its current locator as metadata.

## Resolution precedence

M06 resolver evaluates identity using the following safety order:

1. known exact document identity
2. exact normalized canonical title
3. exact normalized alias
4. fuzzy candidate search
5. structured-new identity

Document/title conflicts are not silently resolved.

If exact evidence points to more than one known novel, the result is AMBIGUOUS and requires review.

Fuzzy matching never grants exact authority.

## Fuzzy policy

M06 uses deterministic normalized character-bigram Dice similarity.

Default threshold:
`0.86`

Default returned candidate limit:
`5`

A fuzzy match produces:

```text
status = REVIEW
kind = FUZZY_REVIEW
novel = null
```

The existing novel ID is shown only as a candidate.

M06 never:

- auto-merges a fuzzy match
- rewrites an alias
- changes a document mapping
- silently replaces a novel ID

Human/catalog confirmation is required before a fuzzy candidate can become authoritative.

## Catalog contract

The injected identity catalog contains:

Novel entries:

- novel identity
- canonical title
- aliases
- known translation document IDs
- known source document IDs

Bundle entries:

- deterministic bundle identity
- current/known document IDs
- historical locator metadata

M06 itself does not persist this catalog to a database.
Persistent catalog storage is deferred until shared DB integration is safe.

## Intake decision policy

### INTAKE_FAIL

Hard blockers:

- Source Contract parse failure
- C and K resolve to the same Google Doc
- translation document is unreadable
- prepared source document is unreadable

A FAIL means semantic QA must not proceed.

Provider access failures such as the current Row 1562 translation 403 therefore block intake rather than being mistaken for translation-quality failure.

### INTAKE_REVIEW

Review conditions:

- ambiguous identity evidence
- fuzzy identity candidate
- duplicate logical bundle
- overlapping bundle ranges for one novel
- known bundle document drift
- document reused across different bundles

REVIEW does not mutate identity.

### INTAKE_PASS

PASS requires:

- valid Source Contract
- readable C document
- readable K document
- C and K are distinct
- identity is exact/alias/known-document or a clean structured-new candidate
- no duplicate, overlap, drift, or document-reuse conflict

## Row drift behavior

If a known bundle moves from one Sheet row to another while:

- novel ID is unchanged
- range is unchanged
- C document is unchanged
- K document is unchanged

M06 returns INTAKE_PASS.

The bundle ID remains unchanged.

If the same logical bundle keeps its novel/range but C or K changes, M06 returns:

`BUNDLE_DOCUMENT_DRIFT`

and requires review.

This preserves the M02 rule that row number is a locator rather than regression identity.

## Current canonical Row 1562

The live M05 evidence showed:

- contract/range can be parsed
- K source document is readable
- current C translation document returns HTTP 403 PERMISSION_DENIED

M06 policy therefore classifies that live-shaped state as:

```text
INTAKE_FAIL
TRANSLATION_DOC_UNREADABLE
```

This is an operational intake block, not a semantic judgment about the translation.

## Batch integrity checks

`checkRows()` performs cross-row checks within one bounded batch.

It detects:

- same novel + same range more than once
- same novel with overlapping ranges
- one C/K document reused across different bundles
- different documents claiming one deterministic bundle ID

The checker adds reason codes to every affected row.

Hard FAIL remains higher precedence than REVIEW.

## MCP capability

M06 implements the existing M03 capability:

`nqa.novel.resolve_identity`

It remains:

- READ permission
- READ_ONLY effect
- no idempotency key required

The handler reads one bounded row through the M05 adapter and returns either:

- IDENTITY_RESOLVED
- IDENTITY_REVIEW
- CONTRACT_INVALID

There is no identity write-back capability.

## Files

Production:

- server/nqa/identity/contracts.ts
- server/nqa/identity/resolver.ts
- server/nqa/identity/checker.ts
- server/nqa/identity/handlers.ts
- server/nqa/identity/index.ts
- server/nqa/index.ts

Tests:

- server/nqa/identity/resolver.test.ts
- server/nqa/identity/checker.test.ts
- server/nqa/identity/handlers.test.ts
- server/nqa/identity/isolation.static.test.ts

## Isolation boundary

M06 does not modify:

- client/*
- server/routers.ts
- server/workspace/*
- Drizzle schema
- migrations
- package.json
- pnpm-lock.yaml

M06 contains no Google mutation method and no production network listener.

## M06 / M07 boundary

M06 owns:

- novel identity
- bundle identity
- fuzzy candidate review
- duplicate/overlap/document-drift intake checks
- final intake PASS / REVIEW / FAIL

M07 will own:

- source chapter boundary parsing
- internal sequence vs source chapter mapping
- translation tab/chapter mapping
- duplicate chapter variants
- chapter extraction
- chapter-level resolver confidence

M06 is complete.
