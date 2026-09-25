# M12D.12 — Remove Production Publish Execution Flag

## Decision

Production Controlled Publish no longer uses `WORKSPACE_PUBLISH_EXECUTION_ENABLED` as an activation gate or kill switch.

The single runtime policy is `resolveWorkspacePublishExecutionPolicy()` in
`server/workspace/publishExecution.runtime.ts`.

| Deployment | Execution decision | Environment safety |
|---|---|---|
| `DEPLOYMENT_ENVIRONMENT=production` | Enabled by Production policy. `WORKSPACE_PUBLISH_EXECUTION_ENABLED` is ignored whether unset, `false`, or `true`. | Exact Production deployment literal + `DATABASE_URL` fingerprint must equal `PRODUCTION_DB_FINGERPRINT`. If a staging fingerprint is supplied it must differ. |
| Preview / legacy non-production | Preserves legacy `WORKSPACE_PUBLISH_EXECUTION_ENABLED=true` activation. | Existing `WORKSPACE_PUBLISH_ACCEPTANCE_TIER=preview` + exact `WORKSPACE_PUBLISH_PREVIEW_DATABASE_NAME` contract. |
| Other non-production with legacy flag disabled | Disabled. | No provider execution. |

Production never calls `requirePreviewPublishExecutionSafety()` and must never set
`WORKSPACE_PUBLISH_ACCEPTANCE_TIER=preview` merely to permit Production execution.

## Gates retained

Removing the Production execution flag does not remove the Controlled Publish safety model:

- every Workspace route remains an authenticated `adminProcedure`;
- services re-check the platform-admin role from the database;
- publish destination must be active;
- ownership epoch/version fences remain authoritative;
- the current source/last-published hash is re-validated at execution time;
- durable outbox/idempotency, claim lease, bounded retry and dead-letter behavior are unchanged;
- provider receipts are persisted before terminal success;
- `WORKSPACE_PUBLISH_EXTERNAL_PROVIDER_ENABLED=true` remains an independent explicit gate for external provider delivery;
- Production execution requires exact Production DB identity before enqueue/worker activation.

## Final gate semantics

Legacy Preview final-gate behavior still treats active Preview execution as a blocker.
Production policy reports `finalGateExecutionBlock=false`: Production being operationally
enabled is not interpreted as the old `PREVIEW_EXECUTION_ENABLED` migration blocker.

## Worker behavior

The unattended worker consumes the same centralized policy as HTTP request paths.

- Production: the legacy execution flag is ignored; external-provider configuration and
  Production DB safety still gate execution.
- Preview: the old execution flag and Preview DB safety continue to apply.
- `WORKSPACE_PUBLISH_UNATTENDED_ENABLED=false` remains a worker-specific emergency
  stop; it is not a replacement Production publish-activation flag.

The one-shot worker script uses the same request policy and no longer reads the legacy
execution flag directly.

## Production-staging boundary

M12D.12 changes the **Production** policy only. It does not make
`production-staging` impersonate Preview and does not authorize real provider side
effects there. Production-staging continues to use its existing isolated DB/release-gate
contract unless a separate staging publish policy is explicitly designed.

## Verification requirements

Before any Production deploy:

1. Production with the legacy flag absent must resolve execution enabled.
2. Production with the legacy flag exactly `false` must behave identically.
3. Production without Preview acceptance variables must pass policy resolution.
4. Wrong Production environment or DB fingerprint must fail closed.
5. External provider disabled must fail closed.
6. Preview legacy behavior must remain covered.
7. Existing ownership, stale-hash, idempotency, retry/dead-letter and receipt tests must pass.
8. TypeScript, production build and the full release gate must pass with zero new failures.

This milestone does not modify Production data and does not authorize a Production deploy.
