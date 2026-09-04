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

## M00 checks

1. allowlist diff to `docs/workspace/**`;
2. no runtime/schema/migration/package/OAuth/Apps Script changes;
3. Markdown links and Mermaid/manual syntax review;
4. schema/term consistency;
5. `git diff --check`;
6. exact HEAD handoff to independent review and separate final verification.

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

README + ADR prove placement/boundaries and auth separation; data-model covers all requested domains with keys/index/idempotency/retention; this plan proves coexistence/reconciliation/rollback and test strategy. Documentation-only diff proves no feature implementation. Independent review and verification are mandatory at the exact documentation HEAD.
