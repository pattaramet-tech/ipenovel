# IpeNovel Workspace — M00 Architecture & Foundation Plan

Task: IPE-024 · Context: IPE-024-C01 · Baseline: `979ba981d2938d15ebfa8f8c7ae33824821eaf99`

## Decision

Build Workspace as a bounded module in the existing `pattaramet-tech/ipenovel` repository and deployment, not a separate repo/service. Use `/workspace` for UI, `server/workspace` for server code, and `workspace_` tables. Preserve ports and event contracts so a later service extraction remains possible.

Google Docs remains the draft editor/source. Workspace stores orchestration metadata, immutable observations/fingerprints, checker findings, AI job state, and publishing audit. Existing `novels`/`episodes` remain the publication destination. M00 adds documentation only: no runtime code, migration, OAuth scope, live import, worker, deploy, or Apps Script change.

## Grounded baseline

The inspected repo is a React 19/Vite SPA using Wouter, Express+tRPC, Drizzle/MySQL, Vitest, and S3-compatible/R2 storage. Google login already uses PKCE/OIDC with exact scope `openid email profile`; identity is `users` + `authIdentities`. Admin episode/ZIP import is an existing publication surface.

## Module boundaries

| Boundary | Location | Ownership |
| --- | --- | --- |
| UI | `client/src/pages/workspace` | Control center/Kanban/checker/queue/publishing status |
| Router | `server/workspace/router.ts` | authenticated tRPC and membership authorization |
| Domain/application | `server/workspace/domain`, `application` | invariants, commands, state machines |
| Google adapter | `server/workspace/integrations/google` | consent, Docs/Drive reads, revision metadata |
| Checker/AI/publish | `server/workspace/checker`, `jobs`, `publishing` | deterministic checks, leases/artifacts, outbox delivery |
| Persistence | Workspace-prefixed Drizzle tables | local transactions and audit |

Dependencies point UI/router → application → domain. External systems implement ports. Storefront code must not import Workspace internals.

## Authentication and Google authorization

Reuse existing session/RBAC; add workspace roles `owner|editor|reviewer|viewer`. Platform admin status does not silently grant membership.

Docs access is a separate, explicit incremental-consent flow and never changes login scope. It uses authenticated start, state/PKCE, fixed callback, least privilege, server-derived ownership, encrypted refresh tokens with key version, atomic refresh rotation, revocation/reconnect, scope checks, and audit. Provider tokens/codes/document bodies never enter browser storage or routine logs.

## Source of truth

| Data | Authority |
| --- | --- |
| Draft prose | Google Docs |
| Membership/orchestration | Workspace DB |
| Observed revision/content hash | immutable Workspace snapshot |
| Legacy actions during early migration | Google Sheets Novel Helper |
| Published content | existing IpeNovel novels/episodes |
| Side-effect ownership | migration registry + idempotency epoch |

## Processing and concurrency

1. Resolve bound file through its owning Google connection.
2. observe provider revision/version and content;
3. normalize with a versioned algorithm and SHA-256 domain prefix;
4. persist immutable snapshot;
5. bind Checker to snapshot + ruleset version;
6. bind AI job to snapshot + prompt/model/policy version;
7. bind publish run to snapshot + destination + expected last-published hash;
8. commit transition and outbox atomically.

Mutable roots use optimistic `version`. Workers use atomic conditional claim + bounded lease. Side-effect receipts are persisted before success. Titles, URLs, row positions, and mutable display data are never identity.

State machines:

- Checker: `queued → running → passed|failed|cancelled`.
- AI: `queued → claimed → running → succeeded|failed|cancelled`; retry creates a new attempt.
- Publish: `draft → validating → ready → publishing → published|partially_failed|failed|cancelled`; retry only non-succeeded items.
- Kanban location is a projection of immutable transition events.

## API boundaries

Google port: connection status, selection/binding, metadata fetch, snapshot creation. Checker port: snapshot/ruleset IDs. AI port: durable job ID and attempt receipt. Future internal publishing API: service auth, workspace/novel authorization, idempotency key, expected last-published hash, item receipts, explicit partial failure. Publishing API implementation is out of M00.

## Roadmap

- M01: shell, membership, read-only bindings, synthetic contracts.
- M02: incremental Google consent and snapshots/fingerprints.
- M03: Kanban + Checker parity in dual-run.
- M04: durable AI Queue.
- M05: publish dry-run/reconciliation, then opt-in API.
- M06: legacy retirement candidate; ZIP fallback remains until separate approval.

## Acceptance matrix

| Requirement | Evidence | First milestone |
| --- | --- | --- |
| Control Center | boundaries | M01 |
| Docs remains editor | source-of-truth model | M01–M02 |
| Kanban/fingerprints/Checker | data model + states | M02–M03 |
| AI Queue | leases/attempts/artifacts | M04 |
| Export/direct API | publish/outbox contract | M05 |
| Preserve Novel Helper | coexistence plan | every phase |

M00 exits only when linked documents are consistent, the diff is documentation-only, links/tabletop checks and `git diff --check` pass, then an independent reviewer and separate verifier approve the exact HEAD.

- [ADR-0001](adr/0001-workspace-modular-monolith.md)
- [Data model](data-model.md)
- [Coexistence and testing](coexistence-and-test-strategy.md)
