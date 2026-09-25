# NQA Novel ID Auto-Link Verification Report

## Scope

Novel ID Auto-Link + Google Sheet Column A Backfill Gate.

## Implemented

- deterministic exact-title catalog matching
- read-only preview artifact
- explicit human-confirmed Column A backfill
- stale-preview and last-moment row guards
- no-overwrite behavior
- narrow Google A-cell writer
- post-write verification
- append-only audit provenance
- Workspace Sync-ready canonical handoff
- MCP capabilities and handlers

## Matching verification

Coverage includes unique match, no match, ambiguous match, duplicate candidate-ID dedupe, already-linked A, invalid A, and exact spreadsheet/title/tab scope.

No fuzzy/LLM matching participates in mutation eligibility.

## Human confirmation verification

Coverage verifies the authenticated MCP principal becomes authorizer, request ID becomes authorization ID, preview fingerprint is required, selected novelId must equal the unique candidate, stale previews fail closed, a last-moment A/B change fails closed, and changed catalog identity fails closed.

## Google mutation isolation

Coverage verifies A:B read context, A-only write destination, one numeric cell in the write body, no Sheets batchUpdate, no Docs mutation, and no Drive permission mutation.

## Audit and Workspace handoff

Coverage verifies durable append-only audit replay, authorizer/authorization provenance, deterministic committed event fingerprint, numeric novelId handoff, `canonicalIdentity = novel:<id>`, and `SYNC_READY`.

Workspace mutation is not automatic; handoff feeds the existing Workspace Sync/binding step.

## Permission boundary

- preview = READ / READ_ONLY
- confirm backfill = REMEDIATION / PRODUCTION_MUTATION
- default enabled tiers remain READ + QA_OPERATE
- REMEDIATION remains disabled by default

## Verification

Targeted Auto-Link / control-plane / MCP boundary:

```text
Test Files: 7 passed
Tests:      45 passed
```

Full NQA regression:

```text
Test Files: 90 passed
Tests:      453 passed
```

TypeScript:

```text
tsc --noEmit
PASS
```

Final commit gate additionally verifies Prettier, exact staged files,
`git diff --cached --check`, secret/debug scans, no `.tmp`, no active
threshold-policy or M17 activation changes, and that default enabled permission
tiers remain READ + QA_OPERATE.

## Live Google status

The production Google REST writer is tested with mocked API responses. No live write to the real `รวมนิยาย` spreadsheet is performed in this milestone.

A live backfill requires an explicitly connected credential/token containing the full Sheets scope and an explicitly enabled REMEDIATION execution boundary.
