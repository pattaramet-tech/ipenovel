# M06 — Verification Report

Status: COMPLETE
Date: 2026-09-24
Branch: feat/nqa-foundation

## Checkpoint

Pre-M06 commit:
`5dbfd3354c91e185a5c0a27529963bb2a90e2533`

Before M06 implementation:

- local HEAD was verified
- M05 was pushed to origin/feat/nqa-foundation
- remote SHA was verified to match local M05

M06 remains unmerged from main.

## Automated coverage

Resolver tests verify:

- same canonical title across ranges gets the same structured novel ID
- exact canonical-title resolution
- exact alias resolution
- known document identity precedence
- conflicting document identities require review
- fuzzy candidate requires review and is not auto-merged
- unrelated title becomes structured-new
- deterministic character-bigram Dice similarity

Checker tests verify:

- clean new bundle => INTAKE_PASS
- malformed contract => INTAKE_FAIL
- unreadable C => INTAKE_FAIL
- unreadable K => INTAKE_FAIL
- C/K same document => INTAKE_FAIL
- fuzzy identity => INTAKE_REVIEW
- duplicate logical bundle => INTAKE_REVIEW
- overlapping range => INTAKE_REVIEW
- document reuse => INTAKE_REVIEW
- known bundle survives row drift
- known bundle document drift => INTAKE_REVIEW
- live-shaped Row 1562 C-permission failure => INTAKE_FAIL

## Gateway and isolation coverage

MCP handler tests verify:

- nqa.novel.resolve_identity runs through authenticated READ gateway
- structured-new result returns IDENTITY_RESOLVED
- fuzzy candidate returns IDENTITY_REVIEW
- READ-only identity resolution requires no idempotency key

Static isolation tests reject:

- shared router imports
- workspace imports
- Drizzle/database imports
- client imports
- mutating HTTP methods
- batchUpdate mutation surfaces
- production listener/route registration
- automatic fuzzy merge behavior

M02-M05 tests remain in the same full NQA regression suite.

## Verification commands

Executed from:

`C:\AI-Workspace\ipenovel\.worktrees\nqa-foundation`

Commands during implementation:

```text
corepack pnpm exec prettier --write server/nqa/identity server/nqa/index.ts
corepack pnpm exec vitest run server/nqa/identity
corepack pnpm check

corepack pnpm exec vitest run server/nqa
corepack pnpm check
```

Final verification result:

- 16 test files passed
- 95 tests passed
- 0 failures
- TypeScript no-emit check passed
- git diff --check passed
- staged scope contains only server/nqa/* and docs/nqa/*
- secret scan returned no matches
- production identity source scan returned no router/workspace/database/client/mutation/listener matches
- fuzzy auto-merge scan returned no matches
- no client/router/workspace/Drizzle/migration/package files changed
- canonical Chapter 197 fixture files were unchanged

## Production safety

M06 does not:

- modify Google Sheets
- modify Google Docs
- change Drive permissions
- publish translation content
- merge fuzzy identities automatically
- persist identity changes into a production database
- register production HTTP/MCP routes
- expose REMEDIATION
- expose PRODUCTION_MUTATION

No package dependency was added.

The canonical Chapter 197 fixture files remain unchanged.

## Policy result for current Row 1562 evidence

M05 live evidence established:

- Source Contract syntax is valid
- prepared English K document is readable
- current C translation document is not readable by the connected Google reader

M06 therefore treats the current live-shaped state as:

- INTAKE_FAIL
- TRANSLATION_DOC_UNREADABLE

This result means the QA pipeline is blocked on access.
It does not classify translation fidelity.

## Deferred work

Deferred to M07 and later:

- chapter boundary parser
- source internal-sequence mapping
- translation tab/chapter resolver
- duplicate chapter variants
- chapter extraction
- chapter-level evidence ranges
- persistent identity catalog/database
- human-review UI
- shared router integration
- production scheduler
- remediation/write-back

## Acceptance result

M06 satisfies the isolated Novel Identity + Intake Checker milestone.

Next recommended milestone:
**M07 — Chapter Resolver + Extractor**
