# M12D.9 — Unattended Controlled Publish Worker

## Purpose

The unattended worker drains eligible Workspace publish outbox rows after request-time validation and durable enqueue. It does not decide which database is safe to publish from; it consumes the same environment/DB identity policy as the HTTP publish path.

## Activation

The worker is active only when all of the following are true:

- `DEPLOYMENT_ENVIRONMENT` is exactly `production` or `production-staging`;
- `DATABASE_URL` matches the approved fingerprint for that environment;
- Production and staging fingerprints do not collide;
- `WORKSPACE_PUBLISH_EXTERNAL_PROVIDER_ENABLED=true`;
- `WORKSPACE_PUBLISH_UNATTENDED_ENABLED` is not explicitly `false`.

`WORKSPACE_PUBLISH_UNATTENDED_ENABLED=false` is a worker-only emergency stop. Setting it to `true` makes missing runtime/provider prerequisites fail startup closed.

Optional polling control:

- `WORKSPACE_PUBLISH_UNATTENDED_POLL_MS` — integer 1000–60000; default 5000 ms.

Preview/development environments remain inactive for real provider publish and do not have a feature flag that can promote them into a release environment.

## Runtime behavior

Each cycle resolves the oldest eligible pending/retryable outbox from durable database state. The scope includes workspace, Workspace novel, publish run, ownership epoch, and ownership version.

Execution continues through `runScopedPublishWorkerOnce`, preserving:

- exact ownership fences;
- reconcile-first provider behavior;
- deterministic request idempotency;
- bounded attempts and dead-letter;
- receipt persistence before terminal success;
- last-published hash advancement;
- Editorial reconciliation.

The loop is single-flight per process. Empty queues wait for the configured polling interval. Errors back off for at least 10 seconds. Multiple replicas remain protected by the database outbox claim/lease.

## Lifecycle and observability

Worker configuration is evaluated after startup migrations and before HTTP listen. Polling starts only after the server is listening and stops when the server closes.

Structured logs use `component=workspace-publish-worker` and record environment/DB name plus operational identifiers/status only. Connection URLs, credentials, token material, and document bodies are not logged.

## Existing queued runs

A previously enqueued eligible run can continue after restart because scope is reconstructed from durable outbox, destination, and current ownership state. No per-run environment variable is needed.
