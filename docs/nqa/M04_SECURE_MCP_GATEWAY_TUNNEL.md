# M04 — Secure NQA MCP Gateway + Tunnel Foundation

Status: COMPLETE
Date: 2026-09-24
Branch: feat/nqa-foundation

## Objective

M04 adds a secure, testable MCP-facing gateway foundation on top of the M03 capability and permission contract.

The gateway is an adapter only. NQA Core and application logic remain callable without ChatGPT or MCP.

Architecture:

```text
ChatGPT / authenticated MCP client
        ↓
Secure tunnel
        ↓
NQA MCP Gateway
        ↓
Capability / permission / validation / audit / idempotency
        ↓
NQA application handlers
        ↓
NQA Core
```

ChatGPT is not production authority. Backend policy remains authoritative.

## Trust boundary

The gateway trusts only an authenticated `NqaGatewayPrincipal` supplied by the future tunnel/authentication layer.

Trusted principal fields:

- principalId
- sessionId
- explicit permissions
- authenticated flag

The request payload also carries `actorId` for transport compatibility, but gateway authorization, handler context, and audit identity do not trust it.

A spoofed request actor cannot override the authenticated principal.

Unauthenticated callers fail closed before capability authorization.

## Capability routing

M04 reuses `NQA_CAPABILITIES` from M03.

The handler registry is explicit:

```text
allowlisted capability -> registered application handler
```

Unknown capability names are denied before handler resolution.
A valid capability without a registered handler returns `HANDLER_NOT_REGISTERED`.
No arbitrary method lookup or string-based execution is performed.

## Permission model

V1 runtime permissions remain:

- READ
- QA_OPERATE

REMEDIATION and PRODUCTION_MUTATION remain defined as future tiers but no V1 capability requires them.

Permissions are explicit rather than hierarchical:

- READ does not imply QA_OPERATE
- QA_OPERATE does not imply READ
- callers needing both must receive both

Runtime policy may disable a normally valid tier. Disabled capabilities return `TIER_DISABLED`.

## Typed gateway contract

Request envelope:

- requestId
- correlationId
- actorId
- capability
- bounded target
- optional idempotencyKey
- optional inputFingerprint
- requestedAt

Response envelope:

- requestId
- correlationId
- capability
- authorization decision
- status: OK / REUSED / ERROR
- result or typed safe error
- auditRef

Malformed requests fail as `INVALID_REQUEST`.

## Idempotency

Every capability whose M03 effect is `QA_STATE_WRITE` requires a 64-character SHA-256 idempotency key.

The store contract supports:

- get
- reserve
- complete
- fail

Lifecycle:

- NEW: implicit absence
- IN_PROGRESS
- COMPLETED
- FAILED

Rules:

- missing key on QA_STATE_WRITE => IDEMPOTENCY_KEY_REQUIRED
- same completed request => reuse stored result, do not execute handler again
- same key while in progress => IDEMPOTENCY_CONFLICT
- same key with incompatible request fingerprint => IDEMPOTENCY_CONFLICT
- failed reservation may be explicitly retried
- READ_ONLY capabilities do not require an idempotency key

The M04 implementation ships only an in-memory store for tests and foundation behavior.
Persistent storage is deferred.

## Audit model

Gateway audit events:

- AUTHENTICATION_REJECTED
- REQUEST_REJECTED
- AUTHORIZATION_REJECTED
- HANDLER_REJECTED
- IDEMPOTENCY_REUSED
- EXECUTION_STARTED
- EXECUTION_SUCCEEDED
- EXECUTION_FAILED

Audit records include trusted principal/session identity, request IDs, capability, bounded target, permission outcome, idempotency key, input fingerprint, outcome, safe error code, and timestamp.

Audit records do not store:

- full source chapters
- full Thai chapters
- request content payloads
- OAuth tokens
- credentials
- secrets
- handler exception text

The current in-memory audit sink exists for unit tests. Persistent append-only audit storage is deferred.

## Safe error contract

Stable error codes:

- UNAUTHENTICATED
- INVALID_REQUEST
- UNKNOWN_CAPABILITY
- TIER_DISABLED
- MISSING_PERMISSION
- IDEMPOTENCY_KEY_REQUIRED
- IDEMPOTENCY_CONFLICT
- HANDLER_NOT_REGISTERED
- EXECUTION_FAILED

Handler exceptions are converted to the generic transport message:

`NQA handler execution failed.`

Raw exception messages and stack traces are not returned or written to gateway audit.

## Tunnel design

M04 deliberately does not open a network endpoint.

Future deployment shape:

```text
ChatGPT
   ↓ authenticated MCP client
Secure MCP Tunnel
   ↓ private / localhost boundary
NQA MCP Gateway adapter
   ↓
NQA application services
```

Tunnel requirements for the later transport milestone:

- localhost/private binding by default
- explicit authenticated principal creation
- capability allowlist only
- bounded typed request envelopes
- no arbitrary command execution
- no arbitrary file access
- no arbitrary SQL
- no production-content mutation capability
- audit every request
- redact secrets
- fail closed on authentication, validation, authorization, or routing uncertainty

## Isolation boundary

M04 production source is contained in:

- server/nqa/mcp/*
- server/nqa/index.ts export only

M04 does not modify or register:

- client/*
- WorkspacePage
- server/routers.ts
- server/workspace/*
- Drizzle schema
- migrations
- package.json
- pnpm-lock.yaml

There is no production HTTP/MCP listener in this milestone.

## Files

Production:

- server/nqa/mcp/contracts.ts
- server/nqa/mcp/audit.ts
- server/nqa/mcp/idempotency.ts
- server/nqa/mcp/handlers.ts
- server/nqa/mcp/gateway.ts
- server/nqa/mcp/index.ts

Tests:

- server/nqa/mcp/gateway.test.ts
- server/nqa/mcp/idempotency.test.ts
- server/nqa/mcp/isolation.static.test.ts

M04 gateway foundation is complete.
