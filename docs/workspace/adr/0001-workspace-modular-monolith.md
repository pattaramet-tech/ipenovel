# ADR-0001 — Workspace as a bounded module

Status: Accepted for M00 planning

Baseline: `979ba981d2938d15ebfa8f8c7ae33824821eaf99`

## Context

Workspace shares existing identity, novel/episode ownership, admin controls, and eventually publication transactions. A separate service now would require distributed auth, duplicated identity, cross-service consistency, a second deployment, and partial-publish recovery before product behavior is proven.

## Decision

Place Workspace in the existing modular monolith with `/workspace`, `server/workspace`, and `workspace_` tables. Share only platform primitives (session, users, DB, logging, metrics, object storage). Own memberships, Google authorizations, document observations, Kanban, checker, AI jobs, and publishing orchestration. Cross-domain delivery uses explicit application ports and a transactional outbox.

## Consequences

Benefits: one identity boundary, local transactions, current deployment/test reuse, and reversible validation. Costs: added worker/Google responsibilities, strict import boundaries, and retention/capacity needs.

Consider extraction only when at least two are sustained: independent scaling, release-cadence blockage, distinct operating/security ownership, data-residency isolation, or mature outbox contracts. Preserve opaque IDs/event contracts and prohibit direct cross-service table writes.

Rejected: separate service now (premature distributed complexity), Sheets forever (insufficient durable concurrency/RBAC/audit/API delivery), replacing Docs (contradicts product goal).
