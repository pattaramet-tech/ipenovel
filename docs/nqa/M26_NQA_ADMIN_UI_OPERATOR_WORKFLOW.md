# M26 — NQA Admin Tool UI + Operator Workflow

## Goal

Expose the existing NQA engine as an admin-only operator tool at `/admin/nqa`.
M26 must compose the existing NQA core/gateway/runtime boundaries rather than
re-implementing QA logic in React.

## Audited existing surfaces

### NQA core and gateway

Existing capabilities already cover:

- `nqa.intake.get_row`
- `nqa.intake.scan_range`
- `nqa.novel.resolve_identity`
- `nqa.chapter.resolve`
- `nqa.chapter.extract`
- `nqa.qa.run_deterministic`
- `nqa.qa.run_semantic`
- `nqa.novel_link.preview`
- `nqa.novel_link.confirm_backfill`

Default NQA tiers remain `READ + QA_OPERATE`.
`REMEDIATION` and `PRODUCTION_MUTATION` are not globally enabled.

### Workspace Auto-Link

The production-composed Workspace router already exposes:

- `workspace.nqaNovelLink.status`
- `workspace.nqaNovelLink.preview`
- `workspace.nqaNovelLink.confirmBackfill`

M26 UI must call these procedures directly. It must not recreate the Auto-Link
matcher, authorization fingerprint, or Column A writer.

### Google boundaries

The NQA Auto-Link read credential already owns the Sheets read-only boundary.
Workspace Google Docs already owns an encrypted refresh credential and
`documents.readonly` boundary.

M26 Full QA/QC therefore composes two existing server-only boundaries:

- Sheet B/C/E/F/G/K reads use the NQA read-only Sheets credential.
- Google Docs bodies use the selected Workspace Google Docs connection.

No token value is returned to the browser or persisted into NQA run artifacts.

### Semantic runtime

The existing NQA semantic pipeline is:

`deterministic -> global embedding search -> monotonic alignment/reranker -> adjudication -> structured event/entity/relationship/causality verification`.

Existing loopback providers are reused:

- BGE-M3: `127.0.0.1:8765`
- BGE reranker: `127.0.0.1:8766`
- Qwen adjudication/structure: `127.0.0.1:8767`

The admin status endpoint reports these dependencies as ready/blocking rather
than silently degrading Full QA.

## API gaps M26 is allowed to add

The existing repository did not have:

1. an admin composition runtime for Full QA/QC;
2. persistent operator run/checkpoint/history state;
3. bounded QC presentation combining deterministic evidence with footer/empty/
   foreign-script/Unicode checks;
4. preview-first Column L/M writeback;
5. an admin tRPC surface and React UI.

M26 adds only those orchestration gaps.

## Operator workflow

### Overview

Shows readiness for:

- Sheet intake;
- Workspace Docs connections;
- semantic sidecars;
- persistent audit/run store;
- Full QA;
- QC;
- Novel ID Auto-Link preview/confirm;
- Column L/M writeback.

Blocker codes are shown without secret values.

### Full QA

Input:

- row or row range;
- Workspace Google Docs connection;
- sample mode: 5 paragraphs, 10 paragraphs, or full chapter.

Execution is checkpointed one chapter at a time. The browser may repeatedly call
`processNext`; closing the page does not invalidate the server-side run. Resume
continues from the stored cursor.

The semantic capability remains routed through `NqaMcpGateway`.

### QC

QC is explicitly separate from translation-fidelity QA.

It checks:

- NQA deterministic foreign-script evidence;
- Unicode replacement/control anomalies;
- non-Thai/non-Latin foreign-script markers;
- removable author/promo/comment/footer tail content;
- empty chapter body.

Latin alphabet text is not a blocking foreign-script marker, allowing proper
names such as character/place names.

The default eligibility filter is Sheet `F=true` and `G=false`.

### Result writeback

Columns L and M are never written while viewing/running QA.

Flow:

`Preview -> show exact value/fingerprint -> explicit confirmation -> write one cell -> verify`.

M26 uses a dedicated exact-literal `NQA_ADMIN_WRITEBACK_ENABLED=true` gate in
addition to the existing server-only full-Sheets write credential. It does not
broaden `NQA_AUTOLINK_REMEDIATION_ENABLED`.

### Novel ID Auto-Link

Flow remains:

`Status -> Preview -> Human Confirm -> Column A -> SYNC_READY`.

The existing Auto-Link remediation flag remains exact-literal fail-closed.

## Persistence and data minimization

Run artifacts live under the configured persistent NQA audit directory in an
`admin-runs` subdirectory.

Persisted data is bounded to:

- run/cursor/progress identity;
- row/chapter;
- decision/reason codes;
- policy/model identifiers;
- bounded evidence summaries;
- short source/translation excerpts;
- request/correlation/audit references.

OAuth/access/refresh tokens and full document bodies are never persisted.

## UI

Route: `/admin/nqa`

Tabs:

- Overview
- Full QA
- QC
- Novel ID Auto-Link
- Runs / History

All rendering remains behind the existing `AdminLayout` admin authorization
gate.

## Production rule

M26 may create a branch, commit, push, and PR. It must not deploy Production.
