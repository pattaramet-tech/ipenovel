# M03 — NQA MCP Capability + Permission Contract

Status: COMPLETE
Date: 2026-09-24
Scope: Control-plane foundation only
Branch: feat/nqa-foundation

## Objective

Define a fail-closed capability surface for future ChatGPT / MCP access to NQA.

M03 does not create a network MCP server and does not register routes.
That belongs to the Secure NQA MCP Gateway milestone.

## Authority model

ChatGPT is a reasoning/orchestration client.

The NQA backend is authoritative for:

- capability existence
- permission checks
- validation
- idempotency
- audit
- execution boundaries

Prompt instructions are not the security boundary.

## Permission tiers

Defined tiers:

- READ
- QA_OPERATE
- REMEDIATION
- PRODUCTION_MUTATION

Enabled in NQA V1:

- READ
- QA_OPERATE

No capability in the V1 registry requires REMEDIATION or PRODUCTION_MUTATION.

## V1 allowlisted capabilities

READ:

- nqa.intake.get_row
- nqa.intake.scan_range
- nqa.intake.validate_contract
- nqa.intake.get_manifest
- nqa.novel.resolve_identity
- nqa.chapter.resolve
- nqa.chapter.extract
- nqa.result.get
- nqa.evidence.get
- nqa.review.list
- nqa.review.inspect

QA_OPERATE:

- nqa.qa.run_deterministic
- nqa.qa.run_semantic
- nqa.qa.run_regression
- nqa.qa.deep_review_prepare
- nqa.cache.rebuild_changed
- nqa.manifest.refresh

## Fail-closed rule

Authorization is registry-based.

Any operation name absent from NQA_CAPABILITIES is denied as UNKNOWN_CAPABILITY.

This avoids maintaining a fragile deny-list and makes future capability expansion explicit in code review.

## Effect classes

V1 capability effects are restricted to:

- READ_ONLY
- QA_STATE_WRITE

QA_STATE_WRITE means writes are allowed only to QA-owned state such as:

- evidence
- immutable result records
- review queue state
- cache / manifest state

It does not authorize production novel-content mutation.

## Permission semantics

Permissions are explicit, not hierarchical.

Having QA_OPERATE does not silently imply READ.
The actor must hold every tier it needs.

A request is denied when:

1. capability is unknown
2. capability tier is disabled by runtime policy
3. actor lacks the required permission

## MCP request envelope

Every future MCP request must carry:

- requestId
- correlationId
- actorId
- capability
- bounded target identity
- optional idempotencyKey
- optional inputFingerprint
- requestedAt

The envelope deliberately does not require or encourage full novel text payloads.

## Audit envelope

Every authorized or rejected request produces:

- audit version
- request/correlation IDs
- actor ID
- capability
- ALLOW/DENY decision
- decision reason
- bounded target
- idempotency key
- input fingerprint
- outcome
- timestamp

Rejected requests are auditable.

Novel source/translation text is not stored in the control-plane audit record.

## Idempotency

Core helpers implement two initial keys.

Intake key includes:

- spreadsheet
- sheet
- row
- source document/revision
- translation document/revision
- contract version

Chapter QA key includes:

- novel ID
- bundle ID
- source chapter
- source hash
- translation hash
- translation variant
- chunker version
- model set version
- policy version

Changing a revision or policy changes the key.

## Current implementation

server/nqa/controlPlane.ts:

- capability registry
- permission tiers
- default V1 enabled tiers
- authorization decision
- MCP request validation
- audit record
- audit sink contract
- in-memory audit sink for tests
- authorizeAndAudit helper

server/nqa/core.ts:

- canonical JSON hashing
- intake idempotency
- chapter-QA idempotency
- input fingerprinting

## Deferred to future milestone

Not implemented in M03:

- public/admin HTTP route
- MCP transport
- tunnel authentication
- persistent audit storage
- Google adapter
- semantic model execution
- remediation
- production write-back

This separation keeps M03 safe to build in parallel with the active IpeNovel reconciliation branch.

## Acceptance criteria

- allowlisted operations only
- unknown operations fail closed
- READ cannot run QA_OPERATE actions
- only READ + QA_OPERATE capability tiers are exposed in V1
- rejected operations are auditable
- audit records do not carry content payloads
- TypeScript check passes
- unit tests verify authorization behavior

M03 is complete.
