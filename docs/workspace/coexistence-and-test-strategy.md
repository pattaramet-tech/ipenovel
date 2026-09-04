# Novel Helper coexistence, migration, and test strategy

Google Sheets/Apps Script remains usable throughout migration. Adoption is per novel and per capability, never global.

## Migration phases

| Phase | Workspace | Sheets/Apps Script | Exit |
| --- | --- | --- | --- |
| 0 inventory | synthetic/read-only mapping | sole owner | mappings verified |
| 1 observe | metadata/snapshots/status only | sole action owner | fingerprints stable |
| 2 dual-run | compare checks on synthetic/copied inputs; no publish | operational owner | zero unexplained missing/duplicates |
| 3 opt-in | one capability/novel owns actions | fallback; disable only owned item | rollback drill |
| 4 primary | selected actions owned by Workspace | read/export fallback | sustained parity/SLO |
| 5 retirement candidate | no new legacy actions for approved novels | retained pending human approval | separate decision |

`workspace_migration_registry` records capability owner, cutover epoch, and version. Side effects require current ownership plus an idempotency key in the same transaction. Ambiguous ownership fails closed for side effects while reads continue.

Imports are non-destructive, repeatable upserts keyed by stable legacy ID + source spreadsheet ID + epoch. Unknown rows are quarantined, never coerced. Reconciliation compares document/episode identity, normalized hashes, ruleset, findings, queue state, item counts, and receipts.

Rollback: stop new claims; settle/reconcile in-flight items; export succeeded receipts/idempotency keys; advance ownership to Sheets in a new epoch; verify legacy controls; keep Workspace history read-only. Never replay already-succeeded publish items. M00 never edits Apps Script, live Sheets, or Docs and never removes ZIP export.

## Deterministic synthetic migration dry-run fixture

Fixture ID: `workspace-migration-v1`. All values below are committed test constants; clocks are frozen at `2026-01-15T00:00:00Z`. The runner uses in-memory objects or an isolated test DB plus mocked Google adapters. Network access, real spreadsheet/document IDs, OAuth credentials, provider APIs, and production DB are forbidden.

### Input

Synthetic spreadsheet identity: `sheet_fixture_001`; migration epoch: `epoch_001`; Workspace `ws_001`; existing publication novel `novel_101`.

| Legacy row | Novel key | Capability | Action owner | Document ID | Revision | Normalized SHA-256 token | Expected handling |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `row_001` | `novel_101` | checker | sheets | `doc_alpha` | `rev_1` | `sha_alpha_v1` | import |
| `row_002` | `novel_101` | ai_queue | sheets | `doc_beta` | `rev_4` | `sha_beta_v4` | import |
| `row_003` | `novel_101` | publish | sheets | `doc_gamma` | `rev_2` | `sha_gamma_v2` | import |
| duplicate of `row_002` | same | same | same | same | same | same | dedupe, no new record |
| `row_004` | blank | checker | sheets | `doc_orphan` | `rev_1` | `sha_orphan` | quarantine `MISSING_NOVEL_KEY` |
| `row_005` | `novel_101` | `unknown_action` | sheets | `doc_unknown` | `rev_1` | `sha_unknown` | quarantine `UNKNOWN_CAPABILITY` |
| `row_006` | `novel_999` | checker | sheets | `doc_unbound` | `rev_1` | `sha_unbound` | quarantine `NOVEL_NOT_BOUND` |

Mock Docs metadata contains exactly three valid entries matching `doc_alpha`, `doc_beta`, and `doc_gamma`. Each returns its listed revision and normalized hash; no body text leaves the fixture.

### First-run expected result

- input records observed: 7 (including the duplicate);
- unique valid legacy rows imported: 3;
- duplicate rows ignored: 1;
- quarantined rows: 3 with exactly one of each reason above;
- Workspace novel bindings created/reused: 1;
- document identities: 3; bindings: 3; snapshots: 3; current fingerprints: 3;
- migration-registry entries: 3, all owner `sheets`, epoch `epoch_001`;
- Checker/AI/publish side effects: 0;
- reconciliation: `missing=0, unexpected=0, hashMismatch=0, ownershipMismatch=0`.

Stable import identity is `sheet_fixture_001 + legacyRowId + epoch_001`; duplicate input is resolved before insert. Quarantine identity uses the same tuple plus reason.

### Second-run/idempotency expected result

Run the identical fixture again with the same frozen clock and epoch. It must produce `created=0, updated=0, unchanged=3, duplicateIgnored=1, quarantineUnchanged=3`. All entity counts and primary IDs remain identical; no additional snapshot, binding, registry, quarantine, job, checker run, outbox, or publish item appears.

### Explicit pass/fail thresholds

PASS requires all exact counts above, zero side effects, zero network calls, zero live credentials, and identical stable IDs/counts after the second run. Any missing/unexpected record, hash/ownership mismatch, changed primary ID, extra quarantine row, provider call, or side-effect row is FAIL. Checker-result variance tolerance is zero for this deterministic fixture.

A future fixture version must use a new fixture ID and expected-result block; it cannot silently change `workspace-migration-v1`.

## M00 checks

1. allowlist diff to `docs/workspace/**`;
2. no runtime/schema/migration/package/OAuth/Apps Script changes;
3. Markdown links and Mermaid/manual syntax review;
4. schema/term consistency;
5. `git diff --check`;
6. tabletop `workspace-migration-v1` twice against the exact expectations;
7. exact HEAD handoff to independent review and separate final verification.

No live Google, DB, AI-provider, staging, or production operation is allowed.

## Tabletop tests

| Scenario | Expected |
| --- | --- |
| same revision twice | one observation identity; dependent work deduped |
| new revision, same normalized content | record revision; content work deduped |
| changed content | new hash and dependent work |
| two workers claim | one lease wins |
| provider succeeded, worker died | receipt reconciliation prevents duplicate acceptance |
| partial publish | preserve succeeded items; retry remainder |
| both systems claim ownership | fail closed and reconcile |
| token revoked | reconnect-required; Sheets unaffected |
| ruleset changes | new checker run |
| stale publish hash | destination rejects overwrite |

## Future automated matrix

| Layer | Coverage |
| --- | --- |
| Unit | normalization vectors, state transitions, role matrix, idempotency, lease expiry |
| Contract | mocked Google revisions/content/quota/revocation, AI receipts, publishing stale-hash/duplicate |
| Integration | isolated `ipenovel_test`, unique/FK/index, optimistic concurrency, transactional outbox/item retry |
| Migration | synthetic Sheets/Docs fixtures, repeatability, quarantine, reconciliation, cutover/rollback |
| Regression | storefront, login/connect, admin novel/episode, ZIP import, release gates unchanged |
| Security/resilience | token redaction/encryption, CSRF/replay, membership isolation, duplicate workers, partial failure |

Integration tests must use the repository test DB guard and mocked Google APIs, never production credentials or fallback `DATABASE_URL`.

## Threat/risk checklist

OAuth state/PKCE and fixed redirects; login scopes unchanged; least privilege; encrypted/versioned server-only refresh tokens; ownership checks; no arbitrary-URL fetch; content/log minimization; revocation/rotation/support audit; quota/backoff; eventual consistency; duplicate workers; stale hashes; partial publishing; rollback dedupe.

## Acceptance evidence

README + ADR prove placement/boundaries and auth separation; data-model covers all requested domains with per-table keys, columns, relationships, indexes, enums, and retention; this plan proves coexistence/reconciliation/rollback and defines a deterministic, zero-network synthetic dry run. Documentation-only diff proves no feature implementation. Independent review and verification are mandatory at the exact documentation HEAD.
