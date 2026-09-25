# M12D.13 — Simplify Controlled Publish Runtime Policy

## Decision

Controlled Publish no longer has a legacy execution switch, acceptance tier, or Preview database-name allowlist.

Real provider publish is activated only by deployment identity plus approved database identity:

| Deployment | Publish runtime | DB identity |
|---|---|---|
| `production` | Active | `DATABASE_URL` fingerprint must equal `PRODUCTION_DB_FINGERPRINT`. |
| `production-staging` | Active | `DATABASE_URL` fingerprint must equal `PRODUCTION_STAGING_DB_FINGERPRINT`, and that fingerprint must differ from `PRODUCTION_DB_FINGERPRINT`. |
| Preview/development/other | Inactive | No real-provider publish. No rollout flag can turn it on. |

The source of truth is `server/workspace/publishExecution.runtime.ts`.

## Runtime contract

`requireWorkspacePublishEnvironmentSafety()` accepts exactly two real-publish environments:

- `production`
- `production-staging`

The function derives the current database identity from `DATABASE_URL` using the existing credential-free identity hash helper. It fails closed when the configured fingerprint is missing, malformed, mismatched, or when Production and staging fingerprints collide.

`resolveWorkspacePublishExecutionPolicy()` has no rollout/acceptance configuration. Unsupported environments resolve inactive. `requireWorkspacePublishRequestPolicy()` additionally preserves the independent external-provider opt-in.

## Safety retained

M12D.13 removes configuration friction, not data-integrity controls. The following remain authoritative:

- authenticated platform-admin routes plus service-layer admin recheck;
- active publish destination;
- guarded initial publish ownership preparation and exact ownership epoch/version;
- current source and last-published hash validation;
- durable idempotent outbox and claim lease;
- bounded retry and dead-letter handling;
- reconcile-first external provider behavior;
- provider receipt persistence before terminal success;
- successful publication hash advancement;
- Production vs production-staging database isolation.

`WORKSPACE_PUBLISH_EXTERNAL_PROVIDER_ENABLED=true` remains the explicit opt-in for real provider delivery. It is not an environment selector and cannot bypass DB identity safety.

`WORKSPACE_PUBLISH_UNATTENDED_ENABLED=false` remains a worker-only emergency stop. It does not alter request authorization or DB identity.

## Final gate cleanup

The old Preview execution-state blocker was removed from the publish final-gate package. Final-gate readiness is now determined only by cutover readiness and transition history. Runtime activation belongs exclusively to the environment/DB identity policy.

## Operational result

For `production-staging`, Bulk Publish can now:

1. validate staging environment + staging DB fingerprint;
2. prepare initial publish ownership when required;
3. re-read current stage/ownership evidence;
4. enqueue Controlled Publish;
5. let the unattended worker execute through the same staging identity policy.

No Preview impersonation or acceptance configuration is involved.

## Removed configuration

The pre-M12D.13 rollout and Preview-acceptance variables are removed from runtime configuration and ENV inventory. They must not be reintroduced in Coolify, scripts, tests, or release instructions.

## Verification

Required before merge:

1. Production valid identity -> publish policy active.
2. Production wrong DB identity -> fail closed.
3. Production-staging valid identity -> publish policy active.
4. Production-staging missing/mismatched/colliding fingerprint -> fail closed.
5. Preview/development -> inactive without any feature flag.
6. External provider disabled -> fail closed for publish requests.
7. Ownership/hash/idempotency/retry/receipt contracts remain regression-covered.
8. TypeScript, build, full release gate, diff check, secret scan, and encoding scan pass.

M12D.13 itself does not authorize a Production deployment or Production database mutation.
