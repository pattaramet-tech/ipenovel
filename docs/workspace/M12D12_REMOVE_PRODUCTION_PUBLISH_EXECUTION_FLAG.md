# M12D.12 — Production Publish Runtime Refactor

Status: **superseded by M12D.13**.

M12D.12 established that Production publish activation must come from runtime policy rather than a global rollout switch. M12D.13 completed that refactor by removing the remaining legacy execution/acceptance configuration and extending the same environment/DB identity model to `production-staging`.

Current source of truth:

- `docs/workspace/M12D13_SIMPLIFY_CONTROLLED_PUBLISH_RUNTIME_POLICY.md`
- `server/workspace/publishExecution.runtime.ts`

The durable safety mechanisms introduced before M12D.13—admin authorization, ownership epoch/version, stale-hash protection, idempotent outbox, bounded retry/dead-letter, provider receipt, and DB isolation—remain in force.
