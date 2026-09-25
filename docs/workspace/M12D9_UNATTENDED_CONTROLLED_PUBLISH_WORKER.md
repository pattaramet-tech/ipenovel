# M12D.9 — Unattended Controlled Publish Worker

## Purpose

M12D.9 closes the gap between a successful Controlled Publish enqueue and the actual provider execution. The HTTP request remains responsible only for validation and durable enqueue; the background worker drains eligible Workspace publish outbox rows.

M12D.9 originally activated this worker only for Preview. **M12D.12 supersedes the Production activation rule** without changing the durable worker/outbox mechanics.

## Activation gates

### Preview / legacy non-production

Preview preserves the original activation contract:

- `WORKSPACE_PUBLISH_EXECUTION_ENABLED=true`
- `WORKSPACE_PUBLISH_EXTERNAL_PROVIDER_ENABLED=true`
- `WORKSPACE_PUBLISH_ACCEPTANCE_TIER=preview`
- `WORKSPACE_PUBLISH_PREVIEW_DATABASE_NAME=<exact Preview database name>`
- `DATABASE_URL` resolves to that exact database name

### Production (M12D.12)

When `DEPLOYMENT_ENVIRONMENT=production` exactly:

- `WORKSPACE_PUBLISH_EXECUTION_ENABLED` is ignored; it is not a Production kill switch or activation gate.
- `DATABASE_URL` must match `PRODUCTION_DB_FINGERPRINT`.
- `PRODUCTION_STAGING_DB_FINGERPRINT`, when supplied, must differ from the Production fingerprint.
- `WORKSPACE_PUBLISH_EXTERNAL_PROVIDER_ENABLED=true` remains required for external delivery.
- Preview acceptance variables are not read and Production must never spoof `WORKSPACE_PUBLISH_ACCEPTANCE_TIER=preview`.

`WORKSPACE_PUBLISH_UNATTENDED_ENABLED=false` remains a worker-specific emergency stop. Setting it explicitly to `true` makes missing execution-policy/provider prerequisites fail startup closed.

Optional polling control:

- `WORKSPACE_PUBLISH_UNATTENDED_POLL_MS` — integer 1000–60000; default 5000 ms.

## Runtime behavior

Each cycle resolves the oldest eligible pending/retryable outbox from durable database state. The resolved scope includes workspace, Workspace novel, publish run, ownership epoch and ownership version. Execution continues through `runScopedPublishWorkerOnce`, so existing ownership fences, reconcile-first provider behavior, request idempotency, bounded attempts, provider receipts, dead-letter handling, hash advancement and Editorial reconciliation remain authoritative.

The loop is single-flight per process and schedules the next cycle only after the current cycle settles. Empty queues wait for the configured polling interval. Errors use at least a 10-second backoff. Multiple application replicas remain protected by the existing database outbox claim/lease logic.

## Lifecycle and observability

The worker configuration is validated after startup migrations and before the server begins listening. The polling loop starts only after the HTTP server is listening and stops when the server closes.

Logs use structured JSON under `component=workspace-publish-worker` and include operational identifiers/status only. Connection strings and credentials are not logged.

## Existing queued runs

The worker does not require a new Publish click. A previously enqueued eligible run is discovered by `resolvePendingPublishExecutionScope()` and can continue after a worker-enabled deployment, subject to the current environment-aware runtime policy.

## Production boundary

M12D.12 adds a dedicated Production safety path. Production execution is enabled by exact environment + approved Production DB identity, not by the legacy Preview execution flag. This does not remove admin authorization, ownership epoch/version, stale-hash validation, outbox idempotency, lease fencing, bounded retry/dead-letter, provider receipt, or the external-provider opt-in.
