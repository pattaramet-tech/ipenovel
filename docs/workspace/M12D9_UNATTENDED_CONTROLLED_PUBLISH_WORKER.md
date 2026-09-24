# M12D.9 — Unattended Controlled Publish Worker

## Purpose

M12D.9 closes the gap between a successful Controlled Publish enqueue and the actual provider execution. The HTTP request remains responsible only for validation and durable enqueue. A Preview-only background worker drains eligible Workspace publish outbox rows.

## Activation gates

The worker reuses the two existing execution gates. It starts when both are true:

- `WORKSPACE_PUBLISH_EXECUTION_ENABLED=true`
- `WORKSPACE_PUBLISH_EXTERNAL_PROVIDER_ENABLED=true`

It then requires the existing Preview safety identity:

- `WORKSPACE_PUBLISH_ACCEPTANCE_TIER=preview`
- `WORKSPACE_PUBLISH_PREVIEW_DATABASE_NAME=<exact Preview database name>`
- `DATABASE_URL` resolves to that exact database name

No new rollout flag is required for Preview, so an already-enqueued run can resume after deploying this code. `WORKSPACE_PUBLISH_UNATTENDED_ENABLED=false` is an emergency kill switch. Setting it explicitly to `true` makes missing execution/provider prerequisites fail startup closed.

Optional polling control:

- `WORKSPACE_PUBLISH_UNATTENDED_POLL_MS` — integer 1000–60000; default 5000 ms.

## Runtime behavior

Each cycle resolves the oldest eligible pending/retryable outbox from durable database state. The resolved scope includes workspace, Workspace novel, publish run, ownership epoch and ownership version. Execution continues through `runScopedPublishWorkerOnce`, so existing ownership fences, reconcile-first provider behavior, request idempotency, bounded attempts, provider receipts, dead-letter handling, hash advancement and Editorial reconciliation remain authoritative.

The loop is single-flight per process and schedules the next cycle only after the current cycle settles. Empty queues wait for the configured polling interval. Errors use at least a 10-second backoff. Multiple application replicas remain protected by the existing database outbox claim/lease logic.

## Lifecycle and observability

The worker configuration is validated after startup migrations and before the server begins listening. The polling loop starts only after the HTTP server is listening and stops when the server closes.

Logs use structured JSON under `component=workspace-publish-worker` and include operational identifiers/status only. Connection strings and credentials are not logged.

## Existing queued runs

The worker does not require a new Publish click. A previously enqueued eligible run (for example a run that is still `publishing` with a pending outbox) is discovered by `resolvePendingPublishExecutionScope()` and can continue after the worker-enabled Preview deployment.

## Production boundary

This implementation deliberately uses the existing Preview database safety gate. It is not a Production activation mechanism. Production execution remains out of scope.
