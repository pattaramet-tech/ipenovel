# NQA Core Foundation — M02 + M03 Handoff

Status: COMPLETE
Date: 2026-09-24
Branch: feat/nqa-foundation
Base: origin/main at worktree creation

## Delivered

Code:

- server/nqa/contracts.ts
- server/nqa/core.ts
- server/nqa/intake.ts
- server/nqa/controlPlane.ts
- server/nqa/fixtures/canonical.ts
- server/nqa/index.ts

Tests:

- server/nqa/contracts.test.ts
- server/nqa/core.test.ts
- server/nqa/intake.test.ts
- server/nqa/controlPlane.test.ts
- server/nqa/fixtures.test.ts

Documentation:

- docs/nqa/M02_DATA_CONTRACTS_CANONICAL_FIXTURES.md
- docs/nqa/M03_MCP_CAPABILITY_PERMISSION_CONTRACT.md
- docs/nqa/NQA_CORE_FOUNDATION_HANDOFF.md

## Isolation boundary

This foundation intentionally does not modify:

- client UI
- WorkspacePage
- server/routers.ts
- server/workspace/*
- Drizzle schema
- migrations
- package.json
- pnpm-lock.yaml

No NQA endpoint is reachable from production yet.

## Important fixture evolution

The historical incident originally associated with row 1584 is now located at row 1562 by title/source reference.

The current C-column document is different from the historical incident document and was not readable by the connected Google reader at capture time.

Therefore:

- row is a mutable locator
- C link is mutable routing state
- canonical regression identity is revision/hash based
- historical revision 69 remains the known-bad regression source
- revision 90 provides a corrected positive-control candidate

## Native Automation verification loop

The implementation was built in an isolated worktree and validated with:

- frozen-lockfile dependency install
- targeted Vitest suite
- TypeScript no-emit check

## Promotion boundary

Safe next work before main reconciliation finishes:

- expand contract tests
- implement read-only Google adapter behind interfaces
- implement resolver/extractor in isolated server/nqa namespace
- build local-only deterministic QA

Wait before shared integration:

- admin UI route
- WorkspacePage changes
- shared router registration
- database migrations
- production scheduler wiring

## Next milestone

M04 should implement the Secure NQA MCP Gateway + Tunnel contract on top of the completed M03 allowlist, while preserving the rule that the core service can run without ChatGPT or MCP.

## Final verification evidence

NQA targeted unit suite:

- 5 test files passed
- 23 tests passed
- 0 NQA test failures

TypeScript:

- `corepack pnpm check`
- PASS, exit code 0

Full repository unit sweep:

- 284 test files discovered
- 227 passed
- 56 failed
- 1 skipped
- 3607 tests passed
- 251 failed
- 231 skipped
- exit code 1

The full-suite failures are outside `server/nqa` and include existing/environment-dependent areas such as OCR date parsing, wallet/database-required integration-style tests, Google OAuth static safety, and AdminDashboard source-shape checks. No files in those areas were modified by this milestone.

Promotion rule:

- NQA targeted gate: PASS
- TypeScript gate: PASS
- Full-repo baseline: NOT GREEN in this environment; do not represent it as an NQA regression gate until the repository baseline is reconciled separately.
