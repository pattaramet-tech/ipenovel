# M29.3 — Chapter Editor Release Gate

## Scope

M29.3 turns the Workspace Draft editor into a chapter-level operator workflow
without changing the existing publication authority boundary.

The release lineage is:

- M29.3 — whole-tab Chapter Editor with CAS-bound manual Draft revisions;
- M29.3.1 — paragraph-aware paste and exact per-paragraph finding highlight;
- M29.3.2 — consolidated Workspace Editor UI;
- M29.3.3 — chapter navigation, scroll memory, keyboard save and unsaved guards;
- M29.3.4 — unified finding navigation and inline QC actions;
- M29.3.5 — Structural Repair Assistant and explicit source-note confirmation;
- M29.3.6 — chapter filters, progress summary, next-issue navigation and UI polish;
- M29.3.7 — release verification, DB-backed end-to-end gate and PR handoff.

No M29.3 milestone performs Production deployment.

## Chapter Editor workflow

The operator path remains explicit:

`Open chapter -> edit Draft -> save -> deterministic checker -> resolve findings /
structural issues -> Confirm Draft -> Stage -> separate Publish authority`.

Whole-chapter save uses the existing immutable Draft revision path. It does not
write directly to a published Episode.

After save, checker evidence is stale until the deterministic checker runs for
the new Draft. Approval remains bound to the exact Draft SHA, checker run and
QC evidence SHA.

## Structural confirmation

Migration `0060_workspace_editorial_structural_confirmations.sql` adds a
Draft-bound confirmation record for `source_note_only`.

The confirmation is:

- explicit and reversible;
- restricted to `source_note_only`;
- bound to the current Draft and checker anomaly key;
- optimistic-concurrency checked;
- included in QC evidence;
- invalid for a newer Draft until that Draft is checked and confirmed again.

Confirmation does not rewrite chapter content. All other blocking structural
anomalies still require a manual Draft repair followed by a checker rerun.

## M29.3.7 end-to-end acceptance

`server/workspace/editorialChapterEditorReleaseGate.service.integration.test.ts`
proves the release boundary against the disposable `ipenovel_test` database:

1. import a chapter containing a foreign token and a `source_note_only`
   structural anomaly;
2. save a whole-tab `replace_tab` Chapter Editor revision;
3. rerun QC and prove the foreign finding disappears while the structural
   anomaly still blocks approval;
4. prove approval fails with `QC_UNRESOLVED` before human confirmation;
5. explicitly confirm the source-note anomaly;
6. prove QC becomes ready and approval succeeds only with current evidence;
7. stage the Episode and prove it remains unpublished
   (`isPublished=false`, `publishedAt=null`).

This verifies Confirm/Stage boundaries without executing Publish.

## Verification gates

Local release-gate verification covers:

- full `server/nqa` unit regression: **95 files / 473 tests PASS**;
- full `server/workspace` unit regression plus Chapter Editor helper and
  migration deployment-safety coverage: **80 files / 402 tests PASS**;
- TypeScript `tsc --noEmit`;
- production Vite + esbuild build;
- diff, encoding and secret-material scans.

The combined local NQA/Workspace unit evidence is **175 files / 875 tests
PASS**. The release-gate run also caught one stale pre-M29.3.2 UI assertion
that still expected a separate `Draft structure` panel; that regression test
was reconciled to the consolidated `Workspace Editor` contract and the full
Workspace suite passed afterward.

DB-backed integration tests intentionally require
`TEST_DATABASE_URL=.../ipenovel_test` and never fall back to Production.
When no disposable test database is available locally, the integration gate
must fail closed rather than silently skip.

The authoritative DB-backed gate is
`.github/workflows/m29-3-7-chapter-editor-release-gate.yml`. It provisions a
fresh MySQL 8 `ipenovel_test`, applies migrations including 0060, runs the
Workspace integration regression and the dedicated Chapter Editor end-to-end
test, then runs typecheck/build and diff safety.

## M29.3.7 final DB-backed gate

The authoritative GitHub Actions run for commit
`71ecde2b4a4523e0214370f79942f16d0e55c01b` completed successfully:

- run `36326023638` — **M29.3 Chapter Editor Release Gate: PASS**;
- full NQA + Workspace unit regression: **175 files / 875 tests PASS**;
- full Workspace DB-backed integration regression: **27 files / 38 tests PASS**;
- dedicated Chapter Editor edit -> QC -> structural confirm -> Confirm/Stage gate:
  **1 file / 1 test PASS**;
- TypeScript `tsc --noEmit`: **PASS**;
- production Vite + esbuild build: **PASS**;
- migration 0060 + diff/encoding/private-key safety gate: **PASS**.

The green run above established the DB-backed baseline. Subsequent repeat runs
exposed residual clock-bound outbox claim timing in legacy publish integration
tests, so M29.3.7 additionally makes every affected test claim/retry eligibility
explicit in the database and scopes claims to the intended publish run. This is
test hardening only; Production execution semantics are unchanged. The final PR
head must pass the same authoritative workflow before this gate is closed.

PR #78 remains the release handoff. It is intentionally left open and
unmerged. No Production deployment is part of M29.3.7.

## Release rule

M29.3.7 may push/update the feature PR after all available local gates pass and
the DB-backed GitHub Actions gate is green. The PR must not be merged and no
Production deployment may occur as part of this milestone.
