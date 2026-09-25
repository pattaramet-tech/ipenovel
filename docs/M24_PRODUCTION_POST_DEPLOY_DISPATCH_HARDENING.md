# M24 — Production Post-Deploy Dispatch Hardening

## Objective

Make every future successful `ipenovel-prod` deployment emit the existing GitHub
`repository_dispatch: production-deployed` event automatically, without exposing the
runtime credential or changing the currently deployed Production revision.

## Versioned transport

Coolify must invoke:

```text
node scripts/production-post-deploy-dispatch.mjs
```

The script is intentionally fail-closed. It requires all of the following runtime
conditions:

- `DEPLOYMENT_ENVIRONMENT=production`;
- `SOURCE_COMMIT` is a full 40-character Git SHA supplied by Coolify;
- `GITHUB_PRODUCTION_DISPATCH_TOKEN` is present in runtime ENV;
- the repository is exactly `pattaramet-tech/ipenovel`.

It sends only:

```json
{
  "event_type": "production-deployed",
  "client_payload": {
    "deployed_sha": "<SOURCE_COMMIT>",
    "environment": "production"
  }
}
```

to the fixed GitHub endpoint
`https://api.github.com/repos/pattaramet-tech/ipenovel/dispatches`.

The token is used only in the Authorization header. It is never printed, persisted,
or placed in the payload. HTTP 408/425/429 and 5xx responses, plus transient network
errors, receive a bounded retry. Authentication/authorization and other non-retryable
4xx failures fail immediately.

## Verification chain

A successful dispatch starts
`.github/workflows/production-deploy-verify.yml`, which independently verifies:

1. the dispatch environment is exactly `production`;
2. `production/promotion-authorization=success` exists on the deployed SHA;
3. `/healthz` and `/readyz` are stable for three consecutive probes;
4. `/readyz.revision` exactly matches the dispatched SHA;
5. Production root returns HTTP 200 HTML.

The workflow then records:

```text
production/deployment-verification = success|failure
```

## Coolify configuration

Resource: `IpeNovel / production / ipenovel-prod`

Set only the **Post-deployment** command:

```text
if [ -f scripts/production-post-deploy-dispatch.mjs ]; then node scripts/production-post-deploy-dispatch.mjs; else echo "[production-dispatch] skipped: M24 dispatcher is not present in this revision"; fi
```

The file-existence guard preserves rollback/redeploy compatibility with older images
that predate M24. Once a deployed revision contains the M24 script, the script itself
is fail-closed and any invalid Production environment, SHA, repository, credential,
or GitHub response fails the post-deploy command.

Do not place a token value in the command. The existing
`GITHUB_PRODUCTION_DISPATCH_TOKEN` remains a runtime-only environment variable.

Saving this command must not redeploy the currently healthy Production revision.
The hook becomes active on the next successful deployment whose source contains the
M24 script.

## Rollback

This milestone does not change database state or rollback images. Production code
rollback remains the previously documented Coolify image flow, and database recovery
continues to require the verified restorable Production DB backup.
